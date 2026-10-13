import { z } from "zod";
import { basicAuth, defineModule, httpJson, httpRequestRaw, type AlertCondition } from "@lumina/sdk";

const ConfigSchema = z.object({
  host: z.string().url(),
  username: z.string().min(1),
  password: z.string().min(1),
  verifyTls: z.boolean().default(false),
  fingerprint: z.string().optional(),
});
type Config = z.infer<typeof ConfigSchema>;

// iLO 4 speaks an early Redfish dialect (HP "Oem.Hp" extensions, `links` instead of `Links`), so responses are loosely typed.
type Obj = Record<string, any>;
const hp = (o: Obj | undefined): Obj => o?.Oem?.Hp ?? {};
const href = (m: Obj): string => m?.links?.self?.href ?? m?.["@odata.id"] ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Uses the iLO Redfish API (iLO 4 firmware 2.30+). Read-only: iLO 4 has no supported fan-control API.
export default defineModule<Config>({
  id: "ilo4",
  name: "HP iLO 4",
  description: "Power, thermals, storage, memory, network, firmware and logs via the iLO Redfish API (iLO 4 firmware 2.30+).",
  fields: [
    { key: "host", label: "iLO URL", type: "text", required: true, placeholder: "https://192.168.11.x" },
    { key: "username", label: "Username", type: "text", required: true },
    { key: "password", label: "Password", type: "password", required: true },
    { key: "verifyTls", label: "Verify TLS certificate", type: "boolean", default: false },
    { key: "fingerprint", label: "Certificate fingerprint (optional)", type: "text", help: "SHA-256 fingerprint. When set, Lumina only talks to a device presenting exactly this certificate, even if it is self-signed. Use Detect to read it from the device." },
  ],
  configSchema: ConfigSchema,
  pollIntervalMs: 15_000,
  minPollIntervalMs: 10_000,
  multiInstance: true,

  async create(config, ctx) {
    let healthy = false;
    let disposed = false;
    const base = config.host.replace(/\/+$/, "");

    // iLO 4's web server drops connections when requests overlap, so every request goes through one queue.
    let chain: Promise<unknown> = Promise.resolve();
    function get<T = Obj>(path: string): Promise<T> {
      const run = chain.then(async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await httpJson<T>(`${base}${path}`, {
              headers: { authorization: basicAuth(config.username, config.password) },
              verifyTls: config.verifyTls,
              fingerprint: config.fingerprint,
              timeoutMs: 15_000,
            });
          } catch (err) {
            if (attempt >= 2 || !/hang up|ECONNRESET/i.test(msg(err))) throw err;
            await sleep(700);
          }
        }
      });
      chain = run.catch(() => undefined);
      return run;
    }

    // Commands are never retried: a dropped connection must not turn one restart into two.
    function send(method: string, path: string, body: unknown): Promise<void> {
      const run = chain.then(async () => {
        const res = await httpRequestRaw(`${base}${path}`, {
          method,
          body,
          headers: { authorization: basicAuth(config.username, config.password) },
          verifyTls: config.verifyTls,
          fingerprint: config.fingerprint,
          timeoutMs: 20_000,
        });
        if (res.status >= 400) {
          let reason = `${res.status} ${res.statusText}`.trim();
          try {
            const info = JSON.parse(res.body)?.error?.["@Message.ExtendedInfo"]?.[0];
            if (info?.MessageID) reason = String(info.MessageID).split(".").pop() ?? reason;
          } catch { /* keep the HTTP status */ }
          throw new Error(`iLO refused the command: ${reason}`);
        }
      });
      chain = run.catch(() => undefined);
      return run;
    }

    let lastPowerState: string | null = null;
    const RESET = "/redfish/v1/Systems/1/Actions/ComputerSystem.Reset/";
    const powerAction = (id: string, label: string, resetType: string, needs: "On" | "Off", dangerous: boolean, opts: { schedulable?: boolean; downtimeMinutes?: number } = {}) => ({
      id,
      label,
      dangerous,
      schedulable: opts.schedulable ?? false,
      plannedDowntimeMinutes: opts.downtimeMinutes,
      async run() {
        if (lastPowerState && lastPowerState !== needs) {
          throw new Error(`Server is ${lastPowerState.toLowerCase()}, so "${label}" does not apply`);
        }
        ctx.log.warn(`iLO power command: ${resetType}`);
        await send("POST", RESET, { ResetType: resetType });
        return { sent: resetType };
      },
    });

    const members = async (path: string): Promise<Obj[]> => ((await get(path)).Members ?? []) as Obj[];
    const each = async (path: string, limit = 50): Promise<Obj[]> => {
      const out: Obj[] = [];
      for (const m of (await members(path)).slice(0, limit)) out.push(await get(href(m)));
      return out;
    };
    const lastEntries = async (path: string, n = 12) => {
      const list = await members(path);
      const out: Obj[] = [];
      for (const m of list.slice(-n)) out.push(await get(href(m)));
      return out
        .map((e) => ({ id: e.Id, time: e.Created ?? null, severity: e.Severity ?? "OK", message: String(e.Message ?? "") }))
        .reverse();
    };

    // Slow-changing data is loaded in the background (one section at a time) and cached, so the 15s poll stays quick.
    const store: Record<string, unknown> = {};
    const loadedAt: Record<string, number> = {};
    const problems: Record<string, string> = {};
    const sections: { key: string; ttl: number; load: () => Promise<unknown> }[] = [
      {
        key: "manager",
        ttl: 600_000,
        load: async () => {
          const m = await get("/redfish/v1/Managers/1/");
          const nic = (await each("/redfish/v1/Managers/1/EthernetInterfaces/", 1))[0] ?? {};
          return {
            firmware: m.FirmwareVersion ?? null,
            license: hp(m).License?.LicenseString ?? null,
            licenseType: hp(m).License?.LicenseType ?? null,
            health: m.Status?.Health ?? m.Status?.State ?? null,
            selfTests: ((hp(m).iLOSelfTestResults ?? []) as Obj[]).map((t) => ({
              name: String(t.SelfTestName ?? ""),
              status: String(t.Status ?? ""),
              notes: t.Notes ? String(t.Notes) : null,
            })),
            hostName: nic.HostName ?? null,
            ip: nic.IPv4Addresses?.[0]?.Address ?? null,
            ipOrigin: nic.IPv4Addresses?.[0]?.AddressOrigin ?? null,
            mac: nic.MacAddress ?? null,
            speedMbps: num(nic.SpeedMbps),
          };
        },
      },
      {
        key: "storage",
        ttl: 120_000,
        load: async () => {
          const root = await get("/redfish/v1/Systems/1/SmartStorage/");
          const controllers: Obj[] = [];
          const drives: Obj[] = [];
          for (const c of await each("/redfish/v1/Systems/1/SmartStorage/ArrayControllers/", 4)) {
            controllers.push({
              model: c.Model ?? null,
              location: c.Location ?? null,
              firmware: c.FirmwareVersion?.Current?.VersionString ?? null,
              health: c.Status?.Health ?? null,
              serial: c.SerialNumber ?? null,
              cacheMiB: num(c.CacheMemorySizeMiB),
            });
            const link = c.links?.PhysicalDrives?.href;
            if (!link) continue;
            for (const d of await each(link, 32)) {
              drives.push({
                location: d.Location ?? null,
                model: d.Model ?? null,
                serial: d.SerialNumber ?? null,
                media: d.MediaType ?? null,
                protocol: d.InterfaceType ?? null,
                capacityGB: num(d.CapacityGB),
                health: d.Status?.Health ?? null,
                tempC: ((t) => (t !== null && t > 0 && t < 120 ? t : null))(num(d.CurrentTemperatureCelsius)),
                rpm: num(d.RotationalSpeedRpm),
                firmware: d.FirmwareVersion?.Current?.VersionString ?? null,
                powerOnHours: num(d.PowerOnHours),
                ssdWearPct: num(d.SSDEnduranceUtilizationPercentage),
                reasons: ((d.DiskDriveStatusReasons ?? []) as string[]).filter((r) => r !== "None"),
              });
            }
          }
          return { health: root.Status?.Health ?? null, controllers, drives };
        },
      },
      {
        key: "network",
        ttl: 60_000,
        load: async () =>
          (await each("/redfish/v1/Systems/1/NetworkAdapters/", 8)).map((a) => ({
            name: a.Name ?? "Network adapter",
            firmware: a.Firmware?.Current?.VersionString ?? null,
            ports: ((a.PhysicalPorts ?? []) as Obj[]).map((p) => ({
              name: hp(p).StructuredName ?? p.Name ?? "port",
              mac: p.MacAddress ?? null,
              speedMbps: num(p.SpeedMbps),
              fullDuplex: p.FullDuplex ?? null,
              health: p.Status?.Health ?? null,
              state: p.Status?.State ?? null,
              ips: ((p.IPv4Addresses ?? []) as Obj[]).map((x) => x.Address).filter((x) => x && x !== "0.0.0.0"),
              team: hp(p).Team || null,
              goodRx: num(hp(p).GoodReceives),
              badRx: num(hp(p).BadReceives),
              goodTx: num(hp(p).GoodTransmits),
              badTx: num(hp(p).BadTransmits),
            })),
          })),
      },
      {
        key: "processors",
        ttl: 1_800_000,
        load: async () =>
          (await each("/redfish/v1/Systems/1/Processors/", 8)).map((p) => ({
            socket: p.Socket ?? p.Id ?? null,
            model: p.Model ?? null,
            cores: num(p.TotalCores),
            threads: num(p.TotalThreads),
            maxMHz: num(p.MaxSpeedMHz),
            health: p.Status?.Health ?? null,
          })),
      },
      {
        key: "dimms",
        ttl: 1_800_000,
        load: async () =>
          (await each("/redfish/v1/Systems/1/Memory/", 32)).map((d) => ({
            slot: d.SocketLocator ?? d.Name ?? d.Id,
            sizeGB: d.SizeMB ? d.SizeMB / 1024 : null,
            type: d.DIMMType ?? null,
            technology: d.DIMMTechnology ?? null,
            mhz: num(d.MaximumFrequencyMHz),
            rank: num(d.Rank),
            ecc: d.ErrorCorrection ?? null,
            status: d.DIMMStatus ?? null,
          })),
      },
      { key: "iml", ttl: 120_000, load: () => lastEntries("/redfish/v1/Systems/1/LogServices/IML/Entries/") },
      { key: "iel", ttl: 120_000, load: () => lastEntries("/redfish/v1/Managers/1/LogServices/IEL/Entries/") },
      {
        key: "firmware",
        ttl: 1_800_000,
        load: async () => {
          const fw = (hp(await get("/redfish/v1/Chassis/1/")).Firmware ?? {}) as Obj;
          return Object.entries(fw)
            .map(([k, v]) => ({
              name: k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2"),
              version: String((v as Obj)?.Current?.VersionString ?? ""),
            }))
            .filter((f) => f.version);
        },
      },
    ];

    let refreshing = false;
    async function refreshSlow() {
      if (refreshing) return;
      refreshing = true;
      try {
        for (const s of sections) {
          if (disposed) return;
          if (Date.now() - (loadedAt[s.key] ?? 0) < s.ttl) continue;
          try {
            store[s.key] = await s.load();
            loadedAt[s.key] = Date.now();
            delete problems[s.key];
          } catch (err) {
            problems[s.key] = msg(err);
            loadedAt[s.key] = Date.now() - s.ttl + 30_000;
            ctx.log.warn(`iLO section "${s.key}" failed`, err);
          }
        }
      } finally {
        refreshing = false;
      }
    }

    return {
      async poll() {
        try {
          const power = await get("/redfish/v1/Chassis/1/Power/");
          const thermal = await get("/redfish/v1/Chassis/1/Thermal/");
          const system = await get("/redfish/v1/Systems/1/");
          healthy = true;
          lastPowerState = system.PowerState ?? null;
          void refreshSlow();

          const pc = (power.PowerControl ?? [])[0] ?? {};
          const sys = hp(system);
          const processors = (store.processors ?? null) as Obj[] | null;
          const dimms = (store.dimms ?? null) as Obj[] | null;
          return {
            model: system.Model ?? null,
            serial: system.SerialNumber ?? null,
            sku: system.SKU ?? null,
            hostName: system.HostName ?? null,
            powerState: system.PowerState ?? null,
            health: system.Status?.HealthRollup ?? system.Status?.Health ?? null,
            indicatorLed: system.IndicatorLED ?? null,
            postState: sys.PostState ?? null,
            bios: system.BiosVersion ?? null,
            provisioning: sys.IntelligentProvisioningVersion ?? null,
            powerRegulator: sys.PowerRegulatorMode ?? null,
            hostOs: sys.HostOS?.OsName ? { name: sys.HostOS.OsName as string, description: (sys.HostOS.OsSysDescription as string) ?? null } : null,
            tpm: sys.TrustedModules?.[0]?.Status ?? null,
            smartBattery: ((sys.Battery ?? []) as Obj[]).map((b) => ({
              model: b.ProductName?.trim() ?? b.Model ?? "Battery",
              health: b.Condition ?? null,
              maxCapW: num(b.MaxCapWatts),
              firmware: b.FirmwareVersion ?? null,
            })),
            cpu: {
              count: num(system.ProcessorSummary?.Count),
              model: system.ProcessorSummary?.Model ?? null,
              health: system.ProcessorSummary?.Status?.HealthRollUp ?? null,
              processors,
            },
            memory: {
              totalGiB: num(system.MemorySummary?.TotalSystemMemoryGiB),
              health: system.MemorySummary?.Status?.HealthRollUp ?? null,
              dimms,
            },
            power: {
              nowW: pc.PowerConsumedWatts ?? null,
              avgW: pc.PowerMetrics?.AverageConsumedWatts ?? null,
              minW: pc.PowerMetrics?.MinConsumedWatts ?? null,
              maxW: pc.PowerMetrics?.MaxConsumedWatts ?? null,
              capacityW: pc.PowerCapacityWatts ?? null,
            },
            supplies: ((power.PowerSupplies ?? []) as Obj[]).map((s) => ({
              name: hp(s).BayNumber ? `Bay ${hp(s).BayNumber}` : (s.Name ?? "PSU"),
              model: s.Model ?? null,
              serial: s.SerialNumber ?? null,
              firmware: s.FirmwareVersion ?? null,
              inputV: num(s.LineInputVoltage),
              outputW: num(s.LastPowerOutputWatts),
              maxW: num(hp(s).MaxPowerOutputWatts),
              capacityW: num(s.PowerCapacityWatts),
              health: s.Status?.Health ?? null,
              state: s.Status?.State ?? null,
            })),
            temperatures: ((thermal.Temperatures ?? []) as Obj[])
              .filter((t) => typeof t.ReadingCelsius === "number")
              .map((t) => ({
                name: t.Name ?? "sensor",
                celsius: t.ReadingCelsius as number,
                criticalC: t.UpperThresholdCritical || null,
                context: t.PhysicalContext ?? null,
                health: t.Status?.Health ?? null,
              })),
            fans: ((thermal.Fans ?? []) as Obj[])
              .filter((f) => f.Status?.State !== "Absent")
              .map((f) => ({
                name: f.FanName ?? f.Name ?? "fan",
                reading: f.CurrentReading ?? f.Reading ?? null,
                units: f.Units ?? f.ReadingUnits ?? "Percent",
                health: f.Status?.Health ?? null,
              })),
            ilo: store.manager ?? null,
            storage: store.storage ?? null,
            network: store.network ?? null,
            firmware: store.firmware ?? null,
            logs: { iml: store.iml ?? null, iel: store.iel ?? null },
            warnings: Object.entries(problems).map(([k, v]) => `${k}: ${v}`),
          };
        } catch (err) {
          healthy = false;
          throw err;
        }
      },
      async status() {
        return healthy ? "connected" : "disconnected";
      },
      alerts(d: Obj) {
        const out: AlertCondition[] = [];
        const bad = (h: string | null | undefined) => !!h && h !== "OK" && h !== "Ok";
        if (bad(d.health)) out.push({ key: "server-health", severity: "critical", title: `Server health is ${d.health}`, detail: d.model ?? undefined });
        if (d.powerState && d.powerState !== "On") out.push({ key: "power-off", severity: "warning", title: "Server is powered off", detail: `Power state: ${d.powerState}` });
        if (bad(d.cpu?.health)) out.push({ key: "cpu-health", severity: "critical", title: "Processor health problem", detail: d.cpu.health });
        if (bad(d.memory?.health)) out.push({ key: "memory-health", severity: "critical", title: "Memory health problem", detail: d.memory.health });
        for (const b of d.smartBattery ?? []) if (bad(b.health)) out.push({ key: "smart-battery", severity: "warning", title: "Smart Storage battery problem", detail: b.health });
        for (const t of d.temperatures ?? []) {
          if (!t.criticalC) continue;
          if (t.celsius >= t.criticalC) out.push({ key: `temp:${t.name}`, severity: "critical", title: `${t.name} is at critical temperature`, detail: `${t.celsius}°C (limit ${t.criticalC}°C)` });
          else if (t.celsius >= t.criticalC * 0.9) out.push({ key: `temp:${t.name}`, severity: "warning", title: `${t.name} is running hot`, detail: `${t.celsius}°C (limit ${t.criticalC}°C)` });
        }
        const pctFans = ((d.fans ?? []) as { reading: number | null; units: string }[]).filter((f) => f.units === "Percent" && typeof f.reading === "number");
        if (pctFans.length && pctFans.reduce((a, f) => a + (f.reading as number), 0) / pctFans.length >= 80) {
          out.push({ key: "fans-high", severity: "warning", title: "Fans are running hard", detail: "Average fan speed is 80% or more: check airflow, dust and room temperature" });
        }
        for (const f of d.fans ?? []) if (bad(f.health)) out.push({ key: `fan:${f.name}`, severity: "critical", title: `${f.name} has a problem`, detail: f.health });
        for (const p of d.supplies ?? []) if (bad(p.health)) out.push({ key: `psu:${p.name}`, severity: "critical", title: `Power supply ${p.name} has a problem`, detail: p.health });
        for (const c of d.storage?.controllers ?? []) if (bad(c.health)) out.push({ key: `controller:${c.location}`, severity: "critical", title: `Storage controller ${c.model ?? ""} has a problem`, detail: c.health });
        for (const x of d.storage?.drives ?? []) {
          const id = x.serial ?? x.location;
          if (bad(x.health)) out.push({ key: `drive:${id}`, severity: "critical", title: `Drive ${x.location ?? ""} (${x.model ?? "unknown"}) is ${x.health}`, detail: (x.reasons ?? []).join(", ") || undefined });
          else if (x.tempC !== null && x.tempC >= 55) out.push({ key: `drive-temp:${id}`, severity: "warning", title: `Drive ${x.location ?? ""} is hot`, detail: `${x.tempC}°C` });
        }
        for (const m of d.memory?.dimms ?? []) {
          if (m.status && !/^(GoodInUse|GoodPartiallyInUse|Absent|NotPresent|PresentSpare)$/.test(m.status)) out.push({ key: `dimm:${m.slot}`, severity: "critical", title: `Memory module ${m.slot} problem`, detail: m.status });
        }
        for (const t of d.ilo?.selfTests ?? []) {
          if (t.status !== "OK" && t.status !== "Informational") out.push({ key: `ilo-selftest:${t.name}`, severity: "warning", title: `iLO self-test failed: ${t.name}`, detail: t.notes ?? t.status });
        }
        const recent = Date.now() - 3 * 86400_000;
        for (const e of d.logs?.iml ?? []) {
          if ((e.severity === "Critical" || e.severity === "Warning") && e.time && Date.parse(e.time) > recent) {
            out.push({ key: `iml:${e.id}`, severity: e.severity === "Critical" ? "critical" : "warning", title: "Hardware log entry", detail: e.message.slice(0, 200) });
          }
        }
        const unknown: string[] = [];
        if (!d.storage) unknown.push("drive:", "drive-temp:", "controller:");
        if (!d.memory?.dimms) unknown.push("dimm:");
        if (!d.logs?.iml) unknown.push("iml:");
        if (!d.ilo) unknown.push("ilo-selftest:");
        return { conditions: out, unknown };
      },
      metrics(d: Obj) {
        const m: Record<string, number> = {};
        if (typeof d.power?.nowW === "number") m["power"] = d.power.nowW;
        const temps = (d.temperatures ?? []) as { name: string; celsius: number }[];
        if (temps.length) m["temp:max"] = Math.max(...temps.map((t) => t.celsius));
        const inlet = temps.find((t) => /inlet/i.test(t.name));
        if (inlet) m["temp:inlet"] = inlet.celsius;
        const fans = ((d.fans ?? []) as { reading: number | null; units: string }[]).filter((f) => f.units === "Percent" && typeof f.reading === "number");
        if (fans.length) {
          m["fan:avg"] = fans.reduce((a, f) => a + (f.reading as number), 0) / fans.length;
          m["fan:max"] = Math.max(...fans.map((f) => f.reading as number));
        }
        const dt = ((d.storage?.drives ?? []) as { tempC: number | null }[]).map((x) => x.tempC).filter((x): x is number => typeof x === "number");
        if (dt.length) m["drive-temp:max"] = Math.max(...dt);
        return m;
      },
      actions: [
        powerAction("power-on", "Power on", "On", "Off", false, { schedulable: true }),
        powerAction("shutdown", "Shut down (graceful)", "PushPowerButton", "On", true, { schedulable: true, downtimeMinutes: 30 }),
        powerAction("restart", "Restart (hard reset)", "ForceRestart", "On", true, { downtimeMinutes: 30 }),
        powerAction("force-off", "Force off", "ForceOff", "On", true, { downtimeMinutes: 30 }),
      ],
      async dispose() {
        disposed = true;
      },
    };
  },
});
