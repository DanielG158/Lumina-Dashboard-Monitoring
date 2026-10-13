import { z } from "zod";
import { basicAuth, defineModule, httpText, type AlertCondition } from "@lumina/sdk";

const ConfigSchema = z.object({
  url: z.string().url(),
  apiKey: z.string().min(1),
  verifyTls: z.boolean().default(false),
  /** Slug of a status page that lists your push monitors; lets Lumina read the message each push sends. */
  statusPage: z.string().trim().max(120).optional(),
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
  /** Latest message sent with a push (needs a status page), e.g. "38C". */
  message: string | null;
  /** First number found in that message, so it can be charted. */
  value: number | null;
  /** When the latest heartbeat arrived (ms). */
  lastBeat: number | null;
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
        message: null,
        value: null,
        lastBeat: null,
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

/** "https://kuma/status/home", "/status/home" or "home" all mean the status page "home". */
export function statusPageSlug(input: string | undefined): string | null {
  const t = (input ?? "").trim();
  if (!t) return null;
  const m = /\/status\/([^/?#]+)/.exec(t);
  const slug = (m ? m[1] : t).replace(/^\/+|\/+$/g, "");
  return /^[A-Za-z0-9_-]+$/.test(slug) ? slug : null;
}

const firstNumber = (text: string | null): number | null => {
  const m = text === null ? null : /-?\d+(?:[.,]\d+)?/.exec(text);
  return m ? Number(m[0].replace(",", ".")) : null;
};

/** Adds the latest heartbeat message of each monitor on a status page (public JSON, no key needed). */
export function applyHeartbeats(monitors: Monitor[], page: any, beats: any): void {
  const idByName = new Map<string, string>();
  for (const g of page?.publicGroupList ?? []) for (const m of g.monitorList ?? []) if (m?.name) idByName.set(String(m.name), String(m.id));
  for (const mon of monitors) {
    const id = idByName.get(mon.name);
    const list = id ? beats?.heartbeatList?.[id] : null;
    const last = Array.isArray(list) && list.length ? list[list.length - 1] : null;
    if (!last) continue;
    const msg = typeof last.msg === "string" && last.msg.trim() ? last.msg.trim() : null;
    mon.message = msg;
    mon.value = firstNumber(msg);
    const t = typeof last.time === "string" ? Date.parse(last.time.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(last.time) ? "" : "Z")) : NaN;
    mon.lastBeat = Number.isFinite(t) ? t : null;
  }
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
    {
      key: "statusPage",
      label: "Status page name (optional, for push values)",
      type: "text",
      placeholder: "homelab",
      help: "To show what your Push monitors send (a temperature, a message): create a Status Page in Uptime Kuma, add the push monitors to it, and enter its name (the last part of /status/<name>). Without it Lumina only knows if the push arrived.",
    },
    { key: "verifyTls", label: "Verify TLS certificate", type: "boolean", default: false },
    { key: "fingerprint", label: "Certificate fingerprint (optional)", type: "text", help: "SHA-256 fingerprint. When set, Lumina only talks to a device presenting exactly this certificate, even if it is self-signed. Use Detect to read it from the device." },
  ],
  configSchema: ConfigSchema,
  pollIntervalMs: 15_000,
  multiInstance: true,

  async create(config) {
    let healthy = false;
    const base = config.url.replace(/\/+$/, "");
    const endpoint = `${base}/metrics`;
    const slug = statusPageSlug(config.statusPage);
    const tls = { verifyTls: config.verifyTls, fingerprint: config.fingerprint };
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
          let statusPage: { ok: boolean; error: string | null } | null = null;
          if (slug) {
            try {
              const [page, beats] = await Promise.all([
                httpText(`${base}/api/status-page/${slug}`, { headers: { accept: "application/json" }, ...tls }).then(JSON.parse),
                httpText(`${base}/api/status-page/heartbeat/${slug}`, { headers: { accept: "application/json" }, ...tls }).then(JSON.parse),
              ]);
              applyHeartbeats(monitors, page, beats);
              statusPage = { ok: true, error: null };
            } catch (e) {
              statusPage = { ok: false, error: `Status page "${slug}" could not be read: ${e instanceof Error ? e.message : String(e)}` };
            }
          }
          return {
            statusPage,
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
        for (const x of d.monitors.filter((y) => y.type === "push" && y.value !== null).slice(0, 20)) m[`push:${x.name}`] = x.value as number;
        return m;
      },
      actions: [],
    };
  },
});
