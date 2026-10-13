import { z } from "zod";
import { basicAuth, defineModule, httpText, type AlertCondition } from "@lumina/sdk";

const ConfigSchema = z.object({
  url: z.string().url(),
  apiKey: z.string().min(1),
  verifyTls: z.boolean().default(false),
  fingerprint: z.string().optional(),
});
type Config = z.infer<typeof ConfigSchema>;

export type KumaState = "up" | "down" | "pending" | "maintenance" | "unknown";

interface Monitor {
  name: string;
  type: string;
  target: string;
  status: KumaState;
  responseMs: number | null;
  certDays: number | null;
}

const STATES: Record<string, KumaState> = { "0": "down", "1": "up", "2": "pending", "3": "maintenance" };
const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\{(.*)\}\s+(\S+)\s*$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

// Uptime Kuma exposes monitors as Prometheus metrics at /metrics (auth: empty user + API key).
export function parseKumaMetrics(text: string): Monitor[] {
  const byKey = new Map<string, Monitor>();
  for (const line of text.split("\n")) {
    const m = LINE.exec(line);
    if (!m || !m[1].startsWith("monitor_")) continue;
    const labels: Record<string, string> = {};
    for (const l of m[2].matchAll(LABEL)) labels[l[1]] = l[2].replace(/\\(.)/g, "$1");
    const name = labels.monitor_name;
    if (!name) continue;
    const key = `${name}|${labels.monitor_type}|${labels.monitor_url}|${labels.monitor_hostname}|${labels.monitor_port}`;
    let mon = byKey.get(key);
    if (!mon) {
      const hasUrl = labels.monitor_url && labels.monitor_url !== "https://" && labels.monitor_url !== "null";
      const host = labels.monitor_hostname && labels.monitor_hostname !== "null" ? labels.monitor_hostname : "";
      const port = labels.monitor_port && labels.monitor_port !== "null" ? `:${labels.monitor_port}` : "";
      mon = {
        name,
        type: labels.monitor_type ?? "",
        target: hasUrl ? labels.monitor_url : `${host}${port}`,
        status: "unknown",
        responseMs: null,
        certDays: null,
      };
      byKey.set(key, mon);
    }
    const value = Number(m[3]);
    if (m[1] === "monitor_status") mon.status = STATES[m[3]] ?? "unknown";
    else if (m[1] === "monitor_response_time") mon.responseMs = value >= 0 ? value : null;
    else if (m[1] === "monitor_cert_days_remaining") mon.certDays = Number.isFinite(value) ? value : null;
  }
  return [...byKey.values()];
}

export default defineModule<Config>({
  id: "uptime-kuma",
  name: "Uptime Kuma",
  description: "Monitor up/down status and response time via Uptime Kuma's /metrics endpoint. Read-only.",
  fields: [
    { key: "url", label: "Uptime Kuma URL", type: "text", required: true, placeholder: "http://192.168.11.x:3001" },
    {
      key: "apiKey",
      label: "API key",
      type: "password",
      required: true,
      help: "Uptime Kuma → Settings → API Keys",
    },
    { key: "verifyTls", label: "Verify TLS certificate", type: "boolean", default: false },
    { key: "fingerprint", label: "Certificate fingerprint (optional)", type: "text", help: "SHA-256 fingerprint. When set, Lumina only talks to a device presenting exactly this certificate, even if it is self-signed. Use Detect to read it from the device." },
  ],
  configSchema: ConfigSchema,
  pollIntervalMs: 15_000,
  multiInstance: true,

  async create(config) {
    let healthy = false;
    const endpoint = `${config.url.replace(/\/+$/, "")}/metrics`;
    return {
      async poll() {
        try {
          const text = await httpText(endpoint, {
            headers: { authorization: basicAuth("", config.apiKey), accept: "text/plain" },
            verifyTls: config.verifyTls,
            fingerprint: config.fingerprint,
          });
          const monitors = parseKumaMetrics(text);
          healthy = true;
          return {
            monitors,
            summary: {
              up: monitors.filter((x) => x.status === "up").length,
              down: monitors.filter((x) => x.status === "down").length,
              pending: monitors.filter((x) => x.status === "pending").length,
              maintenance: monitors.filter((x) => x.status === "maintenance").length,
            },
          };
        } catch (err) {
          healthy = false;
          throw err;
        }
      },
      async status() {
        return healthy ? "connected" : "disconnected";
      },
      alerts(d: { monitors: Monitor[] }) {
        const out: AlertCondition[] = [];
        for (const m of d.monitors) {
          if (m.status === "down") out.push({ key: `monitor-down:${m.name}`, severity: "critical", title: `${m.name} is down`, detail: m.target || m.type });
          if (m.certDays !== null && m.certDays < 14) {
            const days = Math.floor(m.certDays);
            out.push(
              days < 0
                ? { key: `cert-expiring:${m.name}`, severity: "critical", title: `Certificate for ${m.name} has expired`, detail: `expired ${-days} day(s) ago` }
                : { key: `cert-expiring:${m.name}`, severity: days < 3 ? "critical" : "warning", title: `Certificate for ${m.name} expires soon`, detail: `${days} day(s) left` },
            );
          }
        }
        return out;
      },
      metrics(d: { monitors: Monitor[]; summary: Record<string, number> }) {
        const m: Record<string, number> = { "monitors:up": d.summary.up, "monitors:down": d.summary.down };
        const times = d.monitors.filter((x) => x.responseMs !== null && x.status === "up").map((x) => x.responseMs as number);
        if (times.length) m["response:avg"] = times.reduce((a, b) => a + b, 0) / times.length;
        for (const x of d.monitors.slice(0, 40)) if (x.responseMs !== null) m[`resp:${x.name}`] = x.responseMs;
        return m;
      },
      actions: [],
    };
  },
});
