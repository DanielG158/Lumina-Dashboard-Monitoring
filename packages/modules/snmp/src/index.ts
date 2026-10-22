import { z } from "zod";
import * as snmpNs from "net-snmp";
import { createSocket } from "node:dgram";
import { defineModule, type AlertCondition } from "@lumina/sdk";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const snmp: any = (snmpNs as any).default ?? snmpNs;
type Obj = Record<string, any>;

/** The settings every SNMP module needs to reach a device; other SNMP modules (iLO) reuse them. */
export const connectionShape = {
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(161),
  version: z.enum(["2c", "3"]).default("2c"),
  community: z.string().max(200).optional(),
  user: z.string().max(100).optional(),
  authProtocol: z.enum(["sha", "sha256", "sha512", "md5", "none"]).default("sha"),
  authKey: z.string().max(200).optional(),
  privProtocol: z.enum(["aes", "aes256b", "des", "none"]).default("aes"),
  privKey: z.string().max(200).optional(),
};
export type ConnectionConfig = z.infer<z.ZodObject<typeof connectionShape>>;
export function checkConnection(c: ConnectionConfig, ctx: z.RefinementCtx) {
  if (c.version === "2c" && !c.community) ctx.addIssue({ code: "custom", path: ["community"], message: "Enter the SNMP community" });
  if (c.version === "3" && !c.user) ctx.addIssue({ code: "custom", path: ["user"], message: "Enter the SNMPv3 user name" });
  if (c.version === "3" && c.authProtocol !== "none" && (c.authKey ?? "").length < 8) ctx.addIssue({ code: "custom", path: ["authKey"], message: "The authentication key must be at least 8 characters" });
  if (c.version === "3" && c.privProtocol !== "none" && c.authProtocol === "none") ctx.addIssue({ code: "custom", path: ["privProtocol"], message: "Encryption needs authentication too" });
  if (c.version === "3" && c.privProtocol !== "none" && (c.privKey ?? "").length < 8) ctx.addIssue({ code: "custom", path: ["privKey"], message: "The encryption key must be at least 8 characters" });
}

/** The form fields that go with {@link connectionShape}. */
export const connectionFields = [
  { key: "host", label: "Device address", type: "text" as const, required: true, placeholder: "192.168.1.1" },
  { key: "port", label: "Port", type: "number" as const, default: 161 },
  { key: "version", label: "SNMP version (2c or 3)", type: "text" as const, default: "2c", help: "Use 3 where the device supports it: version 2c sends its community in clear text." },
  { key: "community", label: "Community (version 2c)", type: "password" as const, help: "Often \"public\". Allow only this Lumina's address on the device." },
  { key: "user", label: "User (version 3)", type: "text" as const },
  { key: "authProtocol", label: "Authentication (sha, sha256, sha512, md5, none)", type: "text" as const, default: "sha", help: "Must match the device. TP-Link Omada's default SNMPv3 mode uses md5 with no encryption (privacy none); its recommended mode adds aes or des. HPE iLO uses md5 or sha." },
  { key: "authKey", label: "Authentication key (version 3)", type: "password" as const },
  { key: "privProtocol", label: "Encryption (aes, aes256b, des, none)", type: "text" as const, default: "aes" },
  { key: "privKey", label: "Encryption key (version 3)", type: "password" as const },
];

/** A session to the device plus small promise helpers, and the helper to look at a value. */
export function openSession(config: ConnectionConfig, timeoutMs = 4000, retries = 1) {
  const opts = { port: config.port, timeout: timeoutMs, retries, version: config.version === "3" ? snmp.Version3 : snmp.Version2c };
  const session: Obj =
    config.version === "3"
      ? snmp.createV3Session(
          config.host,
          { name: config.user, level: config.authProtocol === "none" ? snmp.SecurityLevel.noAuthNoPriv : config.privProtocol === "none" ? snmp.SecurityLevel.authNoPriv : snmp.SecurityLevel.authPriv,
            authProtocol: snmp.AuthProtocols[config.authProtocol], authKey: config.authKey, privProtocol: snmp.PrivProtocols[config.privProtocol], privKey: config.privKey },
          opts,
        )
      : snmp.createSession(config.host, config.community, opts);
  session.on("error", () => undefined);
  const get = (oids: string[]) => new Promise<Obj[]>((resolve, reject) => session.get(oids, (e: Error | null, vbs: Obj[]) => (e ? reject(e) : resolve(vbs))));
  const table = (oid: string, columns: number[]) => new Promise<Obj>((resolve, reject) => session.tableColumns(oid, columns, 20, (e: Error | null, t: Obj) => (e ? reject(e) : resolve(t))));
  const val = (vb: Obj | undefined) => (vb && !snmp.isVarbindError(vb) ? vb.value : undefined);
  return { session, get, table, val, close: () => { try { session.close(); } catch { /* already closed */ } } };
}

const ConfigSchema = z
  .object({
    ...connectionShape,
    watch: z.string().max(500).optional(),
    hide: z.string().max(200).default("^(lo|lo0|pflog\\d*|pfsync\\d*|enc\\d*|ipsec\\d*)$"),
    busyPct: z.number().min(1).max(100).default(90),
  })
  .superRefine((c, ctx) => {
    checkConnection(c, ctx);
    try { new RegExp(c.hide); } catch { ctx.addIssue({ code: "custom", path: ["hide"], message: "Not a valid pattern" }); }
  });
type Config = z.infer<typeof ConfigSchema>;

export interface Iface {
  index: number;
  name: string;
  alias: string | null;
  up: boolean;
  speedMbps: number | null;
  inBps: number | null;
  outBps: number | null;
  errPerSec: number | null;
  watched: boolean;
  utilPct: number | null;
}

const OID = {
  sysDescr: "1.3.6.1.2.1.1.1.0",
  sysUpTime: "1.3.6.1.2.1.1.3.0",
  sysName: "1.3.6.1.2.1.1.5.0",
  ifTable: "1.3.6.1.2.1.2.2",
  ifXTable: "1.3.6.1.2.1.31.1.1",
  load1: "1.3.6.1.4.1.2021.10.1.3.1",
  memTotal: "1.3.6.1.4.1.2021.4.5.0",
  memAvail: "1.3.6.1.4.1.2021.4.6.0",
};

/**
 * "No answer" has two very different causes. If something at the address says "nothing is listening on that port" (the operating system
 * reports it on the next send), SNMP is simply not running there. If there is total silence, the device is dropping the request: a
 * wrong community or user, a firewall, or an access list that does not include this server.
 */
export function probeUdpPort(host: string, port: number, waitMs = 700): Promise<"closed" | "silent"> {
  return new Promise((resolve) => {
    const sock = createSocket(host.includes(":") ? "udp6" : "udp4");
    let done = false;
    const finish = (r: "closed" | "silent") => { if (done) return; done = true; try { sock.close(); } catch { /* already closed */ } resolve(r); };
    sock.once("error", (e: NodeJS.ErrnoException) => finish(e.code === "ECONNREFUSED" ? "closed" : "silent"));
    sock.connect(port, host, () => {
      // Two tiny sends: the first provokes the "port unreachable" reply, the second surfaces it as an error on this socket.
      sock.send(Buffer.from([0x30, 0x00]), (e) => { if (e) finish("silent"); });
      const again = setTimeout(() => { if (!done) { try { sock.send(Buffer.from([0x30, 0x00]), () => undefined); } catch { /* closed meanwhile */ } } }, 250);
      setTimeout(() => { clearTimeout(again); finish("silent"); }, waitMs).unref();
    });
    sock.once("error", () => undefined);
  });
}

export function explainNoAnswer(kind: "closed" | "silent", host: string, port: number, version: string): string {
  return kind === "closed"
    ? `Something answered "port closed" for UDP ${port} at ${host}. That is either the device (SNMP is not switched on there, or it only listens on its own loopback address) or, just as often, a router or firewall between this Lumina and the device that rejects UDP ${port}. If the device is on another subnet, check the router's firewall rules first (allow UDP ${port} from this Lumina's address to the device).`
    : `No answer from ${host}:${port}. The device ignores the request, which usually means the ${version === "3" ? "SNMPv3 user or keys are wrong" : "community is wrong"}, a firewall drops UDP ${port}, or the device only answers certain addresses (allow this Lumina's address in its SNMP settings).`;
}

/** The device's SNMP agent answers "authorizationError" when the login is fine but its access settings hide what was asked for. */
export const isDenied = (e: unknown): boolean => /authorizationerror/i.test(e instanceof Error ? e.message : String(e)) || (e as { status?: number } | null)?.status === 16;

/** System name, uptime and description. If a device hides some of them, the others are still read one at a time. */
export async function getSystem(get: (oids: string[]) => Promise<Obj[]>, oids: string[]): Promise<(Obj | undefined)[]> {
  try {
    return await get(oids);
  } catch (e) {
    if (!isDenied(e)) throw e;
    const out: (Obj | undefined)[] = [];
    for (const o of oids) {
      try { out.push((await get([o]))[0]); } catch (x) { if (!isDenied(x)) throw x; out.push(undefined); }
    }
    return out;
  }
}

const COLUMN_SETS = [[2, 3, 5, 8, 10, 14, 16, 20], [2, 3, 5, 8, 10, 16], [2, 8]];
/** The interface table, asking for fewer columns when the device only allows some of them. */
export async function readIfTable(table: (oid: string, columns: number[]) => Promise<Obj>, oid: string, host: string, port: number, version: string): Promise<Obj> {
  for (const cols of COLUMN_SETS) {
    try {
      return await table(oid, cols);
    } catch (e) {
      if (!isDenied(e)) throw e;
    }
  }
  throw new Error(`${host}:${port} accepted the SNMP login but refuses to show its interface list (SNMP error "authorizationError"). The device's own access settings hide that part of its data. Allow the interfaces part (1.3.6.1.2.1.2 and 1.3.6.1.2.1.31) for this ${version === "3" ? "SNMPv3 user" : "community"}, or use the read-only login the device offers. If it cannot show interfaces at all, monitor it with Network checks (ping and ports) instead.`);
}

/** Node 17+ ships OpenSSL 3, which has single DES (SNMPv3 "des" privacy) switched off unless started with --openssl-legacy-provider. */
export function explainCrypto(message: string): string {
  return /digital envelope routines|unsupported/i.test(message) ? "DES encryption is not available in this Lumina's runtime. Choose AES on the device, or start Lumina with NODE_OPTIONS=--openssl-legacy-provider (the installer does this)." : message;
}

export interface ProbeResult { setting: string; ok: boolean; message: string }

/**
 * Tries the settings people most often mix up, one by one, with the user name and keys that were entered, and says which ones the device accepts.
 * Version 3: authentication md5 or sha, and no encryption, des or aes. Version 2c: the community as entered.
 */
export async function probeSettings(config: Config): Promise<{ results: ProbeResult[]; working: string | null; hint: string }> {
  const results: ProbeResult[] = [];
  const ask = (make: () => Obj) => new Promise<{ ok: boolean; message: string }>((resolve) => {
    let s: Obj;
    try { s = make(); } catch (e) { return resolve({ ok: false, message: e instanceof Error ? e.message : String(e) }); }
    s.on("error", () => undefined);
    const done = (r: { ok: boolean; message: string }) => { try { s.close(); } catch { /* closed */ } resolve(r); };
    s.get([OID.sysName, OID.sysDescr], (e: Error | null, vbs: Obj[]) => {
      if (e) return done({ ok: false, message: /timed out|timeout/i.test(e.message) ? "no answer (wrong keys are silently ignored by many devices, or the protocol does not match)" : explainCrypto(e.message) });
      const first = vbs.find((v) => !snmp.isVarbindError(v));
      done({ ok: true, message: first ? `answered: ${text(first.value)?.slice(0, 60)}` : "answered" });
    });
  });
  const base = { port: config.port, timeout: 3000, retries: 0 };
  if (config.version === "3") {
    for (const auth of ["md5", "sha"] as const) {
      for (const priv of ["none", "des", "aes"] as const) {
        const level = priv === "none" ? snmp.SecurityLevel.authNoPriv : snmp.SecurityLevel.authPriv;
        const r = await ask(() => snmp.createV3Session(config.host, { name: config.user, level, authProtocol: snmp.AuthProtocols[auth], authKey: config.authKey, ...(priv === "none" ? {} : { privProtocol: snmp.PrivProtocols[priv], privKey: config.privKey ?? config.authKey }) }, { ...base, version: snmp.Version3 }));
        results.push({ setting: `authentication ${auth}, ${priv === "none" ? "no encryption" : `encryption ${priv}`}`, ...r });
      }
    }
  } else {
    const r = await ask(() => snmp.createSession(config.host, config.community, { ...base, version: snmp.Version2c }));
    results.push({ setting: "version 2c with this community", ...r });
  }
  const working = results.find((r) => r.ok)?.setting ?? null;
  const denied = results.some((r) => /authorizationerror/i.test(r.message));
  const hint = working
    ? `The device answers with: ${working}. Set the instance to exactly that (Edit).`
    : denied
      ? "The device recognises the login but its access rules refuse the request (authorizationError). Check that this user may read, and that its security level matches the device's SNMP setting."
      : "No combination was accepted. Check the user name, the authentication key and the encryption key (each 8 characters or more), that SNMP is switched on at the device, and that this Lumina's address is allowed.";
  return { results, working, hint };
}

const text = (v: unknown): string | null => (v === undefined || v === null ? null : Buffer.isBuffer(v) ? v.toString("utf8").replace(/\0+$/, "") : String(v));
/** Counters come as numbers (32 bit) or 8-byte buffers (64 bit). */
export function counter(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (Buffer.isBuffer(v) && v.length > 0 && v.length <= 8) return BigInt(`0x${v.toString("hex")}`);
  return null;
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : Buffer.isBuffer(v) && v.length <= 6 && v.length > 0 ? Number(BigInt(`0x${v.toString("hex")}`)) : null);

/** Bits per second between two counter readings, allowing for the counter wrapping around. */
export function rate(prev: bigint | undefined, now: bigint | null, seconds: number, bits: 32 | 64): number | null {
  if (prev === undefined || now === null || seconds < 0.5) return null;
  let delta = now - prev;
  if (delta < 0n) delta += 1n << BigInt(bits);
  const bps = (Number(delta) * 8) / seconds;
  // A jump this big is a counter reset or a different device, not traffic.
  return Number.isFinite(bps) && bps < 1e13 ? bps : null;
}

const watchList = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const metricName = (n: string) => n.replace(/[,\s:]+/g, "_");

export default defineModule<Config>({
  id: "snmp",
  name: "Router / switch (SNMP)",
  description: "Interface status and traffic from any device that speaks SNMP: pfSense, OPNsense, OpenWrt, managed switches, firewalls, NAS boxes.",
  fields: [
    { key: "host", label: "Device address", type: "text", required: true, placeholder: "192.168.1.1" },
    { key: "port", label: "Port", type: "number", default: 161 },
    { key: "version", label: "SNMP version (2c or 3)", type: "text", default: "2c", help: "Use 3 where the device supports it: version 2c sends its community in clear text." },
    { key: "community", label: "Community (version 2c)", type: "password", help: "Often \"public\". Allow only this Lumina's address on the device." },
    { key: "user", label: "User (version 3)", type: "text" },
    { key: "authProtocol", label: "Authentication (sha, sha256, sha512, md5, none)", type: "text", default: "sha", help: "Must match the device. TP-Link Omada's default SNMPv3 mode uses md5 with no encryption (privacy none); its recommended mode adds aes or des." },
    { key: "authKey", label: "Authentication key (version 3)", type: "password" },
    { key: "privProtocol", label: "Encryption (aes, aes256b, des, none)", type: "text", default: "aes" },
    { key: "privKey", label: "Encryption key (version 3)", type: "password" },
    { key: "watch", label: "Interfaces to alert on when down", type: "text", placeholder: "igb0, wan, eth0", help: "Comma separated names, as the device calls them. Only these raise an alert when the link goes down; other interfaces are just shown." },
    { key: "hide", label: "Hide interfaces matching", type: "text", default: "^(lo|lo0|pflog\\d*|pfsync\\d*|enc\\d*|ipsec\\d*)$", help: "A pattern (regular expression) for interfaces that are only noise." },
    { key: "busyPct", label: "Warn when a link is busier than (%)", type: "number", default: 90 },
  ],
  configSchema: ConfigSchema,
  pollIntervalMs: 15_000,
  minPollIntervalMs: 5_000,
  multiInstance: true,

  async create(config) {
    const watch = new Set(watchList(config.watch).map((x) => x.toLowerCase()));
    const hide = new RegExp(config.hide);
    const { session, get, table, val } = openSession(config);

    const prev = new Map<number, { t: number; in: bigint | null; out: bigint | null; err: bigint; bits: 32 | 64 }>();
    let healthy = false;

    return {
      async poll() {
        let sys: Obj[];
        try {
          sys = (await getSystem(get, [OID.sysDescr, OID.sysUpTime, OID.sysName])) as Obj[];
        } catch (e) {
          healthy = false;
          const m = e instanceof Error ? e.message : String(e);
          throw new Error(/timeout|timed out/i.test(m) ? explainNoAnswer(await probeUdpPort(config.host, config.port), config.host, config.port, config.version) : explainCrypto(m));
        }
        let ifT: Obj, ifX: Obj;
        try {
          [ifT, ifX] = await Promise.all([
            readIfTable(table, OID.ifTable, config.host, config.port, config.version),
            table(OID.ifXTable, [1, 6, 10, 15, 18]).catch(() => ({} as Obj)),
          ]);
        } catch (e) {
          healthy = false;
          throw e;
        }
        const extra = await get([OID.load1, OID.memTotal, OID.memAvail]).catch(() => [] as Obj[]);
        healthy = true;

        const now = Date.now();
        const interfaces: Iface[] = [];
        let hiddenDown = 0;
        for (const key of Object.keys(ifT)) {
          const index = Number(key);
          const a = ifT[key] as Obj;
          const x = (ifX[key] ?? {}) as Obj;
          const name = text(x[1]) ?? text(a[2]) ?? `if${index}`;
          if (a[3] === 24 || hide.test(name)) continue; // loopback and noise
          const up = a[8] === 1;
          const watched = watch.has(name.toLowerCase());
          if (!up && !watched) { hiddenDown += 1; continue; }
          const hc = counter(x[6]) !== null;
          const bits: 32 | 64 = hc ? 64 : 32;
          const cIn = hc ? counter(x[6]) : counter(a[10]);
          const cOut = hc ? counter(x[10]) : counter(a[16]);
          const err = (counter(a[14]) ?? 0n) + (counter(a[20]) ?? 0n);
          const p = prev.get(index);
          const secs = p ? (now - p.t) / 1000 : 0;
          const same = p && p.bits === bits;
          const inBps = same ? rate(p.in ?? undefined, cIn, secs, bits) : null;
          const outBps = same ? rate(p.out ?? undefined, cOut, secs, bits) : null;
          const errPerSec = same && secs >= 0.5 ? Math.max(0, Number(err - p.err)) / secs : null;
          prev.set(index, { t: now, in: cIn, out: cOut, err, bits });
          const speedMbps = num(x[15]) || (num(a[5]) ? Math.round((num(a[5]) as number) / 1e6) : null);
          const peak = Math.max(inBps ?? 0, outBps ?? 0);
          interfaces.push({
            index, name, alias: text(x[18]) || null, up, speedMbps: speedMbps || null, inBps, outBps,
            errPerSec: errPerSec === null ? null : Math.round(errPerSec * 100) / 100, watched,
            utilPct: speedMbps && inBps !== null && outBps !== null ? Math.round((peak / (speedMbps * 1e6)) * 1000) / 10 : null,
          });
        }
        interfaces.sort((a, b) => Number(b.watched) - Number(a.watched) || a.index - b.index);
        const total = num(val(extra[1])), avail = num(val(extra[2]));
        const load = val(extra[0]);
        return {
          snmpVersion: config.version,
          sysName: text(val(sys[2])),
          sysDescr: text(val(sys[0]))?.split("\n")[0].slice(0, 200) ?? null,
          uptimeS: typeof val(sys[1]) === "number" ? Math.round((val(sys[1]) as number) / 100) : null,
          load1: load !== undefined ? Number(text(load)) || null : null,
          memUsedPct: total && avail !== null ? Math.round((1 - (avail as number) / total) * 1000) / 10 : null,
          interfaces,
          hiddenDown,
          busyPct: config.busyPct,
          watchedMissing: [...watch].filter((w) => !interfaces.some((i) => i.name.toLowerCase() === w)),
        };
      },
      async status() {
        return healthy ? "connected" : "disconnected";
      },
      alerts(d: { interfaces: Iface[]; busyPct: number; watchedMissing: string[] }) {
        const out: AlertCondition[] = [];
        for (const i of d.interfaces) {
          if (i.watched && !i.up) out.push({ key: `if-down:${i.name}`, severity: "critical", title: `Link ${i.name} is down`, detail: i.alias ?? undefined });
          if (i.up && i.utilPct !== null && i.utilPct >= d.busyPct) out.push({ key: `if-busy:${i.name}`, severity: "warning", title: `Link ${i.name} is almost full`, detail: `${i.utilPct}% of ${i.speedMbps} Mbps` });
        }
        for (const w of d.watchedMissing) out.push({ key: `if-missing:${w}`, severity: "warning", title: `Interface "${w}" was not found on the device`, detail: "Check the name under Edit" });
        return out;
      },
      metrics(d: { interfaces: Iface[]; load1: number | null; memUsedPct: number | null }) {
        const m: Record<string, number> = {};
        const base = d.interfaces.some((i) => i.watched) ? d.interfaces.filter((i) => i.watched) : d.interfaces.filter((i) => i.up);
        m["traffic:in"] = base.reduce((a, i) => a + (i.inBps ?? 0), 0);
        m["traffic:out"] = base.reduce((a, i) => a + (i.outBps ?? 0), 0);
        for (const i of d.interfaces.filter((x) => x.up).slice(0, 16)) {
          const n = metricName(i.name);
          if (i.inBps !== null) m[`if:${n}:in`] = i.inBps;
          if (i.outBps !== null) m[`if:${n}:out`] = i.outBps;
        }
        if (d.load1 !== null) m.load = d.load1;
        if (d.memUsedPct !== null) m.mem = d.memUsedPct;
        return m;
      },
      actions: [
        {
          id: "probe",
          label: "Test the SNMP settings",
          minRole: "admin",
          async run() {
            return probeSettings(config);
          },
        },
      ],
      async dispose() {
        try { session.close(); } catch { /* already closed */ }
      },
    };
  },
});
