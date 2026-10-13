import { z } from "zod";
import { defineModule, httpRequestRaw, type AlertCondition } from "@lumina/sdk";

const ConfigSchema = z.object({
  apiToken: z.string().min(1),
  accountId: z.string().min(1),
  zoneId: z.string().optional(),
});
type Config = z.infer<typeof ConfigSchema>;

const API = "https://api.cloudflare.com/client/v4";

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
  connections?: { colo_name?: string; is_pending_reconnect?: boolean }[];
}
interface DnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
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
      help: "If set, adding/removing a hostname also creates/deletes its proxied CNAME record",
    },
  ],
  configSchema: ConfigSchema,
  pollIntervalMs: 30_000,
  minPollIntervalMs: 10_000,
  multiInstance: true,

  async create(config, ctx) {
    let healthy = false;

    async function cf<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await httpRequestRaw(`${API}${path}`, {
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

    return {
      async poll() {
        try {
          const tunnels = await cf<Tunnel[]>("GET", `/accounts/${config.accountId}/cfd_tunnel?is_deleted=false`);
          healthy = true;
          return {
            dnsManaged: Boolean(config.zoneId),
            tunnels: await Promise.all(
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
                  colos: [...new Set((t.connections ?? []).map((c) => c.colo_name).filter(Boolean))],
                  ingress: ingress.map((r) => ({ hostname: r.hostname ?? null, service: r.service, path: r.path ?? null })),
                };
              }),
            ),
          };
        } catch (err) {
          healthy = false;
          throw err;
        }
      },
      async status() {
        return healthy ? "connected" : "disconnected";
      },
      alerts(d: { tunnels: { name: string; status: string; connections: number }[] }) {
        const out: AlertCondition[] = [];
        for (const t of d.tunnels) {
          if (t.status === "down") out.push({ key: `tunnel:${t.name}`, severity: "critical", title: `Tunnel ${t.name} is down`, detail: "No active connections to Cloudflare" });
          else if (t.status === "degraded") out.push({ key: `tunnel:${t.name}`, severity: "warning", title: `Tunnel ${t.name} is degraded`, detail: `${t.connections} connection(s)` });
        }
        return out;
      },
      metrics(d: { tunnels: { name: string; status: string; connections: number }[] }) {
        const m: Record<string, number> = {
          "tunnels:healthy": d.tunnels.filter((t) => t.status === "healthy").length,
          "tunnels:total": d.tunnels.length,
        };
        for (const t of d.tunnels) m[`connections:${t.name}`] = t.connections;
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
      ],
    };
  },
});
