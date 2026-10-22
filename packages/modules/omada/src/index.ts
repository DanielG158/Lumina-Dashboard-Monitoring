import { z } from "zod";
import { defineModule, httpRequestRaw, type AlertCondition } from "@lumina/sdk";

const ConfigSchema = z.object({
  url: z.string().url(),
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
  /** Leave empty to watch every site the account can see. */
  site: z.string().trim().max(100).optional(),
  verifyTls: z.boolean().default(false),
  fingerprint: z.string().optional(),
});
type Config = z.infer<typeof ConfigSchema>;
type Obj = Record<string, any>;

export type DeviceKind = "gateway" | "switch" | "ap" | "other";
export interface OmadaDevice {
  mac: string;
  name: string;
  kind: DeviceKind;
  model: string;
  /** connected, disconnected, pending, heartbeat-missed, isolated, upgrading, unknown */
  state: string;
  online: boolean;
  ip: string;
  uptimeS: number | null;
  cpu: number | null;
  mem: number | null;
  firmware: string | null;
  needsUpgrade: boolean;
  clients: number | null;
}
export interface OmadaSite { key: string; name: string; devices: OmadaDevice[] }

const kindOf = (t: unknown): DeviceKind => {
  const s = String(t ?? "").toLowerCase();
  if (s.startsWith("gate") || s === "router") return "gateway";
  if (s.startsWith("switch")) return "switch";
  if (s === "ap" || s.startsWith("eap") || s.includes("access")) return "ap";
  return "other";
};

/** The controller's own status numbers (see its device list). statusCategory is the coarse version. */
export function stateOf(status: unknown, category: unknown): { state: string; online: boolean } {
  const st = Number(status);
  if (st === 12) return { state: "upgrading", online: true };
  if (st === 13) return { state: "rebooting", online: true };
  const c = Number(category);
  if (c === 1) return { state: "connected", online: true };
  if (c === 0) return { state: "disconnected", online: false };
  if (c === 2) return { state: "pending", online: false };
  if (c === 3) return { state: "heartbeat-missed", online: false };
  if (c === 4) return { state: "isolated", online: false };
  if (st === 14 || st === 15 || st === 16 || st === 17) return { state: "connected", online: true };
  if (st === 0 || st === 1) return { state: "disconnected", online: false };
  if (st >= 30 && st <= 33) return { state: "heartbeat-missed", online: false };
  if (st >= 20 && st <= 27) return { state: "pending", online: false };
  if (st === 40 || st === 41) return { state: "isolated", online: false };
  return { state: "unknown", online: false };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export function parseDevice(d: Obj): OmadaDevice {
  const { state, online } = stateOf(d.status, d.statusCategory);
  const mac = String(d.mac ?? "");
  return {
    mac,
    name: String(d.name ?? d.showName ?? mac),
    kind: kindOf(d.type),
    model: String(d.showModel ?? d.model ?? ""),
    state,
    online,
    ip: String(d.ip ?? ""),
    uptimeS: online ? num(d.uptimeLong) : null,
    cpu: online ? num(d.cpuUtil) : null,
    mem: online ? num(d.memUtil) : null,
    firmware: d.firmwareVersion ? String(d.firmwareVersion) : null,
    needsUpgrade: online && d.needUpgrade === true,
    clients: num(d.clientNum),
  };
}

/** The controller wraps every answer as { errorCode, msg, result }. */
export class OmadaError extends Error {
  constructor(public code: number, message: string) { super(message); }
}
const LOGIN_FAILED = new Set([-30109, -30108]);
const SESSION_GONE = new Set([-1200, -1201, -1202, -1203, -1210, -44112]);

export default defineModule<Config>({
  id: "omada",
  name: "TP-Link Omada Controller",
  description: "Routers (gateways), switches and access points managed by an Omada controller: status, clients, load, firmware. Read-only. Works with the software controller and the OC200 / OC300 hardware controllers (version 5.1 or newer).",
  fields: [
    { key: "url", label: "Controller address", type: "text", required: true, placeholder: "https://192.168.1.2:8043", help: "The address you open in the browser to manage the controller (port 8043 for the software controller, 443 for hardware controllers)." },
    { key: "username", label: "Username", type: "text", required: true, help: "Create a separate account for Lumina with the Viewer role, so it can only look." },
    { key: "password", label: "Password", type: "password", required: true },
    { key: "site", label: "Site name (optional)", type: "text", placeholder: "Default", help: "Leave empty to show every site this account can see." },
    { key: "verifyTls", label: "Verify TLS certificate", type: "boolean", default: false },
    { key: "fingerprint", label: "Certificate fingerprint (optional)", type: "text", help: "SHA-256 fingerprint. When set, Lumina only talks to a controller presenting exactly this certificate, even if it is self-signed. Use Detect to read it." },
  ],
  configSchema: ConfigSchema,
  pollIntervalMs: 30_000,
  minPollIntervalMs: 10_000,
  multiInstance: true,

  async create(config) {
    const base = config.url.replace(/\/+$/, "");
    const tls = { verifyTls: config.verifyTls, fingerprint: config.fingerprint, timeoutMs: 15_000 };
    let healthy = false;
    let omadacId: string | null = null;
    let version: string | null = null;
    let cookie = "";
    let csrf = "";

    async function call<T = unknown>(method: "GET" | "POST", url: string, body?: unknown, authed = true): Promise<T> {
      const headers: Record<string, string> = { accept: "application/json" };
      if (authed && cookie) headers.cookie = cookie;
      if (authed && csrf) headers["csrf-token"] = csrf;
      const res = await httpRequestRaw(url, { method, body, headers, ...tls });
      if (res.status >= 400) throw new OmadaError(res.status, !authed ? `That address did not answer like an Omada controller (${method} ${new URL(url).pathname} -> ${res.status})` : `${method} ${new URL(url).pathname} -> ${res.status} ${res.statusText}`.trim());
      let json: Obj;
      try { json = JSON.parse(res.body) as Obj; } catch {
        // An expired session often answers 200 with the login page instead of JSON.
        if (!authed) throw new Error("That address did not answer like an Omada controller (check the address and port)");
        throw new OmadaError(-1200, "The controller answered with a page instead of data (the session ended)");
      }
      if (typeof json.errorCode === "number" && json.errorCode !== 0) throw new OmadaError(json.errorCode, String(json.msg ?? `error ${json.errorCode}`));
      return (json.result ?? json) as T;
    }

    async function login() {
      cookie = ""; csrf = "";
      const info = await call<Obj>("GET", `${base}/api/info`, undefined, false);
      omadacId = String(info.omadacId ?? "");
      version = info.controllerVer ? String(info.controllerVer) : null;
      if (!omadacId) throw new Error("That address did not answer like an Omada controller");
      const res = await httpRequestRaw(`${base}/${omadacId}/api/v2/login`, { method: "POST", body: { username: config.username, password: config.password }, headers: { accept: "application/json" }, ...tls });
      let json: Obj;
      try { json = JSON.parse(res.body) as Obj; } catch { throw new Error(`The controller did not accept the login request (HTTP ${res.status})`); }
      if (json.errorCode !== 0) throw new OmadaError(Number(json.errorCode), LOGIN_FAILED.has(Number(json.errorCode)) ? "The controller refused the username or password" : String(json.msg ?? "login failed"));
      csrf = String(json.result?.token ?? "");
      const set = res.headers["set-cookie"];
      cookie = (Array.isArray(set) ? set : set ? [set] : []).map((c) => c.split(";")[0]).join("; ");
      if (!csrf) throw new Error("The controller did not hand out a login token");
    }

    const api = <T,>(path: string) => call<T>("GET", `${base}/${omadacId}/api/v2/${path}`);
    async function withLogin<T>(fn: () => Promise<T>): Promise<T> {
      if (!omadacId || (!cookie && !csrf)) await login();
      try { return await fn(); } catch (e) {
        if (e instanceof OmadaError && (SESSION_GONE.has(e.code) || e.code === 401 || e.code === 403)) { await login(); return fn(); }
        throw e;
      }
    }

    return {
      async poll() {
        try {
          const { sites, user } = await withLogin(async () => {
            const me = await api<Obj>("users/current");
            const all = ((me.privilege?.sites ?? []) as Obj[]).map((s) => ({ key: String(s.key), name: String(s.name ?? s.key) }));
            return { sites: all, user: String(me.name ?? config.username) };
          });
          const want = (config.site ?? "").trim().toLowerCase();
          const chosen = want ? sites.filter((s) => s.name.toLowerCase() === want) : sites;
          if (want && chosen.length === 0) throw new Error(`The account cannot see a site named "${config.site}". It can see: ${sites.map((s) => s.name).join(", ") || "none"}`);
          const out: OmadaSite[] = [];
          for (const s of chosen) {
            const list = await withLogin(() => api<Obj[]>(`sites/${s.key}/devices`));
            out.push({ key: s.key, name: s.name, devices: (Array.isArray(list) ? list : []).map(parseDevice) });
          }
          healthy = true;
          const all = out.flatMap((s) => s.devices);
          return {
            controller: { version, user },
            sites: out,
            summary: {
              total: all.length,
              online: all.filter((d) => d.online).length,
              offline: all.filter((d) => !d.online).length,
              clients: all.reduce((a, d) => a + (d.kind === "ap" ? d.clients ?? 0 : 0), 0),
              upgrades: all.filter((d) => d.needsUpgrade).length,
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
      alerts(d: { sites: OmadaSite[] }) {
        const out: AlertCondition[] = [];
        for (const s of d.sites) for (const x of s.devices) {
          const where = `${s.name} · ${x.model}${x.ip ? ` · ${x.ip}` : ""}`;
          if (x.state === "disconnected") out.push({ key: `device-down:${x.mac}`, severity: "critical", title: `${x.name} is offline`, detail: where });
          else if (x.state === "heartbeat-missed" || x.state === "isolated") out.push({ key: `device-down:${x.mac}`, severity: "warning", title: `${x.name} is ${x.state === "isolated" ? "isolated from the network" : "not answering the controller"}`, detail: where });
          else if (x.state === "pending") out.push({ key: `device-pending:${x.mac}`, severity: "info", title: `${x.name} is waiting to be adopted`, detail: where });
          if (x.cpu !== null && x.cpu >= 90) out.push({ key: `device-cpu:${x.mac}`, severity: "warning", title: `${x.name} CPU is very busy`, detail: `${x.cpu}% · ${where}` });
          if (x.mem !== null && x.mem >= 92) out.push({ key: `device-mem:${x.mac}`, severity: "warning", title: `${x.name} is almost out of memory`, detail: `${x.mem}% · ${where}` });
          if (x.needsUpgrade) out.push({ key: `device-fw:${x.mac}`, severity: "info", title: `${x.name} has a firmware update`, detail: `${x.firmware ?? ""} · ${where}` });
        }
        return out;
      },
      metrics(d: { sites: OmadaSite[]; summary: { online: number; total: number; clients: number } }) {
        const m: Record<string, number> = { "devices:online": d.summary.online, "devices:total": d.summary.total, "clients:total": d.summary.clients };
        for (const x of d.sites.flatMap((s) => s.devices).filter((y) => y.online).slice(0, 40)) {
          if (x.cpu !== null) m[`cpu:${x.name}`] = x.cpu;
          if (x.mem !== null) m[`mem:${x.name}`] = x.mem;
          if (x.kind === "ap" && x.clients !== null) m[`clients:${x.name}`] = x.clients;
        }
        return m;
      },
      actions: [],
    };
  },
});
