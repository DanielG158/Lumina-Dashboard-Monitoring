import { z } from "zod";
import { createCipheriv, createDecipheriv, createHash, createPublicKey, publicEncrypt, randomBytes, constants } from "node:crypto";
import { defineModule, httpRequestRaw, type AlertCondition } from "@lumina/sdk";

// TP-Link Archer routers (AX and C series, firmware with the "luci" web interface) have no monitoring interface of their own.
// This module signs in to the router's admin page like the browser does and reads its status page. It follows the protocol that the
// open-source project "TP-Link-Archer-C6U" (MIT) documents for these routers: the password is RSA-encrypted, and on older firmware
// the whole conversation is additionally AES-encrypted and signed. It only ever reads.

const ConfigSchema = z.object({
  url: z.string().url(),
  username: z.string().min(1).max(100).default("admin"),
  password: z.string().min(1).max(125),
  verifyTls: z.boolean().default(false),
  fingerprint: z.string().optional(),
});
type Config = z.infer<typeof ConfigSchema>;
type Obj = Record<string, any>;

// ---- the router's encryption --------------------------------------------------------------------------------------------

/** RSA (PKCS#1 v1.5) with the public key the router hands out as hex numbers; the result is hex. */
export function rsaEncryptHex(data: string, nnHex: string, eeHex: string): string {
  const b64u = (h: string) => Buffer.from(h.length % 2 ? `0${h}` : h, "hex").toString("base64url");
  const key = createPublicKey({ key: { kty: "RSA", n: b64u(nnHex), e: b64u(eeHex) }, format: "jwk" });
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(data, "utf8")).toString("hex");
}

/** AES-128-CBC with a key and iv that are 16 hex characters each, used as ASCII, with PKCS7 padding; the result is base64. */
export class RouterCipher {
  readonly key = randomBytes(8).toString("hex");
  readonly iv = randomBytes(8).toString("hex");
  encrypt(text: string): string {
    const c = createCipheriv("aes-128-cbc", Buffer.from(this.key, "ascii"), Buffer.from(this.iv, "ascii"));
    return Buffer.concat([c.update(text, "utf8"), c.final()]).toString("base64");
  }
  decrypt(b64: string): string {
    const d = createDecipheriv("aes-128-cbc", Buffer.from(this.key, "ascii"), Buffer.from(this.iv, "ascii"));
    return Buffer.concat([d.update(Buffer.from(b64, "base64")), d.final()]).toString("utf8");
  }
  /** The signature that goes with each message: "h=<md5>&s=<sequence + message length>" cut in 53-character pieces, each RSA-encrypted. The login also carries the AES key. */
  sign(seq: number, isLogin: boolean, hash: string, nn: string, ee: string): string {
    const s = isLogin ? `k=${this.key}&i=${this.iv}&h=${hash}&s=${seq}` : `h=${hash}&s=${seq}`;
    let out = "";
    for (let pos = 0; pos < s.length; pos += 53) out += rsaEncryptHex(s.slice(pos, pos + 53), nn, ee);
    return out;
  }
}

// ---- what the router answers --------------------------------------------------------------------------------------------

export interface RouterClient { name: string; ip: string; mac: string; kind: "wired" | "wifi" | "guest" }
export interface RouterStatus {
  cpu: number | null;
  mem: number | null;
  wan: { ip: string; gateway: string; type: string | null; uptimeS: number | null; up: boolean };
  lan: { ip: string };
  clients: { wired: number; wifi: number; guest: number; total: number };
  list: RouterClient[];
}

const pct = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round((n <= 1 ? n * 100 : n) * 10) / 10 : null;
};
const ip = (v: unknown) => (typeof v === "string" && /^[0-9a-fA-F:.]+$/.test(v) ? v : "");
const mac = (v: unknown) => String(v ?? "").replace(/-/g, ":").toUpperCase();

export function parseStatus(d: Obj): RouterStatus {
  const dev = (arr: unknown, kind: RouterClient["kind"]): RouterClient[] => (Array.isArray(arr) ? arr : []).map((x: Obj) => ({ name: String(x.hostname ?? ""), ip: ip(x.ipaddr), mac: mac(x.macaddr), kind }));
  const wired = dev(d.access_devices_wired, "wired"), wifi = dev(d.access_devices_wireless_host, "wifi"), guest = dev(d.access_devices_wireless_guest, "guest");
  const wanIp = ip(d.wan_ipv4_ipaddr);
  const up = wanIp !== "" && wanIp !== "0.0.0.0";
  return {
    cpu: pct(d.cpu_usage),
    mem: pct(d.mem_usage),
    wan: { ip: wanIp, gateway: ip(d.wan_ipv4_gateway), type: d.conn_type ? String(d.conn_type) : null, uptimeS: typeof d.wan_ipv4_uptime === "number" ? d.wan_ipv4_uptime : Number.isFinite(Number(d.wan_ipv4_uptime)) && d.wan_ipv4_uptime !== undefined ? Number(d.wan_ipv4_uptime) : null, up },
    lan: { ip: ip(d.lan_ipv4_ipaddr) },
    clients: { wired: wired.length, wifi: wifi.length, guest: guest.length, total: wired.length + wifi.length + guest.length },
    list: [...wired, ...wifi, ...guest],
  };
}

export class RouterError extends Error {
  constructor(message: string, public kind: "login" | "busy" | "protocol" | "network" = "protocol") { super(message); }
}

/** Sessions on these routers are single-user, so a login that finds someone else signed in is "busy", not "broken". */
const BUSY = /conflict|another|already|exceed|too many|locked/i;

export default defineModule<Config>({
  id: "tplink-router",
  name: "TP-Link Archer router",
  description: "Status of a TP-Link Archer router (for example AX12, AX10, AX20, AX23, AX50, C6U): internet connection, CPU and memory, and the devices connected. Read-only. Signs in to the router's admin page, so it uses the router's local password.",
  fields: [
    { key: "url", label: "Router address", type: "text", required: true, placeholder: "http://192.168.0.1", help: "The address you open to manage the router (also tplinkwifi.net). If you use https, turn on Local Management via HTTPS in the router first." },
    { key: "username", label: "Username", type: "text", default: "admin" },
    { key: "password", label: "Router password", type: "password", required: true, help: "The local password of the router's admin page, not your TP-Link ID. While Lumina is signed in, nobody else can use the admin page; Lumina signs out again after each reading." },
    { key: "verifyTls", label: "Verify TLS certificate", type: "boolean", default: false },
    { key: "fingerprint", label: "Certificate fingerprint (optional)", type: "text", help: "Only for https. SHA-256 fingerprint of the router's certificate. Use Detect to read it." },
  ],
  configSchema: ConfigSchema,
  pollIntervalMs: 60_000,
  minPollIntervalMs: 30_000,
  multiInstance: true,

  async create(config) {
    const base = config.url.replace(/\/+$/, "");
    const tls = { verifyTls: config.verifyTls, fingerprint: config.fingerprint, timeoutMs: 15_000 };
    const referer = `${base}/webpages/index.html`;
    const hash = createHash("md5").update(config.username + config.password).digest("hex");
    let healthy = false;
    let last: (RouterStatus & { model: string | null; hardware: string | null; firmware: string | null }) | null = null;
    let fwAt = 0;
    let fw: { model: string | null; hardware: string | null; firmware: string | null } = { model: null, hardware: null, firmware: null };
    let credentialsBadUntil = 0;
    let credentialsError = "";

    interface Session { stok: string; sysauth: string; mode: "plain" | "aes"; cipher: RouterCipher | null; seq: number; nn: string; ee: string }

    const post = (url: string, body: string | undefined, headers: Record<string, string> = {}) => httpRequestRaw(url, { method: "POST", body, headers: { accept: "application/json", ...headers }, ...tls });
    const parseJson = (text: string, what: string): Obj => { try { return JSON.parse(text) as Obj; } catch { throw new RouterError(`The router's ${what} did not answer like a TP-Link Archer router (check the address)`, "protocol"); } };

    async function login(): Promise<Session> {
      if (Date.now() < credentialsBadUntil) throw new RouterError(credentialsError, "login");
      const keysRes = await post(`${base}/cgi-bin/luci/;stok=/login?form=keys&operation=read`, undefined);
      const keys = parseJson(keysRes.body, "login page");
      const pwd = keys?.data?.password;
      if (!Array.isArray(pwd) || pwd.length < 2) throw new RouterError("That address did not answer like a TP-Link Archer router (no login key). Models with a different admin page, such as Deco, are not supported.", "protocol");
      const [pn, pe] = pwd as [string, string];
      const encPwd = rsaEncryptHex(config.password, pn, pe);
      const plain = pn.length >= 512; // newer firmware: RSA only, JSON, no AES layer

      if (plain) {
        const res = await post(`${base}/cgi-bin/luci/;stok=/login?form=login`, `operation=login&password=${encPwd}`, { referer, "content-type": "application/x-www-form-urlencoded" });
        const j = parseJson(res.body, "login");
        if (!j.success) return failLogin(j);
        return { stok: String(j.data?.stok ?? ""), sysauth: sysauth(res.headers["set-cookie"]), mode: "plain", cipher: null, seq: 0, nn: "", ee: "" };
      }

      const authRes = await post(`${base}/cgi-bin/luci/;stok=/login?form=auth&operation=read`, undefined);
      const auth = parseJson(authRes.body, "login page");
      const seq = Number(auth?.data?.seq), key = auth?.data?.key;
      if (!Number.isFinite(seq) || !Array.isArray(key) || key.length < 2) throw new RouterError("The router did not hand out a signing key", "protocol");
      const cipher = new RouterCipher();
      const data = cipher.encrypt(`operation=login&password=${encPwd}&confirm=true`);
      const sign = cipher.sign(seq + data.length, true, hash, key[0], key[1]);
      const res = await post(`${base}/cgi-bin/luci/;stok=/login?form=login`, new URLSearchParams({ sign, data }).toString(), { referer, "content-type": "application/x-www-form-urlencoded" });
      const wrapped = parseJson(res.body, "login");
      const j = typeof wrapped.data === "string" ? (JSON.parse(cipher.decrypt(wrapped.data)) as Obj) : wrapped;
      if (!j.success) return failLogin(j);
      return { stok: String(j.data?.stok ?? ""), sysauth: sysauth(res.headers["set-cookie"]), mode: "aes", cipher, seq, nn: String(key[0]), ee: String(key[1]) };
    }

    function sysauth(set: string | string[] | undefined): string {
      const all = Array.isArray(set) ? set.join(";") : set ?? "";
      return /sysauth=([^;]+)/.exec(all)?.[1] ?? "";
    }
    function failLogin(j: Obj): never {
      const code = String(j?.data?.errorcode ?? j?.errorcode ?? "unknown");
      if (BUSY.test(code)) throw new RouterError(`The router says someone else is signed in to its admin page (${code}). Lumina will try again at the next reading.`, "busy");
      // A wrong password is not retried for a while, so Lumina can never lock the router's login by itself.
      credentialsError = `The router refused the login (${code}). Check the username and the router's local password (not the TP-Link ID). Lumina waits 10 minutes before trying again, so it cannot lock the router.`;
      credentialsBadUntil = Date.now() + 10 * 60_000;
      throw new RouterError(credentialsError, "login");
    }

    async function request(s: Session, path: string, operation = "read"): Promise<Obj> {
      const url = `${base}/cgi-bin/luci/;stok=${s.stok}/${path}${path.includes("operation=") ? "" : `&operation=${operation}`}`;
      const payload = `{"operation": "${operation}"}`;
      const headers: Record<string, string> = { referer, origin: base, cookie: `sysauth=${s.sysauth}`, "content-type": "application/json" };
      let body: string;
      if (s.mode === "aes" && s.cipher) {
        const data = s.cipher.encrypt(payload);
        const sign = s.cipher.sign(s.seq + data.length, false, hash, s.nn, s.ee);
        body = new URLSearchParams({ sign, data }).toString();
      } else body = payload;
      const res = await post(url, body, headers);
      let j = parseJson(res.body, "status page");
      if (s.mode === "aes" && s.cipher && typeof j.data === "string") j = JSON.parse(s.cipher.decrypt(j.data)) as Obj;
      if (!j.success) throw new RouterError(`The router refused the request for ${path} (${String(j?.data?.errorcode ?? "no reason given")})`, "protocol");
      return (j.data ?? {}) as Obj;
    }

    return {
      async poll() {
        let s: Session | null = null;
        try {
          s = await login();
          const status = parseStatus(await request(s, "admin/status?form=all"));
          if (status.cpu === null || status.mem === null) {
            try { const perf = await request(s, "admin/status?form=perf"); status.cpu ??= pct(perf.cpu_usage); status.mem ??= pct(perf.mem_usage); } catch { /* not on every model */ }
          }
          if (Date.now() - fwAt > 30 * 60_000) {
            try { const f = await request(s, "admin/firmware?form=upgrade"); fw = { model: f.model ? String(f.model) : null, hardware: f.hardware_version ? String(f.hardware_version) : null, firmware: f.firmware_version ? String(f.firmware_version) : null }; fwAt = Date.now(); } catch { fwAt = Date.now() - 25 * 60_000; }
          }
          last = { ...status, ...fw };
          healthy = true;
          return { ...last, busy: false };
        } catch (err) {
          if (err instanceof RouterError && err.kind === "busy" && last) { healthy = true; return { ...last, busy: true }; }
          healthy = false;
          throw err;
        } finally {
          // Free the router's single admin session for the person who wants the web page.
          if (s) await request(s, "admin/system?form=logout", "write").catch(() => undefined);
        }
      },
      async status() {
        return healthy ? "connected" : "disconnected";
      },
      alerts(d: RouterStatus) {
        const out: AlertCondition[] = [];
        if (!d.wan.up) out.push({ key: "internet-down", severity: "critical", title: "The router has no internet connection", detail: "The router reports no address on its internet (WAN) port" });
        if (d.cpu !== null && d.cpu >= 90) out.push({ key: "high-cpu", severity: "warning", title: "The router's CPU is very busy", detail: `${d.cpu}%` });
        if (d.mem !== null && d.mem >= 92) out.push({ key: "high-mem", severity: "warning", title: "The router is almost out of memory", detail: `${d.mem}%` });
        return out;
      },
      metrics(d: RouterStatus) {
        const m: Record<string, number> = { "clients:total": d.clients.total, "clients:wifi": d.clients.wifi, "clients:wired": d.clients.wired, "clients:guest": d.clients.guest, "wan:up": d.wan.up ? 1 : 0 };
        if (d.cpu !== null) m.cpu = d.cpu;
        if (d.mem !== null) m.mem = d.mem;
        return m;
      },
      actions: [],
    };
  },
});
