import { z } from "zod";
import { defineModule, httpJson, type AlertCondition } from "@lumina/sdk";

const ConfigSchema = z.object({
  url: z.string().url(),
  token: z.string().trim().max(200).optional(),
  label: z.string().trim().max(40).optional(),
  verifyTls: z.boolean().default(false),
  fingerprint: z.string().optional(),
});
type Config = z.infer<typeof ConfigSchema>;
type Obj = Record<string, any>;

export interface RemoteDevice { name: string; moduleId: string; status: string; line: string; level: "ok" | "warn" | "bad" | "unknown" }
export interface RemoteAlert { instanceId: string; key: string; severity: "critical" | "warning" | "info"; title: string; detail: string | null; since: number }

/** One line about a device on the other Lumina, in the same words that Lumina's own cards use. */
export function describe(i: Obj): string {
  if (i.enabled === false) return "Paused";
  const d = i.data && typeof i.data === "object" ? (i.data as Obj) : null;
  if (!d) return i.error ? `Unreachable (${i.error})` : "Waiting for data";
  switch (i.moduleId) {
    case "proxmox": {
      const g = ((d.guests ?? []) as Obj[]).filter((x) => !x.template);
      const n = (d.nodes ?? []) as Obj[];
      const cpu = n.length ? Math.round((n.reduce((a, x) => a + (x.cpu ?? 0), 0) / n.length) * 100) : null;
      const maxmem = n.reduce((a, x) => a + (x.maxmem ?? 0), 0);
      const mem = maxmem ? Math.round((n.reduce((a, x) => a + (x.mem ?? 0), 0) / maxmem) * 100) : null;
      return `${g.filter((x) => x.status === "running").length}/${g.length} guests running${cpu !== null ? ` · CPU ${cpu}%` : ""}${mem !== null ? ` · RAM ${mem}%` : ""}`;
    }
    case "apcupsd":
      return `${d.onBattery ? "ON BATTERY" : d.status === "ONLINE" ? "Online" : d.status}${d.batteryPct != null ? ` · ${Math.round(d.batteryPct)}%` : ""}${d.runtimeMin != null ? ` · ${Math.round(d.runtimeMin)} min` : ""}${d.loadPct != null ? ` · load ${Math.round(d.loadPct)}%` : ""}`;
    case "ilo4": {
      const inlet = ((d.temperatures ?? []) as Obj[]).find((t) => /inlet/i.test(String(t.name)));
      return `${d.powerState ?? "?"}${d.power?.nowW != null ? ` · ${d.power.nowW} W` : ""} · health ${d.health ?? "?"}${inlet ? ` · inlet ${inlet.celsius}°C` : ""}`;
    }
    case "uptime-kuma":
      return `${d.summary?.up ?? 0} up · ${d.summary?.down ?? 0} down${d.summary?.pending ? ` · ${d.summary.pending} pending` : ""}`;
    case "cloudflare": {
      const t = (d.tunnels ?? []) as Obj[];
      return `${t.filter((x) => x.status === "healthy").length}/${t.length} tunnels healthy`;
    }
    default:
      return String(i.status ?? "");
  }
}

const levelOf = (i: Obj): RemoteDevice["level"] => {
  if (i.enabled === false) return "unknown";
  if (i.status === "disconnected") return "bad";
  if (i.status === "degraded") return "warn";
  return i.status === "connected" ? "ok" : "unknown";
};

/** Turns the other Lumina's answers into what this card shows. Devices that are themselves remote Luminas are left out so two servers watching each other cannot echo alerts back and forth. */
export function digest(instances: Obj[], alerts: Obj): { devices: RemoteDevice[]; alerts: RemoteAlert[] } {
  const own = instances.filter((i) => i.moduleId !== "lumina");
  const skip = new Set(instances.filter((i) => i.moduleId === "lumina").map((i) => String(i.instanceId)));
  const devices = own.map((i) => ({ name: String(i.instanceId), moduleId: String(i.moduleId), status: String(i.status), line: describe(i), level: levelOf(i) }));
  const list = ((alerts?.active ?? []) as Obj[])
    .filter((a) => !a.suppressed && !skip.has(String(a.instanceId)))
    .map((a) => ({ instanceId: String(a.instanceId), key: String(a.key), severity: (a.severity === "critical" ? "critical" : a.severity === "info" ? "info" : "warning") as RemoteAlert["severity"], title: String(a.title ?? ""), detail: a.detail ? String(a.detail) : null, since: Number(a.since) || 0 }));
  return { devices, alerts: list };
}

export default defineModule<Config>({
  id: "lumina",
  name: "Another Lumina",
  description: "Shows the devices and alerts of a Lumina running somewhere else (an office, a second site), read-only.",
  fields: [
    { key: "url", label: "Address of the other Lumina", type: "text", required: true, placeholder: "https://192.168.0.171" },
    { key: "label", label: "Name for its alerts", type: "text", placeholder: "Office", help: "Shown in front of its alerts here, for example \"Office: Drive 1I:3:4 is Critical\"." },
    {
      key: "token",
      label: "Access token",
      type: "password",
      help: "Created on the other Lumina under Settings → Access tokens. Needed when it does not allow public viewing. It only lets this Lumina read what an anonymous visitor could see.",
    },
    { key: "verifyTls", label: "Verify TLS certificate", type: "boolean", default: false },
    { key: "fingerprint", label: "Certificate fingerprint (optional)", type: "text", help: "SHA-256 fingerprint. When set, Lumina only talks to a server presenting exactly this certificate, even if it is self-signed. Use Detect to read it." },
  ],
  configSchema: ConfigSchema,
  pollIntervalMs: 20_000,
  minPollIntervalMs: 10_000,
  multiInstance: true,

  async create(config) {
    let healthy = false;
    const base = config.url.replace(/\/+$/, "");
    const headers: Record<string, string> = config.token ? { authorization: `Bearer ${config.token}` } : {};
    const opts = { headers, verifyTls: config.verifyTls, fingerprint: config.fingerprint, timeoutMs: 15_000 };
    return {
      async poll() {
        try {
          const [instances, alerts, health] = await Promise.all([
            httpJson<Obj[]>(`${base}/api/instances`, opts),
            httpJson<Obj>(`${base}/api/alerts`, opts),
            httpJson<Obj>(`${base}/health`, opts).catch(() => ({} as Obj)),
          ]);
          if (!Array.isArray(instances)) throw new Error("That address did not answer like a Lumina server");
          healthy = true;
          const d = digest(instances, alerts);
          return { label: config.label || "Remote", ...d, remoteUptime: typeof health.uptime === "number" ? health.uptime : null };
        } catch (err) {
          healthy = false;
          const m = err instanceof Error ? err.message : String(err);
          throw new Error(/401|403/.test(m) ? `The other Lumina refused access (${m}). Check the access token.` : m);
        }
      },
      async status() {
        return healthy ? "connected" : "disconnected";
      },
      alerts(d: { label: string; devices: RemoteDevice[]; alerts: RemoteAlert[] }) {
        const out: AlertCondition[] = [];
        for (const a of d.alerts) {
          out.push({ key: `remote:${a.instanceId}:${a.key}`, severity: a.severity === "info" ? "warning" : a.severity, title: `${d.label}: ${a.title}`, detail: [a.instanceId, a.detail].filter(Boolean).join(" · ") });
        }
        return out;
      },
      metrics(d: { devices: RemoteDevice[]; alerts: RemoteAlert[] }) {
        return {
          "devices:online": d.devices.filter((x) => x.level === "ok").length,
          "devices:total": d.devices.length,
          "alerts:critical": d.alerts.filter((a) => a.severity === "critical").length,
          "alerts:total": d.alerts.length,
        };
      },
      actions: [],
    };
  },
});
