import { z } from "zod";
import { Agent, request } from "node:https";
import { defineModule, tlsOptions, type AlertCondition } from "@lumina/sdk";

const ConfigSchema = z.object({
  host: z.string().url(),
  tokenId: z.string(),
  tokenSecret: z.string(),
  verifyTls: z.boolean().default(false),
  fingerprint: z.string().optional(),
  backupMaxAgeDays: z.number().min(0).max(3650).default(8),
  backupExclude: z.string().optional(),
});
type Config = z.infer<typeof ConfigSchema>;

interface PveNode {
  node: string;
  status: string;
  cpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
}

// One entry of /cluster/resources; the `type` field says whether it is a guest, storage, pool, ...
interface PveResource {
  type: string;
  id: string;
  node?: string;
  status?: string;
  vmid?: number;
  name?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  netin?: number;
  netout?: number;
  template?: number;
  tags?: string;
  pool?: string;
  hastate?: string;
  storage?: string;
  plugintype?: string;
  content?: string;
  shared?: number;
  poolid?: string;
  comment?: string;
}

interface PveNodeStatus {
  pveversion?: string;
  kversion?: string;
  cpuinfo?: { model?: string; cpus?: number; cores?: number; sockets?: number; mhz?: string };
  loadavg?: string[];
  swap?: { used: number; total: number };
  rootfs?: { used: number; total: number };
  "boot-info"?: { mode?: string };
}

interface PveDisk {
  devpath: string;
  model?: string;
  serial?: string;
  size: number;
  type?: string;
  health?: string;
  wearout?: number | string;
  used?: string;
  rpm?: number;
}

interface PveIface {
  iface: string;
  type: string;
  active?: number;
  address?: string;
  cidr?: string;
  gateway?: string;
  bridge_ports?: string;
  slaves?: string;
  comments?: string;
}

interface PveTask {
  upid: string;
  node: string;
  user: string;
  type: string;
  id?: string;
  status?: string;
  starttime: number;
  endtime?: number;
}

interface PveLogEntry {
  time: number;
  node: string;
  user: string;
  tag: string;
  msg: string;
}

function client(cfg: Config) {
  const agent = new Agent(tlsOptions(cfg));
  const headers = { Authorization: `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}` };

  function call<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const payload = body ? JSON.stringify(body) : undefined;
    return new Promise((resolve, reject) => {
      const req = request(
        `${cfg.host}/api2/json${path}`,
        {
          method,
          agent,
          timeout: payload ? 20_000 : 8000,
          headers: payload ? { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            if (!res.statusCode || res.statusCode >= 400) {
              // Proxmox explains problems in the status line or body ("snapshot name already exists", "no such storage", ...).
              let why = res.statusMessage ?? "";
              try {
                const j = JSON.parse(body) as { message?: string; errors?: Record<string, string> };
                const detail = j.errors ? Object.entries(j.errors).map(([k, v]) => `${k}: ${v}`).join("; ") : j.message;
                if (detail) why = why && !detail.includes(why) ? `${why} — ${detail}` : detail;
              } catch { /* body was not JSON */ }
              return reject(new Error(`proxmox ${method} ${path} -> ${res.statusCode} ${why}`.trim()));
            }
            try {
              resolve((JSON.parse(body) as { data: T }).data);
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error(`proxmox ${method} ${path} timed out`)));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    post: <T>(path: string, body: Record<string, unknown>) => call<T>("POST", path, body),
    get: <T>(path: string) => call<T>("GET", path),
    nodes: () => call<PveNode[]>("GET", "/nodes"),
    power: (node: string, type: "qemu" | "lxc", vmid: number, op: "start" | "stop" | "reboot") =>
      call<string>("POST", `/nodes/${node}/${type}/${vmid}/status/${op}`),
  };
}

const GuestTarget = z.object({
  node: z.string(),
  type: z.enum(["qemu", "lxc"]),
  vmid: z.number().int(),
});

const SnapshotInput = GuestTarget.extend({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, "Use letters, digits, - and _, starting with a letter (max 40)").optional(),
  description: z.string().max(200).optional(),
});

const BackupInput = GuestTarget.extend({
  storage: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  mode: z.enum(["snapshot", "suspend", "stop"]).default("snapshot"),
  note: z.string().max(200).optional(),
});

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

export default defineModule<Config>({
  id: "proxmox",
  name: "Proxmox VE",
  description: "Nodes, VMs and containers via the Proxmox REST API",
  fields: [
    { key: "host", label: "Host URL", type: "text", required: true, placeholder: "https://pve.local:8006" },
    { key: "tokenId", label: "API token ID", type: "text", required: true, placeholder: "user@pam!tokenname" },
    { key: "tokenSecret", label: "API token secret", type: "password", required: true },
    { key: "verifyTls", label: "Verify TLS certificate", type: "boolean", default: false, help: "Leave off for self-signed certificates — and pin the certificate below instead" },
    { key: "backupMaxAgeDays", label: "Warn when a guest's last backup is older than (days)", type: "number", default: 8, help: "0 turns the backup-age warning off. A weekly job needs at least 8." },
    { key: "backupExclude", label: "Guests that don't need backups (IDs)", type: "text", placeholder: "109, 111", help: "Comma-separated VM/CT IDs to leave out of the backup-age warning" },
    { key: "fingerprint", label: "Certificate fingerprint (optional)", type: "text", help: "SHA-256 fingerprint. When set, Lumina only talks to a device presenting exactly this certificate, even if it is self-signed. Use Detect to read it from the device." },
  ],
  configSchema: ConfigSchema,
  pollIntervalMs: 10_000,
  minPollIntervalMs: 5_000,
  multiInstance: true,

  async create(config: Config, ctx) {
    const pve = client(config);
    let healthy = false;

    // Slow-changing data (disks, network config) is cached so the 10s poll stays light.
    const cache = new Map<string, { at: number; value: unknown }>();
    async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
      const value = await load();
      cache.set(key, { at: Date.now(), value });
      return value;
    }

    // Guests seen running this session. A guest that leaves this set only through Lumina's own stop/reboot is not "unexpected".
    const seenRunning = new Set<string>();
    const guestKey = (g: { node: string; vmid: number }) => `${g.node}/${g.vmid}`;

    return {
      async poll() {
        const warnings: string[] = [];
        // A missing permission on one endpoint must not blank the whole card.
        const safe = async <T>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
          try {
            return await p;
          } catch (err) {
            warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
            return fallback;
          }
        };

        const nodes = await pve.nodes();
        healthy = true;

        const [resources, tasks, clusterStatus, clusterLog, backupJobs, ha] = await Promise.all([
          safe("resources", pve.get<PveResource[]>("/cluster/resources"), []),
          safe("tasks", pve.get<PveTask[]>("/cluster/tasks"), []),
          safe("cluster status", pve.get<Record<string, unknown>[]>("/cluster/status"), []),
          safe("cluster log", pve.get<PveLogEntry[]>("/cluster/log?max=40"), []),
          safe("backup jobs", pve.get<Record<string, unknown>[]>("/cluster/backup"), []),
          safe("HA", pve.get<Record<string, unknown>[]>("/cluster/ha/status/current"), []),
        ]);

        const perNode = await Promise.all(
          nodes
            .filter((n) => n.status === "online")
            .map(async (n) => {
              const [status, network, disks] = await Promise.all([
                safe(`${n.node} status`, pve.get<PveNodeStatus>(`/nodes/${n.node}/status`), {} as PveNodeStatus),
                safe(`${n.node} network`, cached(`net:${n.node}`, 60_000, () => pve.get<PveIface[]>(`/nodes/${n.node}/network`)), []),
                safe(`${n.node} disks`, cached(`disks:${n.node}`, 300_000, () => pve.get<PveDisk[]>(`/nodes/${n.node}/disks/list`)), []),
              ]);
              return { node: n.node, status, network, disks };
            }),
        );

        const guests = resources.filter((r) => r.type === "qemu" || r.type === "lxc");

        // How old is each guest's newest backup? Read from the backup-capable storages, cached because backups change slowly.
        const excluded = new Set((config.backupExclude ?? "").split(/[,\s]+/).filter(Boolean).map(Number));
        const backupStores: { node: string; storage: string }[] = [];
        for (const r of resources) {
          if (r.type !== "storage" || r.status !== "available" || !r.storage || !r.node || !r.content?.split(",").includes("backup")) continue;
          // A shared storage shows up once per node but holds the same backups, so read it only once.
          if (r.shared === 1 && backupStores.some((x) => x.storage === r.storage)) continue;
          backupStores.push({ node: r.node, storage: r.storage });
        }
        const byVmid = new Map<number, { last: number; count: number; size: number }>();
        let backupListOk = backupStores.length > 0;
        for (const { node, storage } of backupStores) {
          try {
            const items = await cached(`bk:${node}/${storage}`, 600_000, () => pve.get<{ vmid?: number; ctime?: number; size?: number }[]>(`/nodes/${node}/storage/${storage}/content?content=backup`));
            for (const it of items) {
              if (typeof it.vmid !== "number" || typeof it.ctime !== "number") continue;
              const cur = byVmid.get(it.vmid) ?? { last: 0, count: 0, size: 0 };
              cur.last = Math.max(cur.last, it.ctime);
              cur.count += 1;
              cur.size += it.size ?? 0;
              byVmid.set(it.vmid, cur);
            }
          } catch (err) {
            backupListOk = false;
            warnings.push(`backups on ${storage}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        const jobs = backupJobs.filter((j) => j.enabled === undefined || Boolean(j.enabled));
        const covered = (g: PveResource) =>
          jobs.some((j) => {
            const ids = String(j.vmid ?? "").split(",").map((x) => x.trim());
            const skip = String(j.exclude ?? "").split(",").map((x) => x.trim());
            if (j.all) return !skip.includes(String(g.vmid));
            return ids.includes(String(g.vmid)) || (!!j.pool && j.pool === g.pool);
          });

        return {
          backupPolicy: { maxAgeDays: config.backupMaxAgeDays, listOk: backupListOk },
          nodes: nodes.map((n) => {
            const s = perNode.find((p) => p.node === n.node)?.status;
            return {
              ...n,
              details: s && {
                version: s.pveversion?.replace(/^pve-manager\//, "").split("/")[0] ?? null,
                kernel: s.kversion ?? null,
                cpuModel: s.cpuinfo?.model ?? null,
                cpus: s.cpuinfo?.cpus ?? null,
                sockets: s.cpuinfo?.sockets ?? null,
                loadavg: s.loadavg?.map(Number) ?? null,
                swap: s.swap ?? null,
                rootfs: s.rootfs ?? null,
                bootMode: s["boot-info"]?.mode ?? null,
              },
            };
          }),
          guests: guests.map((g) => ({
            vmid: g.vmid,
            name: g.name,
            type: g.type,
            status: g.status,
            node: g.node,
            cpu: g.cpu,
            maxcpu: g.maxcpu ?? null,
            consoleUrl: g.template === 1 ? null : `${config.host.replace(/\/+$/, "")}/?${new URLSearchParams({ console: g.type === "qemu" ? "kvm" : "lxc", novnc: "1", vmid: String(g.vmid), vmname: String(g.name ?? ""), node: String(g.node) })}`,
            mem: g.mem,
            maxmem: g.maxmem,
            maxdisk: g.maxdisk ?? 0,
            uptime: g.uptime ?? 0,
            netin: g.netin ?? 0,
            netout: g.netout ?? 0,
            template: g.template === 1,
            tags: g.tags ? g.tags.split(/[;,]/).filter(Boolean) : [],
            pool: g.pool ?? null,
            ha: g.hastate ?? null,
            lastBackup: byVmid.get(g.vmid as number)?.last ?? null,
            backupCount: byVmid.get(g.vmid as number)?.count ?? 0,
            backupBytes: byVmid.get(g.vmid as number)?.size ?? 0,
            backupCovered: covered(g),
            backupExcluded: excluded.has(g.vmid as number),
          })),
          storage: resources
            .filter((r) => r.type === "storage")
            .map((s) => ({
              id: s.id,
              name: s.storage,
              node: s.node,
              kind: s.plugintype,
              content: s.content ? s.content.split(",") : [],
              shared: s.shared === 1,
              status: s.status,
              used: s.disk ?? 0,
              total: s.maxdisk ?? 0,
            })),
          pools: resources.filter((r) => r.type === "pool").map((p) => ({ id: p.poolid ?? p.id, comment: p.comment ?? "" })),
          disks: perNode.flatMap((p) =>
            p.disks.map((d) => ({
              node: p.node,
              dev: d.devpath,
              model: d.model ?? null,
              serial: d.serial ?? null,
              sizeBytes: d.size,
              kind: d.type ?? null,
              health: d.health ?? null,
              wearout: d.wearout === undefined || d.wearout === "N/A" ? null : Number(d.wearout),
              usedBy: d.used ?? null,
              rpm: d.rpm ?? null,
            })),
          ),
          network: perNode.flatMap((p) =>
            p.network
              .filter((i) => i.type !== "unknown")
              .map((i) => ({
                node: p.node,
                iface: i.iface,
                kind: i.type,
                active: i.active === 1,
                address: i.cidr ?? i.address ?? null,
                gateway: i.gateway ?? null,
                ports: i.bridge_ports ?? i.slaves ?? null,
                comment: i.comments?.trim() || null,
              })),
          ),
          tasks: tasks
            .sort((a, b) => b.starttime - a.starttime)
            .slice(0, 30)
            .map((t) => ({
              node: t.node,
              user: t.user,
              type: t.type,
              id: t.id ?? null,
              status: t.endtime ? (t.status ?? "") : "running",
              start: t.starttime,
              end: t.endtime ?? null,
            })),
          log: clusterLog
            .sort((a, b) => b.time - a.time)
            .slice(0, 40)
            .map((l) => ({ time: l.time, node: l.node, user: l.user, tag: l.tag, msg: l.msg })),
          backups: backupJobs.map((j) => ({
            id: String(j.id ?? ""),
            enabled: j.enabled === undefined ? true : Boolean(j.enabled),
            schedule: String(j.schedule ?? j["repeat-missed"] ?? ""),
            storage: j.storage ? String(j.storage) : null,
            mode: j.mode ? String(j.mode) : null,
            target: j.all ? "all guests" : j.pool ? `pool ${j.pool}` : j.vmid ? `guests ${j.vmid}` : "",
            comment: j.comment ? String(j.comment) : null,
          })),
          ha: ha.map((h) => ({
            id: String(h.id ?? ""),
            type: String(h.type ?? ""),
            status: String(h.status ?? ""),
            node: h.node ? String(h.node) : null,
          })),
          cluster: (() => {
            const c = clusterStatus.find((x) => x.type === "cluster");
            return c
              ? { name: String(c.name), quorate: Boolean(c.quorate), nodes: Number(c.nodes ?? 0), version: Number(c.version ?? 0) }
              : null;
          })(),
          warnings,
        };
      },
      async status() {
        return healthy ? "connected" : "disconnected";
      },
      alerts(d: any) {
        const out: AlertCondition[] = [];
        for (const n of d.nodes ?? []) {
          if (n.status !== "online") out.push({ key: `node-offline:${n.node}`, severity: "critical", title: `Node ${n.node} is ${n.status}` });
          else if (n.maxmem && n.mem / n.maxmem >= 0.95) out.push({ key: `node-mem:${n.node}`, severity: "warning", title: `Node ${n.node} is almost out of memory`, detail: `${Math.round((n.mem / n.maxmem) * 100)}% used` });
        }
        if (d.cluster && !d.cluster.quorate) out.push({ key: "no-quorum", severity: "critical", title: `Cluster ${d.cluster.name} has lost quorum` });
        for (const s of d.storage ?? []) {
          if (s.status && s.status !== "available") out.push({ key: `storage-unavailable:${s.id}`, severity: "critical", title: `Storage ${s.name} on ${s.node} is ${s.status}` });
          else if (s.total > 0) {
            const used = s.used / s.total;
            if (used >= 0.97) out.push({ key: `storage-full:${s.id}`, severity: "critical", title: `Storage ${s.name} on ${s.node} is full`, detail: `${Math.round(used * 100)}% used` });
            else if (used >= 0.9) out.push({ key: `storage-full:${s.id}`, severity: "warning", title: `Storage ${s.name} on ${s.node} is nearly full`, detail: `${Math.round(used * 100)}% used` });
          }
        }
        for (const k of d.disks ?? []) {
          if (k.health && !/^(OK|PASSED|UNKNOWN)$/i.test(k.health)) out.push({ key: `disk-health:${k.node}:${k.dev}`, severity: "critical", title: `Disk ${k.dev} on ${k.node} SMART status: ${k.health}`, detail: k.model ?? undefined });
          if (typeof k.wearout === "number" && k.wearout <= 10) out.push({ key: `disk-wear:${k.node}:${k.dev}`, severity: "warning", title: `SSD ${k.dev} on ${k.node} is nearly worn out`, detail: `${k.wearout}% life left` });
        }
        for (const g of d.guests ?? []) {
          if (g.template) continue;
          const key = guestKey(g);
          if (g.status === "running") seenRunning.add(key);
          else if (seenRunning.has(key)) {
            out.push({ key: `guest-stopped:${g.vmid}`, severity: "warning", title: `${g.name} (${g.type === "qemu" ? "VM" : "CT"} ${g.vmid}) stopped`, detail: `On ${g.node}, it was running earlier` });
          }
        }
        const maxAge = d.backupPolicy?.maxAgeDays ?? 0;
        if (maxAge > 0 && d.backupPolicy?.listOk) {
          const nowSec = Date.now() / 1000;
          for (const g of d.guests ?? []) {
            if (g.template || g.backupExcluded) continue;
            if (g.lastBackup) {
              const days = (nowSec - g.lastBackup) / 86400;
              if (days > maxAge) out.push({ key: `backup-stale:${g.vmid}`, severity: "warning", title: `${g.name} has no recent backup`, detail: `Last backup ${Math.floor(days)} day(s) ago (limit ${maxAge})` });
            } else if (g.backupCovered) {
              out.push({ key: `backup-missing:${g.vmid}`, severity: "warning", title: `${g.name} is in a backup job but has no backup`, detail: "No backup file was found on any backup storage" });
            }
          }
        }
        const dayAgo = Date.now() / 1000 - 86400;
        for (const t of d.tasks ?? []) {
          if (t.type !== "vzdump" || !t.end || t.end < dayAgo || t.status === "OK" || t.status === "running") continue;
          out.push({ key: `backup:${t.node}:${t.start}`, severity: t.status.startsWith("WARNINGS") ? "warning" : "critical", title: "Backup did not finish cleanly", detail: `${t.id ?? "job"} on ${t.node}: ${t.status}` });
        }
        return d.backupPolicy?.listOk === false && (d.backupPolicy?.maxAgeDays ?? 0) > 0 ? { conditions: out, unknown: ["backup-stale:", "backup-missing:"] } : out;
      },
      metrics(d: any) {
        const m: Record<string, number> = {};
        for (const n of d.nodes ?? []) {
          if (typeof n.cpu !== "number") continue;
          m[`cpu:${n.node}`] = n.cpu * 100;
          if (n.maxmem) m[`mem:${n.node}`] = (n.mem / n.maxmem) * 100;
          if (n.maxdisk) m[`rootfs:${n.node}`] = (n.disk / n.maxdisk) * 100;
        }
        const guests = (d.guests ?? []).filter((g: any) => !g.template);
        m["guests:running"] = guests.filter((g: any) => g.status === "running").length;
        m["guests:total"] = guests.length;
        // Cores in use by each running guest, for splitting the server's electricity between them.
        for (const g of guests) if (g.status === "running" && typeof g.cpu === "number" && g.maxcpu) m[`gcpu:${g.vmid}`] = g.cpu * g.maxcpu;
        for (const s of d.storage ?? []) if (s.total > 0) m[`storage:${s.name}@${s.node}`] = (s.used / s.total) * 100;
        return m;
      },
      actions: [
        {
          id: "snapshot",
          label: "Take snapshot",
          schedulable: true,
          input: SnapshotInput,
          async run(t: z.infer<typeof SnapshotInput>) {
            const snapname = t.name ?? `lumina-${stamp()}`;
            ctx.log.info(`snapshot ${snapname} of ${t.type}/${t.vmid} on ${t.node}`);
            const task = await pve.post<string>(`/nodes/${t.node}/${t.type}/${t.vmid}/snapshot`, { snapname, ...(t.description ? { description: t.description } : {}) });
            return { snapshot: snapname, task };
          },
        },
        {
          id: "backup",
          label: "Back up now",
          schedulable: true,
          input: BackupInput,
          async run(t: z.infer<typeof BackupInput>) {
            ctx.log.info(`backup of ${t.type}/${t.vmid} on ${t.node} to ${t.storage} (${t.mode})`);
            const task = await pve.post<string>(`/nodes/${t.node}/vzdump`, {
              vmid: String(t.vmid), storage: t.storage, mode: t.mode, compress: "zstd",
              ...(t.note ? { notes: t.note } : {}),
            });
            return { task };
          },
        },
        ...(["start", "stop", "reboot"] as const).map((op) => ({
        id: op,
        schedulable: true,
        label: `${op[0].toUpperCase()}${op.slice(1)} guest`,
        dangerous: op !== "start",
        input: GuestTarget,
        async run(t: z.infer<typeof GuestTarget>) {
          ctx.log.info(`${op} ${t.type}/${t.vmid} on ${t.node}`);
          if (op !== "start") seenRunning.delete(guestKey(t));
          return pve.power(t.node, t.type, t.vmid, op);
        },
      })),
      ],
    };
  },
});
