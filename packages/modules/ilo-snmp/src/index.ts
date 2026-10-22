import { z } from "zod";
import { defineModule, type AlertCondition } from "@lumina/sdk";
import { checkConnection, connectionFields, connectionShape, explainCrypto, explainNoAnswer, getSystem, isDenied, openSession, probeSettings, probeUdpPort, type ConnectionConfig } from "@lumina/module-snmp";

// HPE iLO and the HPE Agentless Management agent answer SNMP with Compaq/HPE "CPQ" tables (enterprise 232): server health, temperatures, fans,
// power supplies, processors, memory modules and Smart Array drives. The object numbers below come from HPE's published MIBs
// (CPQHLTH-MIB, CPQSTDEQ-MIB, CPQSINFO-MIB, CPQIDA-MIB, CPQSM2-MIB). This module reads them; it never changes anything.

type Obj = Record<string, any>;
const E = "1.3.6.1.4.1.232";
const OID = {
  sysName: "1.3.6.1.2.1.1.5.0",
  sysDescr: "1.3.6.1.2.1.1.1.0",
  overall: `${E}.6.1.3.0`,          // cpqHeMibCondition
  thermal: `${E}.6.2.6.1.0`,        // cpqHeThermalCondition
  power: `${E}.6.2.9.1.0`,          // cpqHeFltTolPwrSupplyCondition
  cpu: `${E}.1.2.2.4.0`,            // cpqSeCpuCondition
  memory: `${E}.6.2.14.4.0`,        // cpqHeResilientMemCondition
  meter: `${E}.6.2.15.3.0`,         // cpqHePowerMeterCurrReading (watts)
  product: `${E}.2.2.4.2.0`,        // cpqSiProductName
  serial: `${E}.2.2.2.1.0`,         // cpqSiSysSerialNum
  iloModel: `${E}.9.2.2.21.0`,      // cpqSm2CntlrModel
};
const TABLE = {
  temps: [`${E}.6.2.6.8`, [3, 4, 5, 6]],       // locale, celsius, threshold, condition
  fans: [`${E}.6.2.6.7`, [3, 4, 9, 12]],       // locale, present, condition, rpm
  supplies: [`${E}.6.2.9.3`, [2, 3, 4, 6, 7, 8]], // bay, present, condition, volts, watts used, watts max
  cpus: [`${E}.1.2.2.1`, [2, 3, 4, 6]],        // slot, name, speed MHz, status
  dimms: [`${E}.2.2.4.5`, [3, 12, 13, 11]],    // size KB, location, MHz, ECC status
  controllers: [`${E}.3.2.2.1`, [2, 5, 6]],    // model, slot, condition
  logical: [`${E}.3.2.3.1`, [3, 4, 9, 11]],    // fault tolerance, status, size MB, condition
  physical: [`${E}.3.2.5.1`, [3, 5, 6, 37, 45, 64, 69, 70, 71, 74]], // model, bay, status, condition, size MB, location, media, temp, temp limit, power-on hours
} as const;

export type Cond = "ok" | "degraded" | "failed" | "unknown";
export const cond = (v: unknown): Cond => (v === 2 ? "ok" : v === 3 ? "degraded" : v === 4 ? "failed" : "unknown");
const LOCALE: Record<number, string> = { 1: "Other", 2: "Unknown", 3: "System", 4: "System board", 5: "I/O board", 6: "CPU", 7: "Memory", 8: "Storage", 9: "Removable media", 10: "Power supply", 11: "Ambient", 12: "Chassis", 13: "Bridge card", 14: "Management board", 15: "Backplane", 16: "Network slot", 17: "Blade slot", 18: "Virtual" };
const DRIVE: Record<number, string> = { 1: "other", 2: "ok", 3: "failed", 4: "predictive failure", 5: "erasing", 6: "erase done", 7: "erase queued", 8: "SSD worn out", 9: "not authenticated" };
const LOGICAL: Record<number, string> = { 1: "other", 2: "ok", 3: "failed", 4: "unconfigured", 5: "recovering", 6: "ready for rebuild", 7: "rebuilding", 8: "wrong drive", 9: "bad connection", 10: "overheating", 11: "shut down", 12: "expanding", 13: "not available", 14: "queued for expansion", 15: "multipath degraded", 16: "erasing" };
const FAULT: Record<number, string> = { 2: "none", 3: "RAID 0", 4: "RAID 1+0", 5: "RAID 4", 6: "RAID 5", 7: "RAID 6", 8: "RAID ADG", 9: "RAID 1" };

const text = (v: unknown): string | null => (v === undefined || v === null ? null : Buffer.isBuffer(v) ? v.toString("utf8").replace(/\0+$/, "").trim() : String(v).trim()) || null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface Temp { name: string; celsius: number; limitC: number | null; cond: Cond }
export interface Fan { name: string; cond: Cond; rpm: number | null }
export interface Psu { name: string; cond: Cond; volts: number | null; usedW: number | null; maxW: number | null }
export interface Cpu { name: string; speedMHz: number | null; status: Cond | "disabled" }
export interface Dimm { slot: string; sizeGB: number; mhz: number | null; ok: boolean }
export interface Ctrl { model: string | null; slot: number | null; cond: Cond }
export interface Logical { id: string; level: string; status: string; sizeGB: number | null; cond: Cond; ok: boolean }
export interface Drive { id: string; location: string; model: string | null; sizeGB: number | null; status: string; statusOk: boolean; cond: Cond; media: string | null; tempC: number | null; limitC: number | null; hours: number | null }

// ---- reading the tables --------------------------------------------------------------------------------------------------

export function parseTemps(t: Obj): Temp[] {
  const seen = new Map<string, number>();
  return Object.keys(t).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).flatMap((k) => {
    const r = t[k] as Obj;
    const c = num(r[4]);
    if (c === null || c <= -90 || c > 250) return []; // -99 means "could not be read"
    const base = LOCALE[Number(r[3])] ?? "Sensor";
    const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
    return [{ name: `${base} ${n}`, celsius: c, limitC: num(r[5]) && (r[5] as number) > 0 ? (r[5] as number) : null, cond: cond(r[6]) }];
  });
}
export function parseFans(t: Obj): Fan[] {
  return Object.keys(t).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).flatMap((k, i) => {
    const r = t[k] as Obj;
    if (r[4] !== 3) return []; // only fans that are present
    return [{ name: `Fan ${i + 1}${LOCALE[Number(r[3])] ? ` (${LOCALE[Number(r[3])].toLowerCase()})` : ""}`, cond: cond(r[9]), rpm: num(r[12]) && (r[12] as number) > 0 ? (r[12] as number) : null }];
  });
}
export function parseSupplies(t: Obj): Psu[] {
  return Object.keys(t).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).flatMap((k) => {
    const r = t[k] as Obj;
    if (r[3] !== 3) return [];
    return [{ name: `Bay ${num(r[2]) ?? k}`, cond: cond(r[4]), volts: num(r[6]) && (r[6] as number) > 0 ? (r[6] as number) : null, usedW: num(r[7]), maxW: num(r[8]) && (r[8] as number) > 0 ? (r[8] as number) : null }];
  });
}
export function parseCpus(t: Obj): Cpu[] {
  return Object.keys(t).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((k) => {
    const r = t[k] as Obj;
    return { name: text(r[3]) ?? `Processor ${k}`, speedMHz: num(r[4]), status: r[6] === 5 ? "disabled" : cond(r[6]) };
  });
}
export function parseDimms(t: Obj): Dimm[] {
  return Object.keys(t).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).flatMap((k) => {
    const r = t[k] as Obj;
    const kb = num(r[3]);
    if (!kb || kb <= 0) return []; // 0 = no module in this slot
    return [{ slot: text(r[12]) ?? `Module ${k}`, sizeGB: Math.round((kb / 1048576) * 10) / 10, mhz: num(r[13]), ok: r[11] === 2 || r[11] === 1 }];
  });
}
export function parseControllers(t: Obj): Ctrl[] {
  return Object.keys(t).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((k) => ({ model: text((t[k] as Obj)[2]), slot: num((t[k] as Obj)[5]), cond: cond((t[k] as Obj)[6]) }));
}
export function parseLogical(t: Obj): Logical[] {
  return Object.keys(t).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((k) => {
    const r = t[k] as Obj;
    const s = Number(r[4]);
    return { id: k, level: FAULT[Number(r[3])] ?? "", status: LOGICAL[s] ?? `status ${s}`, sizeGB: num(r[9]) !== null ? Math.round(((r[9] as number) / 1024) * 10) / 10 : null, cond: cond(r[11]), ok: s === 2 };
  });
}
export function parseDrives(t: Obj): Drive[] {
  return Object.keys(t).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((k) => {
    const r = t[k] as Obj;
    const s = Number(r[6]);
    const size = num(r[45]);
    const temp = num(r[70]);
    return {
      id: k, location: text(r[64]) ?? `Bay ${num(r[5]) ?? k}`, model: text(r[3]), sizeGB: size !== null && size > 0 && size < 0xffffff00 ? Math.round(size / 1024) : null,
      status: DRIVE[s] ?? `status ${s}`, statusOk: s === 2, cond: cond(r[37]), media: r[69] === 3 ? "SSD" : r[69] === 2 ? "HDD" : null,
      tempC: temp !== null && temp > 0 && temp < 120 ? temp : null, limitC: num(r[71]) && (r[71] as number) > 0 && (r[71] as number) < 120 ? (r[71] as number) : null, hours: num(r[74]),
    };
  });
}

const ConfigSchema = z.object({ ...connectionShape }).superRefine((c, ctx) => checkConnection(c, ctx));
type Config = z.infer<typeof ConfigSchema>;

export default defineModule<Config>({
  id: "ilo-snmp",
  name: "HPE iLO (SNMP)",
  description: "Health, temperatures, fans, power supplies, processors, memory and Smart Array drives of an HPE ProLiant server, read over SNMP from its iLO. Works on servers without the Redfish interface (older generations) and is lighter on the iLO. Read-only.",
  fields: [
    ...connectionFields.map((f) => (f.key === "host" ? { ...f, label: "iLO address", placeholder: "192.168.1.50" } : f)),
  ],
  configSchema: ConfigSchema,
  pollIntervalMs: 60_000,
  minPollIntervalMs: 15_000,
  multiInstance: true,

  async create(config) {
    const dev = openSession(config as ConnectionConfig, 6000, 1);
    let healthy = false;
    const OIDS = [OID.overall, OID.thermal, OID.power, OID.cpu, OID.memory, OID.meter, OID.product, OID.serial, OID.iloModel, OID.sysName, OID.sysDescr];

    return {
      async poll() {
        const warnings: string[] = [];
        let first: (Obj | undefined)[];
        try {
          first = await getSystem(dev.get, OIDS);
        } catch (e) {
          healthy = false;
          const m = e instanceof Error ? e.message : String(e);
          if (/timeout|timed out/i.test(m)) {
            const kind = await probeUdpPort(config.host, config.port);
            const base = explainNoAnswer(kind, config.host, config.port, config.version);
            throw new Error(kind === "closed"
              ? `${base} If the path is clear, on the iLO check Security, Access Settings, "SNMP Access" is Enabled (port ${config.port}), and under Management, SNMP Settings a read community (or an SNMPv3 user) is set and Agentless Management is on.`
              : `${base} On an HPE iLO the community is set under Management, SNMP Settings, and the iLO only answers addresses allowed there.`);
          }
          throw new Error(explainCrypto(m));
        }
        const v = (i: number) => dev.val(first[i]);
        const overall = cond(v(0));
        if (v(0) === undefined && v(1) === undefined && v(2) === undefined && v(6) === undefined) {
          healthy = false;
          throw new Error("The device answers SNMP but has none of HPE's server health data. Is this the iLO of an HPE ProLiant? On Gen8 and Gen9 the iLO's SNMP settings must have Agentless Management switched on.");
        }

        const section = async <T>(name: string, key: keyof typeof TABLE, parse: (t: Obj) => T[]): Promise<T[]> => {
          try {
            const [oid, cols] = TABLE[key];
            return parse(await dev.table(oid, [...cols]));
          } catch (e) {
            warnings.push(`${name}: ${isDenied(e) ? "the device refused to show this part to this SNMP user" : e instanceof Error ? e.message : String(e)}`);
            return [];
          }
        };
        const temps = await section("temperatures", "temps", parseTemps);
        const fans = await section("fans", "fans", parseFans);
        const supplies = await section("power supplies", "supplies", parseSupplies);
        const cpus = await section("processors", "cpus", parseCpus);
        const dimms = await section("memory modules", "dimms", parseDimms);
        const controllers = await section("storage controllers", "controllers", parseControllers);
        const logical = await section("logical drives", "logical", parseLogical);
        const drives = await section("physical drives", "physical", parseDrives);
        healthy = true;

        const meter = num(v(5));
        const psuW = supplies.reduce((a, p) => a + (p.usedW ?? 0), 0);
        return {
          snmpVersion: config.version,
          product: text(v(6)),
          serial: text(v(7)),
          ilo: { model: text(v(8)), name: text(v(9)), description: text(v(10))?.split("\n")[0].slice(0, 160) ?? null },
          overall,
          components: [["Thermal", cond(v(1))], ["Power supplies", cond(v(2))], ["Processors", cond(v(3))], ["Memory", cond(v(4))]].map(([name, c]) => ({ name, cond: c })),
          powerW: meter !== null && meter > 0 ? meter : psuW > 0 ? psuW : null,
          temps, fans, supplies, cpus, dimms, controllers, logical, drives,
          warnings,
        };
      },
      async status() {
        return healthy ? "connected" : "disconnected";
      },
      alerts(d: Obj) {
        const out: AlertCondition[] = [];
        const bad = (c: string) => c === "degraded" || c === "failed";
        const sev = (c: string) => (c === "failed" ? "critical" : "warning") as "critical" | "warning";
        const parts = ((d.components ?? []) as { name: string; cond: string }[]).filter((x) => bad(x.cond)).map((x) => `${x.name}: ${x.cond}`);
        if (bad(d.overall)) out.push({ key: "server-health", severity: sev(d.overall), title: `Server health is ${d.overall}`, detail: parts.length ? `Reported by iLO: ${parts.join(", ")}` : d.product ?? undefined });
        for (const t of (d.temps ?? []) as Temp[]) {
          if (bad(t.cond) || (t.limitC && t.celsius >= t.limitC)) out.push({ key: `temp:${t.name}`, severity: t.cond === "failed" || (t.limitC && t.celsius >= t.limitC) ? "critical" : "warning", title: `${t.name} is too hot`, detail: `${t.celsius}°C${t.limitC ? ` (limit ${t.limitC}°C)` : ""}` });
          else if (t.limitC && t.celsius >= t.limitC * 0.9) out.push({ key: `temp:${t.name}`, severity: "warning", title: `${t.name} is running hot`, detail: `${t.celsius}°C (limit ${t.limitC}°C)` });
        }
        for (const f of (d.fans ?? []) as Fan[]) if (bad(f.cond)) out.push({ key: `fan:${f.name}`, severity: sev(f.cond), title: `${f.name} has a problem`, detail: f.cond });
        for (const p of (d.supplies ?? []) as Psu[]) if (bad(p.cond)) out.push({ key: `psu:${p.name}`, severity: sev(p.cond), title: `Power supply ${p.name} has a problem`, detail: p.cond });
        for (const c of (d.cpus ?? []) as Cpu[]) if (c.status === "degraded" || c.status === "failed") out.push({ key: `cpu:${c.name}`, severity: sev(c.status), title: `Processor problem: ${c.name}`, detail: c.status });
        for (const m of (d.dimms ?? []) as Dimm[]) if (!m.ok) out.push({ key: `dimm:${m.slot}`, severity: "warning", title: `Memory module ${m.slot} has too many corrected errors`, detail: `${m.sizeGB} GB` });
        for (const c of (d.controllers ?? []) as Ctrl[]) if (bad(c.cond)) out.push({ key: `controller:${c.slot ?? c.model}`, severity: sev(c.cond), title: `Storage controller ${c.model ?? ""} has a problem`, detail: c.cond });
        for (const l of (d.logical ?? []) as Logical[]) if (!l.ok) out.push({ key: `logical:${l.id}`, severity: l.status === "failed" ? "critical" : "warning", title: `Logical drive ${l.id} (${l.level}) is ${l.status}`, detail: l.sizeGB ? `${l.sizeGB} GB` : undefined });
        for (const x of (d.drives ?? []) as Drive[]) {
          if (!x.statusOk) out.push({ key: `drive:${x.id}`, severity: x.status === "failed" || x.status === "predictive failure" ? "critical" : "warning", title: `Drive ${x.location} (${x.model ?? "unknown"}) is ${x.status}` });
          else if (x.tempC !== null && ((x.limitC && x.tempC >= x.limitC) || x.tempC >= 55)) out.push({ key: `drive-temp:${x.id}`, severity: "warning", title: `Drive ${x.location} is hot`, detail: `${x.tempC}°C` });
        }
        for (const w of (d.warnings ?? []) as string[]) {
          const i = w.indexOf(":");
          out.push({ key: `read-failed:${w.slice(0, i)}`, severity: "info", title: `Could not read ${w.slice(0, i)} from the iLO`, detail: w.slice(i + 1).trim().slice(0, 300) });
        }
        return out;
      },
      metrics(d: Obj) {
        const m: Record<string, number> = {};
        if (typeof d.powerW === "number") m.power = d.powerW;
        const temps = (d.temps ?? []) as Temp[];
        if (temps.length) m["temp:max"] = Math.max(...temps.map((t) => t.celsius));
        const inlet = temps.find((t) => /^Ambient/.test(t.name));
        if (inlet) m["temp:inlet"] = inlet.celsius;
        const rpm = ((d.fans ?? []) as Fan[]).map((f) => f.rpm).filter((x): x is number => x !== null);
        if (rpm.length) m["fan:rpm"] = Math.round(rpm.reduce((a, b) => a + b, 0) / rpm.length);
        const dt = ((d.drives ?? []) as Drive[]).map((x) => x.tempC).filter((x): x is number => x !== null);
        if (dt.length) m["drive-temp:max"] = Math.max(...dt);
        return m;
      },
      actions: [{ id: "probe", label: "Test the SNMP settings", minRole: "admin" as const, async run() { return probeSettings(config as never); } }],
      async dispose() {
        dev.close();
      },
    };
  },
});
