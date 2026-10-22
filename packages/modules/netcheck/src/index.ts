import { z } from "zod";
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { defineModule, httpRequestRaw, type AlertCondition } from "@lumina/sdk";

// ---- what the user writes -------------------------------------------------------------------------------------------
// One check per line:   Name | ping | 192.168.11.1
//                       Name | tcp  | 192.168.11.131:8006
//                       Name | dns  | example.com @192.168.11.1
//                       Name | http | https://example.com

export type Kind = "ping" | "tcp" | "dns" | "http";
export interface Target { name: string; kind: Kind; target: string }

const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const isHost = (h: string) => isIP(h) !== 0 || HOST.test(h);
export const MAX_TARGETS = 40;

/** Reads the target list. Returns what could not be understood instead of guessing, so a typo is shown, not silently ignored. */
export function parseTargets(text: string): { targets: Target[]; errors: string[] } {
  const targets: Target[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const bad = (why: string) => errors.push(`line ${n + 1}: ${why}`);
    const parts = line.split("|").map((x) => x.trim());
    if (parts.length !== 3) return bad('use "Name | ping | address"');
    const [name, kindRaw, target] = parts;
    const kind = kindRaw.toLowerCase() as Kind;
    if (!name || name.length > 60) return bad("the name must be 1 to 60 characters");
    if (seen.has(name.toLowerCase())) return bad(`the name "${name}" is used twice`);
    if (!["ping", "tcp", "dns", "http"].includes(kind)) return bad(`"${kindRaw}" is not a check type (ping, tcp, dns or http)`);
    if (kind === "ping" && !isHost(target)) return bad(`"${target}" is not a host name or IP address`);
    if (kind === "tcp") {
      const m = /^(\[[0-9a-fA-F:]+\]|[^:\s]+):(\d{1,5})$/.exec(target);
      if (!m || !isHost(m[1].replace(/^\[|\]$/g, "")) || Number(m[2]) < 1 || Number(m[2]) > 65535) return bad(`"${target}" should look like host:port`);
    }
    if (kind === "dns") {
      const m = /^([^\s@]+)(?:\s+@(\S+))?$/.exec(target);
      if (!m || !HOST.test(m[1]) || (m[2] && isIP(m[2]) === 0)) return bad(`"${target}" should look like example.com or example.com @192.168.1.1`);
    }
    if (kind === "http") {
      try { const u = new URL(target); if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme"); } catch { return bad(`"${target}" is not an http(s) address`); }
    }
    seen.add(name.toLowerCase());
    targets.push({ name, kind, target });
  });
  if (targets.length === 0 && errors.length === 0) errors.push("add at least one check");
  if (targets.length > MAX_TARGETS) errors.push(`at most ${MAX_TARGETS} checks per instance`);
  return { targets, errors };
}

const ConfigSchema = z
  .object({
    targets: z.string().min(1).max(8000),
    packets: z.number().int().min(1).max(10).default(4),
    warnLatencyMs: z.number().min(1).max(60000).default(150),
    warnLossPct: z.number().min(1).max(100).default(20),
    speedTest: z.boolean().default(false),
    speedTestEveryHours: z.number().min(1).max(168).default(6),
    speedTestMB: z.number().min(1).max(200).default(25),
    speedTestDownloadUrl: z.string().url().default("https://speed.cloudflare.com/__down"),
    speedTestUploadUrl: z.string().url().default("https://speed.cloudflare.com/__up"),
    minDownMbps: z.number().min(0).max(100000).optional(),
  })
  .superRefine((c, ctx) => {
    const { errors } = parseTargets(c.targets);
    if (errors.length) ctx.addIssue({ code: "custom", path: ["targets"], message: errors.slice(0, 3).join("; ") });
  });
type Config = z.infer<typeof ConfigSchema>;

// ---- the checks -----------------------------------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  kind: Kind;
  target: string;
  ok: boolean;
  /** average round trip (ms) */
  ms: number | null;
  minMs: number | null;
  maxMs: number | null;
  jitterMs: number | null;
  lossPct: number;
  error: string | null;
}

const SLOW_TIMEOUT = 3000;

/** Parses the summary lines printed by iputils ping. */
export function parsePing(out: string): { sent: number; received: number; min: number | null; avg: number | null; max: number | null; mdev: number | null } {
  const c = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(out);
  const r = /= ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+) ms/.exec(out);
  return { sent: c ? Number(c[1]) : 0, received: c ? Number(c[2]) : 0, min: r ? Number(r[1]) : null, avg: r ? Number(r[2]) : null, max: r ? Number(r[3]) : null, mdev: r ? Number(r[4]) : null };
}

/** Why nobody answered, from what ping printed: a firewall that rejects, a host that is not there, or silence (usually a firewall that drops pings). */
export function explainNoReply(out: string): string {
  if (/Packet filtered|Prohibited|administratively|Communication.*prohibited/i.test(out)) return "Pings are rejected by a firewall";
  if (/Destination Host Unreachable|Host Unreachable/i.test(out)) return "Host unreachable (not on the network, or no route)";
  if (/Destination Net Unreachable|Network is unreachable/i.test(out)) return "No route to that network";
  return "No reply to pings (a firewall may be dropping them; a TCP check on an open port still works)";
}

function pingHost(host: string, packets: number): Promise<{ result: ReturnType<typeof parsePing> | null; blocked: boolean; error: string | null; text: string }> {
  return new Promise((resolve) => {
    // The host was validated (no leading dash, no spaces), and "--" keeps it from ever being read as an option.
    execFile("ping", ["-n", "-c", String(packets), "-i", "0.3", "-W", "1", "--", host], { timeout: (packets + 6) * 1000 }, (err, stdout, stderr) => {
      const text = `${stdout}\n${stderr}`;
      if (/Operation not permitted|cap_net_raw|permission denied/i.test(text)) return resolve({ result: null, blocked: true, error: "The Lumina service is not allowed to send pings", text });
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return resolve({ result: null, blocked: true, error: "The ping program is not installed", text });
      const result = parsePing(text);
      if (result.sent === 0) return resolve({ result: null, blocked: false, error: /name or service not known|temporary failure/i.test(text) ? "Name could not be resolved" : explainNoReply(text), text });
      resolve({ result, blocked: false, error: null, text });
    });
  });
}

function tcpCheck(host: string, port: number): Promise<{ ms: number | null; error: string | null }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const s = connect({ host, port, timeout: SLOW_TIMEOUT });
    const done = (ms: number | null, error: string | null) => { s.destroy(); resolve({ ms, error }); };
    s.once("connect", () => done(performance.now() - t0, null));
    s.once("timeout", () => done(null, "Timed out"));
    s.once("error", (e) => done(null, (e as NodeJS.ErrnoException).code === "ECONNREFUSED" ? "Connection refused" : e.message));
  });
}

async function dnsCheck(spec: string): Promise<{ ms: number | null; error: string | null }> {
  const m = /^(\S+)(?:\s+@(\S+))?$/.exec(spec)!;
  const resolver = new Resolver({ timeout: SLOW_TIMEOUT, tries: 1 });
  if (m[2]) resolver.setServers([m[2]]);
  const t0 = performance.now();
  try {
    await Promise.any([resolver.resolve4(m[1]), resolver.resolve6(m[1])]);
    return { ms: performance.now() - t0, error: null };
  } catch (e) {
    const err = (e as AggregateError).errors?.[0] ?? e;
    return { ms: null, error: (err as NodeJS.ErrnoException).code === "ENOTFOUND" ? "Name not found" : (err as Error).message };
  }
}

async function httpCheck(url: string): Promise<{ ms: number | null; error: string | null }> {
  const t0 = performance.now();
  try {
    const res = await httpRequestRaw(url, { timeoutMs: 6000, headers: { accept: "*/*" } });
    return res.status < 400 ? { ms: performance.now() - t0, error: null } : { ms: null, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ms: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- speed test (optional, talks to the URLs you configure) ---------------------------------------------------------

export interface SpeedResult { at: number; downMbps: number | null; upMbps: number | null; latencyMs: number | null; error: string | null }

async function speedTest(c: Config): Promise<SpeedResult> {
  const out: SpeedResult = { at: Date.now(), downMbps: null, upMbps: null, latencyMs: null, error: null };
  const bytes = c.speedTestMB * 1_000_000;
  try {
    const url = new URL(c.speedTestDownloadUrl);
    url.searchParams.set("bytes", String(bytes));
    const t0 = performance.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok || !res.body) throw new Error(`download answered HTTP ${res.status}`);
    let first = 0, got = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (!first) first = performance.now();
      got += chunk.length;
    }
    const secs = (performance.now() - (first || t0)) / 1000;
    out.latencyMs = Math.round(first - t0);
    if (secs > 0.001 && got > 1_000_000) out.downMbps = Math.round(((got * 8) / secs / 1e6) * 10) / 10;
  } catch (e) {
    out.error = `Download test failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  try {
    const up = Buffer.alloc(Math.min(bytes, 10_000_000), 0x61);
    const t0 = performance.now();
    const res = await fetch(c.speedTestUploadUrl, { method: "POST", body: up, signal: AbortSignal.timeout(45_000), headers: { "content-type": "application/octet-stream" } });
    await res.arrayBuffer();
    if (!res.ok) throw new Error(`upload answered HTTP ${res.status}`);
    const secs = (performance.now() - t0) / 1000;
    if (secs > 0.001) out.upMbps = Math.round(((up.length * 8) / secs / 1e6) * 10) / 10;
  } catch (e) {
    out.error ??= `Upload test failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  return out;
}

// ---- the module ------------------------------------------------------------------------------------------------------

const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
const metricName = (n: string) => n.replace(/[,\s]+/g, " ").trim();

export default defineModule<Config>({
  id: "netcheck",
  name: "Network checks",
  description: "Ping, TCP port, DNS and web checks with latency and packet loss history, plus an optional internet speed test.",
  fields: [
    {
      key: "targets",
      label: "Checks (one per line)",
      type: "textarea",
      required: true,
      placeholder: "Gateway | ping | 192.168.1.1\nInternet | ping | 1.1.1.1\nDNS | dns | example.com @192.168.1.1\nProxmox web | tcp | 192.168.1.10:8006\nSite | http | https://example.com",
      help: "Format: Name | ping, tcp, dns or http | address. Lines starting with # are ignored.",
    },
    { key: "packets", label: "Pings per check", type: "number", default: 4, help: "More pings give a finer packet-loss figure." },
    { key: "warnLatencyMs", label: "Warn when slower than (ms)", type: "number", default: 150 },
    { key: "warnLossPct", label: "Warn when packet loss is at least (%)", type: "number", default: 20 },
    { key: "speedTest", label: "Run internet speed tests", type: "boolean", default: false, help: "Off by default. When on, Lumina downloads and uploads test data to the addresses below, which uses your internet connection and tells that service your address." },
    { key: "speedTestEveryHours", label: "Speed test every (hours)", type: "number", default: 6 },
    { key: "speedTestMB", label: "Test size (MB)", type: "number", default: 25 },
    { key: "speedTestDownloadUrl", label: "Download test address", type: "text", default: "https://speed.cloudflare.com/__down" },
    { key: "speedTestUploadUrl", label: "Upload test address", type: "text", default: "https://speed.cloudflare.com/__up" },
    { key: "minDownMbps", label: "Warn when download is below (Mbit/s)", type: "number", help: "Optional, for example 80% of what you pay for." },
  ],
  configSchema: ConfigSchema,
  pollIntervalMs: 30_000,
  minPollIntervalMs: 10_000,
  multiInstance: true,

  async create(config, ctx) {
    const { targets } = parseTargets(config.targets);
    let healthy = false;
    let icmpBlocked = false;
    const recent = new Map<string, number[]>();
    let speed: SpeedResult | null = null;
    let speedRunning = false;
    let nextSpeedAt = config.speedTest ? Date.now() + 120_000 : Infinity;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function runSpeed(): Promise<SpeedResult> {
      if (speedRunning) throw new Error("A speed test is already running");
      speedRunning = true;
      try {
        ctx.log.info("speed test starting");
        speed = await speedTest(config);
        return speed;
      } finally {
        speedRunning = false;
        nextSpeedAt = Date.now() + config.speedTestEveryHours * 3600_000;
      }
    }

    async function runOne(t: Target): Promise<CheckResult> {
      const base = { name: t.name, kind: t.kind, target: t.target, ms: null as number | null, minMs: null as number | null, maxMs: null as number | null, jitterMs: null as number | null, lossPct: 0, error: null as string | null };
      if (t.kind === "ping") {
        const p = await pingHost(t.target, config.packets);
        if (p.blocked) icmpBlocked = true;
        if (!p.result) return { ...base, ok: false, lossPct: 100, error: p.error };
        const loss = p.result.sent ? Math.round(((p.result.sent - p.result.received) / p.result.sent) * 1000) / 10 : 100;
        return { ...base, ok: p.result.received > 0, ms: round1(p.result.avg), minMs: round1(p.result.min), maxMs: round1(p.result.max), jitterMs: round1(p.result.mdev), lossPct: loss, error: p.result.received > 0 ? null : explainNoReply(p.text) };
      }
      const r = t.kind === "tcp" ? await (() => { const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(t.target)!; return tcpCheck(m[1].replace(/^\[|\]$/g, ""), Number(m[2])); })() : t.kind === "dns" ? await dnsCheck(t.target) : await httpCheck(t.target);
      return { ...base, ok: r.error === null, ms: round1(r.ms), lossPct: r.error === null ? 0 : 100, error: r.error };
    }

    return {
      async poll() {
        const results: CheckResult[] = [];
        // A handful at a time, so 40 checks never open 40 sockets and ping processes at once.
        for (let i = 0; i < targets.length; i += 8) results.push(...(await Promise.all(targets.slice(i, i + 8).map(runOne))));
        healthy = true;
        for (const r of results) {
          const list = recent.get(r.name) ?? [];
          list.push(r.lossPct);
          if (list.length > 20) list.shift();
          recent.set(r.name, list);
        }
        if (Date.now() >= nextSpeedAt && !speedRunning) void runSpeed().catch((e) => ctx.log.warn("speed test failed", e));
        const withRecent = results.map((r) => ({ ...r, recentLossPct: round1((recent.get(r.name) ?? [r.lossPct]).reduce((a, b) => a + b, 0) / (recent.get(r.name)?.length ?? 1)) }));
        const ok = results.filter((r) => r.ok);
        const times = ok.map((r) => r.ms).filter((x): x is number => x !== null);
        return {
          targets: withRecent,
          speed,
          speedRunning,
          speedEnabled: config.speedTest,
          icmpBlocked,
          warn: { latencyMs: config.warnLatencyMs, lossPct: config.warnLossPct, minDownMbps: config.minDownMbps ?? null },
          summary: { up: ok.length, down: results.length - ok.length, avgMs: times.length ? round1(times.reduce((a, b) => a + b, 0) / times.length) : null, avgLossPct: results.length ? round1(results.reduce((a, r) => a + r.lossPct, 0) / results.length) : 0 },
        };
      },
      async status() {
        return healthy ? "connected" : "disconnected";
      },
      alerts(d: { targets: (CheckResult & { recentLossPct: number })[]; speed: SpeedResult | null; warn: { latencyMs: number; lossPct: number; minDownMbps: number | null }; icmpBlocked: boolean }) {
        const out: AlertCondition[] = [];
        for (const t of d.targets) {
          const label = `${t.name} (${t.target})`;
          if (!t.ok) out.push({ key: `check-down:${t.name}`, severity: "critical", title: `${t.name} is not responding`, detail: `${t.kind} ${t.target}${t.error ? ` · ${t.error}` : ""}` });
          else {
            if (t.lossPct >= d.warn.lossPct) out.push({ key: `check-loss:${t.name}`, severity: "warning", title: `${t.name} is losing packets`, detail: `${t.lossPct}% lost to ${t.target}` });
            if (t.ms !== null && t.ms >= d.warn.latencyMs) out.push({ key: `check-slow:${t.name}`, severity: "warning", title: `${t.name} is slow`, detail: `${t.ms} ms to ${label}` });
          }
        }
        if (d.speed && d.warn.minDownMbps !== null && d.speed.downMbps !== null && d.speed.downMbps < d.warn.minDownMbps) {
          out.push({ key: "speed-low", severity: "warning", title: "Internet download speed is low", detail: `${d.speed.downMbps} Mbps (limit ${d.warn.minDownMbps} Mbps)` });
        }
        return out;
      },
      metrics(d: { targets: CheckResult[]; speed: SpeedResult | null; summary: { up: number; down: number; avgMs: number | null } }) {
        const m: Record<string, number> = { "net:up": d.summary.up, "net:down": d.summary.down };
        if (d.summary.avgMs !== null) m["rtt:avg"] = d.summary.avgMs;
        for (const t of d.targets) {
          const n = metricName(t.name);
          if (t.ms !== null) m[`rtt:${n}`] = t.ms;
          m[`loss:${n}`] = t.lossPct;
        }
        if (d.speed?.downMbps != null) m["speed:down"] = d.speed.downMbps;
        if (d.speed?.upMbps != null) m["speed:up"] = d.speed.upMbps;
        if (d.speed?.latencyMs != null) m["speed:latency"] = d.speed.latencyMs;
        return m;
      },
      actions: [
        {
          id: "speedtest",
          label: "Run speed test now",
          schedulable: false,
          async run() {
            if (!config.speedTest) throw new Error("Speed tests are switched off for this instance. Turn them on under Edit.");
            return runSpeed();
          },
        },
      ],
      async dispose() {
        if (timer) clearTimeout(timer);
      },
    };
  },
});
