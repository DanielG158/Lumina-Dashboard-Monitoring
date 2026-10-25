import { z } from "zod";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { TLSSocket } from "node:tls";
import { defineModule, httpRequestRaw, type AlertCondition } from "@lumina/sdk";

const ConfigSchema = z.object({
  apiToken: z.string().min(1),
  accountId: z.string().min(1),
  zoneId: z.string().optional(),
  extraHostnames: z.string().optional(),
  dynamicDns: z.string().optional(),
});
type Config = z.infer<typeof ConfigSchema>;

const API = "https://api.cloudflare.com/client/v4";
const HOST_TTL_MS = 5 * 60_000;
const MAX_HOSTS = 40;
const FLAP_WINDOW_MS = 15 * 60_000;
const FLAP_BUCKET_MS = 2 * 60_000;
const FLAP_BUCKETS = 3;

interface Ingress {
  hostname?: string;
  service: string;
  path?: string;
  originRequest?: unknown;
}
interface TunnelConfig {
  ingress?: Ingress[];
  [key: string]: unknown;
}
interface Tunnel {
  id: string;
  name: string;
  status: string;
  config_src?: string;
  conns_active_at?: string | null;
  connections?: { colo_name?: string; is_pending_reconnect?: boolean; uuid?: string; id?: string; opened_at?: string }[];
}
interface DnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
}

export interface HostCheck {
  name: string;
  source: "tunnel" | "dns" | "extra";
  pending?: boolean;
  dns?: { ok: boolean; addresses: string[]; error?: string };
  https?: { ok: boolean; status?: number; ms?: number; error?: string };
  cert?: { daysLeft: number; validTo: string; trusted: boolean } | null;
  checkedAt?: number;
}

/** Looks a public hostname up, asks it for its home page over HTTPS (HEAD, no redirects) and reads the certificate it presents. */
export async function checkHostname(name: string, opts: { port?: number; timeoutMs?: number } = {}): Promise<Pick<HostCheck, "name" | "dns" | "https" | "cert" | "checkedAt">> {
  let dns: NonNullable<HostCheck["dns"]>;
  try {
    const addresses = (await lookup(name, { all: true })).map((a) => a.address);
    dns = { ok: addresses.length > 0, addresses };
  } catch (e) {
    dns = { ok: false, addresses: [], error: (e as NodeJS.ErrnoException).code ?? "lookup failed" };
  }
  if (!dns.ok) return { name, dns, https: { ok: false, error: "not resolved" }, cert: null, checkedAt: Date.now() };
  const start = Date.now();
  const r = await new Promise<{ https: NonNullable<HostCheck["https"]>; cert: HostCheck["cert"] }>((resolve) => {
    let done = false;
    const finish = (v: { https: NonNullable<HostCheck["https"]>; cert: HostCheck["cert"] }) => { if (!done) { done = true; resolve(v); } };
    const req = httpsRequest(
      { host: name, port: opts.port ?? 443, method: "HEAD", path: "/", servername: name, rejectUnauthorized: false, timeout: opts.timeoutMs ?? 6000, headers: { "user-agent": "Lumina-Monitor" } },
      (res) => {
        const sock = res.socket as TLSSocket;
        const c = sock.getPeerCertificate();
        const cert = c?.valid_to ? { daysLeft: Math.floor((Date.parse(c.valid_to) - Date.now()) / 86_400_000), validTo: new Date(c.valid_to).toISOString(), trusted: sock.authorized } : null;
        finish({ https: { ok: true, status: res.statusCode, ms: Date.now() - start }, cert });
        res.resume();
        req.destroy();
      },
    );
    req.on("timeout", () => { finish({ https: { ok: false, error: "timed out" }, cert: null }); req.destroy(); });
    req.on("error", (e) => finish({ https: { ok: false, error: (e as NodeJS.ErrnoException).code ?? e.message }, cert: null }));
    req.end();
  });
  return { name, dns, ...r, checkedAt: Date.now() };
}

/** How many separate stretches of the last 15 minutes saw new tunnel connections appear. One restart is one stretch; a flapping tunnel keeps producing them. */
export function churnBuckets(events: number[], now = Date.now()): number {
  return new Set(events.filter((t) => now - t < FLAP_WINDOW_MS).map((t) => Math.floor(t / FLAP_BUCKET_MS))).size;
}

function cached<T>(ttlMs: number, load: () => Promise<T>) {
  let at = 0;
  let value: T | undefined;
  let error: string | undefined;
  let inflight: Promise<void> | null = null;
  return {
    async get(): Promise<{ value?: T; error?: string }> {
      if (Date.now() - at >= ttlMs) {
        inflight ??= load()
          .then((v) => { value = v; error = undefined; })
          .catch((e) => { error = e instanceof Error ? e.message : String(e); })
          .finally(() => { at = Date.now(); inflight = null; });
        await inflight;
      }
      return { value, error };
    },
    reset() { at = 0; },
  };
}

const lines = (text?: string) => (text ?? "").split(/[\n,]/).map((l) => l.trim().toLowerCase()).filter(Boolean);

interface PollData {
  tunnels: { name: string; status: string; connections: number; churn?: number }[];
  hostnames?: HostCheck[];
  access?: { denied1h: number } | null;
  ddns?: { hosts: { name: string; status: string; detail: string }[] } | null;
}

export default defineModule<Config>({
  id: "cloudflare",
  name: "Cloudflare Tunnels",
  description: "Tunnel status and public hostname management via the Cloudflare API.",
  fields: [
    {
      key: "apiToken",
      label: "API token",
      type: "password",
      required: true,
      help: "Permissions: Account → Cloudflare Tunnel → Edit (add Zone → DNS → Edit to manage DNS records)",
    },
    { key: "accountId", label: "Account ID", type: "text", required: true },
    {
      key: "zoneId",
      label: "Zone ID (optional)",
      type: "text",
      help: "If set, adding/removing a hostname also creates/deletes its proxied CNAME record, and the DNS records of the zone are listed and can be edited. Needs Zone, DNS, Edit on the token.",
    },
    {
      key: "extraHostnames",
      label: "Other hostnames to check (optional)",
      type: "textarea",
      help: "One per line. Lumina already checks the public hostnames of your tunnels and the proxied records of the zone; add any others here.",
    },
    {
      key: "dynamicDns",
      label: "Keep these pointed at this network's public IP (optional)",
      type: "textarea",
      help: "One hostname per line. Each needs an existing A (or AAAA) record in the zone; Lumina rewrites it when this network's public IP changes. Leave empty to switch this off.",
    },
  ],
  configSchema: ConfigSchema,
  pollIntervalMs: 30_000,
  minPollIntervalMs: 10_000,
  multiInstance: true,

  async create(config, ctx) {
    let healthy = false;
    // Test hooks only: point the module at a fake API and a local HTTPS port. Never set in production.
    const base = process.env.LUMINA_CLOUDFLARE_API ?? API;
    const checkPort = process.env.LUMINA_CLOUDFLARE_CHECK_PORT ? Number(process.env.LUMINA_CLOUDFLARE_CHECK_PORT) : undefined;

    async function cf<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await httpRequestRaw(`${base}${path}`, {
        method,
        body,
        headers: { authorization: `Bearer ${config.apiToken}` },
        timeoutMs: 15_000,
      });
      let json: { success?: boolean; result?: T; errors?: { message: string }[] } | null = null;
      try {
        json = JSON.parse(res.body);
      } catch {
        /* non-JSON error body */
      }
      if (res.status >= 400 || !json?.success) {
        const msg = json?.errors?.[0]?.message ?? `${res.status} ${res.statusText}`.trim();
        throw new Error(`Cloudflare: ${msg}`);
      }
      return json.result as T;
    }

    const tunnelPath = (id: string) => `/accounts/${config.accountId}/cfd_tunnel/${encodeURIComponent(id)}`;

    async function getConfig(tunnelId: string): Promise<TunnelConfig> {
      const r = await cf<{ config?: TunnelConfig | null }>("GET", `${tunnelPath(tunnelId)}/configurations`);
      return r.config ?? {};
    }

    async function updateIngress(tunnelId: string, edit: (rules: Ingress[]) => Ingress[]) {
      const current = await getConfig(tunnelId);
      const all = current.ingress ?? [];
      const rules = all.filter((r) => r.hostname);
      const catchAll = all.find((r) => !r.hostname) ?? { service: "http_status:404" };
      await cf("PUT", `${tunnelPath(tunnelId)}/configurations`, {
        config: { ...current, ingress: [...edit(rules), catchAll] },
      });
    }

    const cname = (tunnelId: string) => `${tunnelId}.cfargotunnel.com`;

    async function addDns(hostname: string, tunnelId: string) {
      if (!config.zoneId) return "DNS not managed (no zone ID configured)";
      try {
        await cf("POST", `/zones/${config.zoneId}/dns_records`, {
          type: "CNAME",
          name: hostname,
          content: cname(tunnelId),
          proxied: true,
        });
        return "DNS record created";
      } catch (err) {
        return `DNS record not created: ${err instanceof Error ? err.message : err}`;
      }
    }

    async function removeDns(hostname: string) {
      if (!config.zoneId) return "DNS not managed (no zone ID configured)";
      try {
        const records = await cf<DnsRecord[]>(
          "GET",
          `/zones/${config.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
        );
        const mine = records.filter((r) => r.content.endsWith(".cfargotunnel.com"));
        for (const r of mine) await cf("DELETE", `/zones/${config.zoneId}/dns_records/${r.id}`);
        return mine.length ? "DNS record deleted" : "No matching DNS record";
      } catch (err) {
        return `DNS record not deleted: ${err instanceof Error ? err.message : err}`;
      }
    }

    const Target = z.object({ tunnelId: z.string().min(1), hostname: z.string().min(1) });
    const Route = Target.extend({ service: z.string().min(1) });
    const clean = <T extends { hostname: string }>(v: T) => ({ ...v, hostname: v.hostname.trim().toLowerCase() });

    const zoneId = config.zoneId?.trim() || undefined;
    const extras = lines(config.extraHostnames);
    const ddnsNames = lines(config.dynamicDns);

    // ---- optional sections: each has its own cache and its own error, so one missing permission never breaks the rest ----
    const zoneInfo = cached(3_600_000, async () => (await cf<{ name: string }>("GET", `/zones/${zoneId}`)).name);
    const records = cached(60_000, async () => {
      const list = await cf<DnsRecord[]>("GET", `/zones/${zoneId}/dns_records?per_page=500`);
      return list.map((r) => ({ id: r.id, type: r.type, name: r.name.toLowerCase(), content: r.content, proxied: Boolean(r.proxied), ttl: r.ttl ?? 1, tunnel: r.content.endsWith(".cfargotunnel.com") }));
    });
    const analytics = cached(5 * 60_000, async () => {
      const since = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
      const res = await httpRequestRaw(`${base}/graphql`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiToken}` },
        timeoutMs: 15_000,
        body: {
          query: "query($zone:String!,$since:Date!){viewer{zones(filter:{zoneTag:$zone}){httpRequests1dGroups(limit:10,filter:{date_geq:$since},orderBy:[date_ASC]){dimensions{date} sum{requests bytes cachedRequests cachedBytes threats}}}}}",
          variables: { zone: zoneId, since },
        },
      });
      const j = JSON.parse(res.body) as { data?: { viewer?: { zones?: { httpRequests1dGroups?: { dimensions: { date: string }; sum: Record<string, number> }[] }[] } }; errors?: { message: string }[] };
      if (j.errors?.length) throw new Error(`Cloudflare: ${j.errors[0].message}`);
      const groups = j.data?.viewer?.zones?.[0]?.httpRequests1dGroups ?? [];
      return groups.map((g) => ({ date: g.dimensions.date, requests: g.sum.requests ?? 0, bytes: g.sum.bytes ?? 0, cachedRequests: g.sum.cachedRequests ?? 0, cachedBytes: g.sum.cachedBytes ?? 0, threats: g.sum.threats ?? 0 }));
    });
    const access = cached(2 * 60_000, async () => {
      const list = await cf<{ created_at: string; user_email?: string; app_domain?: string; allowed?: boolean; ip_address?: string; action?: string }[]>("GET", `/accounts/${config.accountId}/access/logs/access_requests?limit=50&direction=desc`);
      return list.map((e) => ({ at: Date.parse(e.created_at) || 0, email: e.user_email ?? "", app: e.app_domain ?? "", allowed: Boolean(e.allowed), ip: e.ip_address ?? "", action: e.action ?? "" }));
    });
    const publicIp = cached(120_000, async () => {
      const res = await httpRequestRaw(`${base.replace(/\/client\/v4$/, "")}/cdn-cgi/trace`, { timeoutMs: 8000 });
      const ip = /^ip=(.+)$/m.exec(res.body)?.[1]?.trim() ?? "";
      if (!isIP(ip)) throw new Error("could not read this network's public IP");
      return ip;
    });

    // ---- hostname checks run in the background; a poll waits for them only briefly ----
    const hostCache = new Map<string, Omit<HostCheck, "source">>();
    let hostRun: Promise<void> | null = null;
    let hostAt = 0;
    function refreshHosts(list: { name: string; source: HostCheck["source"] }[]) {
      const stale = Date.now() - hostAt >= HOST_TTL_MS || list.some((h) => !hostCache.has(h.name));
      if (hostRun || !stale || !list.length) return hostRun;
      hostRun = (async () => {
        const queue = [...list];
        await Promise.all(Array.from({ length: 5 }, async () => {
          for (let h = queue.shift(); h; h = queue.shift()) hostCache.set(h.name, await checkHostname(h.name, { port: checkPort }));
        }));
        hostAt = Date.now();
      })().finally(() => { hostRun = null; });
      return hostRun;
    }

    // ---- reconnect tracking ----
    const seen = new Map<string, { ids: Set<string>; events: number[] }>();
    function churn(t: Tunnel): number {
      const now = Date.now();
      const ids = new Set((t.connections ?? []).map((c) => c.uuid ?? c.id ?? `${c.colo_name}:${c.opened_at ?? ""}`));
      const prev = seen.get(t.id);
      if (!prev) { seen.set(t.id, { ids, events: [] }); return 0; }
      if ([...ids].some((id) => !prev.ids.has(id))) prev.events.push(now);
      prev.ids = ids;
      prev.events = prev.events.filter((e) => now - e < FLAP_WINDOW_MS);
      return churnBuckets(prev.events, now);
    }

    interface DdnsHost { name: string; status: "ok" | "updated" | "missing" | "error"; detail: string }
    async function runDdns(list: { id: string; type: string; name: string; content: string }[], ip: string): Promise<DdnsHost[]> {
      const type = ip.includes(":") ? "AAAA" : "A";
      const out: DdnsHost[] = [];
      for (const name of ddnsNames) {
        const rec = list.find((r) => r.type === type && r.name === name);
        if (!rec) { out.push({ name, status: "missing", detail: `No ${type} record named ${name} in this zone. Add it under DNS records first.` }); continue; }
        if (rec.content === ip) { out.push({ name, status: "ok", detail: "Already points at this network" }); continue; }
        try {
          await cf("PATCH", `/zones/${zoneId}/dns_records/${rec.id}`, { content: ip });
          ctx.log.info(`dynamic DNS: ${name} ${rec.content} -> ${ip}`);
          records.reset();
          out.push({ name, status: "updated", detail: `Changed from ${rec.content}` });
        } catch (err) {
          out.push({ name, status: "error", detail: err instanceof Error ? err.message : String(err) });
        }
      }
      return out;
    }

    const needZone = () => { if (!zoneId) throw new Error("Set the Zone ID on this instance first"); return zoneId; };
    const DnsFields = z.object({
      type: z.enum(["A", "AAAA", "CNAME", "TXT"]),
      name: z.string().trim().min(1).max(253),
      content: z.string().trim().min(1).max(2048),
      proxied: z.boolean().optional(),
      ttl: z.number().int().min(1).max(86_400).optional(),
    }).superRefine((v, c) => {
      if (v.type === "A" && isIP(v.content) !== 4) c.addIssue({ code: "custom", path: ["content"], message: "An A record needs an IPv4 address" });
      if (v.type === "AAAA" && isIP(v.content) !== 6) c.addIssue({ code: "custom", path: ["content"], message: "An AAAA record needs an IPv6 address" });
    });
    const DnsEdit = z.object({ id: z.string().min(1), content: z.string().trim().min(1).max(2048).optional(), proxied: z.boolean().optional() });
    const DnsRemove = z.object({ id: z.string().min(1) });

    return {
      async poll() {
        let tunnels: Tunnel[];
        try {
          tunnels = await cf<Tunnel[]>("GET", `/accounts/${config.accountId}/cfd_tunnel?is_deleted=false`);
          healthy = true;
        } catch (err) {
          healthy = false;
          throw err;
        }
        const notes: Record<string, string> = {};
        const tunnelData = await Promise.all(
          tunnels.map(async (t) => {
            const remoteManaged = t.config_src === "cloudflare";
            let ingress: Ingress[] = [];
            if (remoteManaged) {
              try {
                ingress = (await getConfig(t.id)).ingress ?? [];
              } catch (err) {
                ctx.log.warn(`could not read config for tunnel ${t.name}`, err);
              }
            }
            return {
              id: t.id,
              name: t.name,
              status: t.status,
              remoteManaged,
              connections: t.connections?.length ?? 0,
              pendingReconnect: (t.connections ?? []).filter((c) => c.is_pending_reconnect).length,
              churn: churn(t),
              colos: [...new Set((t.connections ?? []).map((c) => c.colo_name).filter(Boolean))],
              ingress: ingress.map((r) => ({ hostname: r.hostname ?? null, service: r.service, path: r.path ?? null })),
            };
          }),
        );

        let zone: { id: string; name: string | null } | null = null;
        let recs: Awaited<ReturnType<typeof records.get>>["value"] | null = null;
        let stats: Awaited<ReturnType<typeof analytics.get>>["value"] | null = null;
        let ddns: { ip: string | null; hosts: DdnsHost[] } | null = null;
        if (zoneId) {
          const [z, r, an] = await Promise.all([zoneInfo.get(), records.get(), analytics.get()]);
          zone = { id: zoneId, name: z.value ?? null };
          recs = r.value ?? null;
          stats = an.value ?? null;
          if (r.error) notes.records = r.error;
          if (an.error) notes.analytics = an.error;
          if (ddnsNames.length) {
            const ip = await publicIp.get();
            if (ip.error || !ip.value) { notes.ddns = ip.error ?? "no public IP"; ddns = { ip: null, hosts: [] }; }
            else if (recs) ddns = { ip: ip.value, hosts: await runDdns(recs, ip.value) };
            else ddns = { ip: ip.value, hosts: [] };
          }
        } else if (ddnsNames.length) notes.ddns = "Dynamic DNS needs the Zone ID";
        const acc = await access.get();
        if (acc.error) notes.access = acc.error;

        // hostnames to watch: tunnel hostnames, tunnel/proxied DNS records, then the ones typed in
        const wanted = new Map<string, HostCheck["source"]>();
        const add = (name: string | null | undefined, source: HostCheck["source"]) => {
          const n = (name ?? "").toLowerCase();
          if (n && !n.includes("*") && !wanted.has(n)) wanted.set(n, source);
        };
        for (const t of tunnelData) for (const r of t.ingress) add(r.hostname, "tunnel");
        for (const r of recs ?? []) if (r.tunnel) add(r.name, "tunnel");
        for (const r of recs ?? []) if (r.proxied && ["A", "AAAA", "CNAME"].includes(r.type)) add(r.name, "dns");
        for (const e of extras) add(e, "extra");
        const list = [...wanted].slice(0, MAX_HOSTS).map(([name, source]) => ({ name, source }));
        const run = refreshHosts(list);
        if (run) await Promise.race([run, new Promise((r) => setTimeout(r, 2500))]);
        const hostnames: HostCheck[] = list.map((h) => ({ ...(hostCache.get(h.name) ?? { name: h.name, pending: true }), source: h.source }));

        return {
          dnsManaged: Boolean(zoneId),
          tunnels: tunnelData,
          zone,
          records: recs,
          hostnames,
          analytics: stats,
          access: acc.value ? { entries: acc.value.slice(0, 20), denied1h: acc.value.filter((e) => !e.allowed && Date.now() - e.at < 3_600_000).length } : null,
          ddns,
          notes,
        };
      },
      async status() {
        return healthy ? "connected" : "disconnected";
      },
      alerts(d: PollData) {
        const out: AlertCondition[] = [];
        for (const t of d.tunnels) {
          if (t.status === "down") out.push({ key: `tunnel:${t.name}`, severity: "critical", title: `Tunnel ${t.name} is down`, detail: "No active connections to Cloudflare" });
          else if (t.status === "degraded") out.push({ key: `tunnel:${t.name}`, severity: "warning", title: `Tunnel ${t.name} is degraded`, detail: `${t.connections} connection(s)` });
          if ((t.churn ?? 0) >= FLAP_BUCKETS) out.push({ key: `flap:${t.name}`, severity: "warning", title: `Tunnel ${t.name} keeps reconnecting`, detail: `New connections appeared in ${t.churn} separate stretches of the last 15 minutes. Check the network and cloudflared on that machine.` });
        }
        for (const h of d.hostnames ?? []) {
          if (h.pending || !h.dns) continue;
          if (!h.dns.ok) out.push({ key: `host-dns:${h.name}`, severity: "warning", title: `${h.name} does not resolve`, detail: `DNS lookup failed (${h.dns.error ?? "no answer"})` });
          else if (!h.https?.ok) out.push({ key: `host-down:${h.name}`, severity: "critical", title: `${h.name} is not answering`, detail: `HTTPS failed (${h.https?.error ?? "no answer"})` });
          else if ((h.https.status ?? 0) >= 500) out.push({ key: `host-down:${h.name}`, severity: "warning", title: `${h.name} answers with an error`, detail: `HTTP ${h.https.status}. Cloudflare reaches the tunnel but the service behind it fails.` });
          if (h.cert && h.cert.daysLeft <= 14) {
            out.push({
              key: `cert:${h.name}`,
              severity: h.cert.daysLeft <= 3 ? "critical" : "warning",
              title: h.cert.daysLeft < 0 ? `Certificate of ${h.name} has expired` : `Certificate of ${h.name} expires in ${h.cert.daysLeft} day${h.cert.daysLeft === 1 ? "" : "s"}`,
              detail: `Valid until ${h.cert.validTo.slice(0, 10)}`,
            });
          }
        }
        for (const h of d.ddns?.hosts ?? []) if (h.status === "error" || h.status === "missing") out.push({ key: `ddns:${h.name}`, severity: "warning", title: `Dynamic DNS for ${h.name} is not working`, detail: h.detail });
        if (d.access && d.access.denied1h >= 10) out.push({ key: "access-denied", severity: "warning", title: `${d.access.denied1h} refused Cloudflare Access logins in the last hour`, detail: "Someone may be guessing at a protected application" });
        return out;
      },
      metrics(d: PollData) {
        const m: Record<string, number> = {
          "tunnels:healthy": d.tunnels.filter((t) => t.status === "healthy").length,
          "tunnels:total": d.tunnels.length,
        };
        for (const t of d.tunnels) m[`connections:${t.name}`] = t.connections;
        const checked = (d.hostnames ?? []).filter((h) => !h.pending && h.dns);
        if (checked.length) {
          m["hostnames:up"] = checked.filter((h) => h.dns?.ok && h.https?.ok && (h.https.status ?? 0) < 500).length;
          m["hostnames:total"] = checked.length;
          const days = checked.map((h) => h.cert?.daysLeft).filter((x): x is number => typeof x === "number");
          if (days.length) m["cert:min-days"] = Math.min(...days);
        }
        if (d.access) m["access:denied1h"] = d.access.denied1h;
        return m;
      },
      actions: [
        {
          id: "add-endpoint",
          label: "Add public hostname",
          minRole: "admin" as const,
          input: Route,
          async run(raw) {
            const { tunnelId, hostname, service } = clean(raw);
            await updateIngress(tunnelId, (rules) => {
              if (rules.some((r) => r.hostname === hostname)) throw new Error(`${hostname} already exists on this tunnel`);
              return [...rules, { hostname, service }];
            });
            return { dns: await addDns(hostname, tunnelId) };
          },
        },
        {
          id: "edit-endpoint",
          label: "Edit public hostname",
          minRole: "admin" as const,
          input: Route,
          async run(raw) {
            const { tunnelId, hostname, service } = clean(raw);
            await updateIngress(tunnelId, (rules) => {
              if (!rules.some((r) => r.hostname === hostname)) throw new Error(`${hostname} not found on this tunnel`);
              return rules.map((r) => (r.hostname === hostname ? { ...r, service } : r));
            });
            return {};
          },
        },
        {
          id: "remove-endpoint",
          label: "Remove public hostname",
          minRole: "admin" as const,
          dangerous: true,
          input: Target,
          async run(raw) {
            const { tunnelId, hostname } = clean(raw);
            await updateIngress(tunnelId, (rules) => {
              if (!rules.some((r) => r.hostname === hostname)) throw new Error(`${hostname} not found on this tunnel`);
              return rules.filter((r) => r.hostname !== hostname);
            });
            return { dns: await removeDns(hostname) };
          },
        },
        {
          id: "dns-add",
          label: "Add DNS record",
          minRole: "admin" as const,
          input: DnsFields,
          async run(v) {
            const proxiable = v.type !== "TXT";
            await cf("POST", `/zones/${needZone()}/dns_records`, { type: v.type, name: v.name, content: v.content, ttl: v.ttl ?? 1, ...(proxiable ? { proxied: v.proxied ?? false } : {}) });
            records.reset();
            return { dns: "DNS record created" };
          },
        },
        {
          id: "dns-edit",
          label: "Edit DNS record",
          minRole: "admin" as const,
          input: DnsEdit,
          async run(v) {
            const body: Record<string, unknown> = {};
            if (v.content !== undefined) body.content = v.content;
            if (v.proxied !== undefined) body.proxied = v.proxied;
            if (!Object.keys(body).length) throw new Error("Nothing to change");
            await cf("PATCH", `/zones/${needZone()}/dns_records/${encodeURIComponent(v.id)}`, body);
            records.reset();
            return { dns: "DNS record updated" };
          },
        },
        {
          id: "dns-remove",
          label: "Remove DNS record",
          minRole: "admin" as const,
          dangerous: true,
          input: DnsRemove,
          async run(v) {
            await cf("DELETE", `/zones/${needZone()}/dns_records/${encodeURIComponent(v.id)}`);
            records.reset();
            return { dns: "DNS record deleted" };
          },
        },
      ],
    };
  },
});
