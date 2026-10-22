import type { InstanceUpdate } from "./api";

type Obj = Record<string, any>;
const data = (i: InstanceUpdate): Obj | null => (i.data && typeof i.data === "object" ? (i.data as Obj) : null);

export function ago(ts: number | null, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function every(ms: number) {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
}

/** One line describing an instance, shown on collapsed cards and device lists. */
export function summarize(i: InstanceUpdate): string {
  if (!i.enabled) return "Paused";
  const d = data(i);
  if (!d) return i.error ? `Unreachable — ${i.error}` : "Waiting for first data…";
  switch (i.moduleId) {
    case "proxmox": {
      const g = ((d.guests ?? []) as Obj[]).filter((x) => !x.template);
      const n = (d.nodes ?? []) as Obj[];
      const cpu = n.length ? Math.round((n.reduce((a, x) => a + (x.cpu ?? 0), 0) / n.length) * 100) : null;
      const mem = n.length && n[0].maxmem ? Math.round((n.reduce((a, x) => a + x.mem, 0) / n.reduce((a, x) => a + x.maxmem, 0)) * 100) : null;
      return `${g.filter((x) => x.status === "running").length}/${g.length} guests running${cpu !== null ? ` · CPU ${cpu}%` : ""}${mem !== null ? ` · RAM ${mem}%` : ""}`;
    }
    case "apcupsd":
      return `${d.onBattery ? "ON BATTERY" : d.status === "ONLINE" ? "Online" : d.status}${d.batteryPct != null ? ` · ${Math.round(d.batteryPct)}%` : ""}${d.runtimeMin != null ? ` · ${Math.round(d.runtimeMin)} min` : ""}${d.loadPct != null ? ` · load ${Math.round(d.loadPct)}%` : ""}`;
    case "ilo4":
      return `${d.powerState ?? "?"}${d.power?.nowW != null ? ` · ${d.power.nowW} W` : ""} · health ${d.health ?? "?"}${(d.temperatures ?? []).find((t: Obj) => /inlet/i.test(t.name)) ? ` · inlet ${(d.temperatures as Obj[]).find((t) => /inlet/i.test(t.name))!.celsius}°C` : ""}`;
    case "uptime-kuma":
      return `${d.summary?.up ?? 0} up · ${d.summary?.down ?? 0} down${d.summary?.pending ? ` · ${d.summary.pending} pending` : ""}`;
    case "cloudflare": {
      const t = (d.tunnels ?? []) as Obj[];
      return `${t.filter((x) => x.status === "healthy").length}/${t.length} tunnels healthy`;
    }
    case "lumina": {
      const dev = (d.devices ?? []) as Obj[];
      const a = (d.alerts ?? []) as Obj[];
      return `${dev.filter((x) => x.level === "ok").length}/${dev.length} devices online · ${a.length ? `${a.length} alert${a.length === 1 ? "" : "s"}` : "no alerts"}`;
    }
    default:
      return i.status;
  }
}

export interface FleetGuest {
  instanceId: string;
  vmid: number;
  name: string;
  type: "qemu" | "lxc";
  status: string;
  node: string;
  cpu: number;
  mem: number;
  maxmem: number;
  uptime: number;
}
export interface FleetMonitor { instanceId: string; name: string; type: string; target: string; status: string; responseMs: number | null }

export interface Fleet {
  guests: FleetGuest[];
  monitors: FleetMonitor[];
  proxmox: { instanceId: string; node: string; cpu: number; mem: number }[];
  worstStorage: { name: string; node: string; pct: number } | null;
  /** Backup freshness across Proxmox guests that are in a backup job or have backups. */
  backups: { tracked: number; fresh: number; stale: number; uncovered: number; maxAgeDays: number; oldestDays: number | null } | null;
  storages: { name: string; node: string; pct: number; used: number; total: number }[];
  ilo: { instanceId: string; powerState: string | null; powerW: number | null; health: string | null; inletC: number | null; hottestC: number | null; critical: number | null } | null;
  ups: { instanceId: string; status: string; onBattery: boolean; batteryPct: number | null; runtimeMin: number | null; loadPct: number | null; watts: number | null } | null;
  tunnels: { healthy: number; total: number; instanceId: string } | null;
  online: number;
  total: number;
}

export function gather(instances: InstanceUpdate[]): Fleet {
  const f: Fleet = { guests: [], monitors: [], proxmox: [], worstStorage: null, backups: null, storages: [], ilo: null, ups: null, tunnels: null, online: 0, total: instances.filter((i) => i.enabled).length };
  for (const i of instances) {
    if (i.enabled && i.status === "connected") f.online += 1;
    const d = data(i);
    if (!d || !i.enabled) continue;
    if (i.moduleId === "proxmox") {
      for (const g of (d.guests ?? []) as Obj[]) if (!g.template) f.guests.push({ instanceId: i.instanceId, vmid: g.vmid, name: g.name, type: g.type, status: g.status, node: g.node, cpu: g.cpu, mem: g.mem, maxmem: g.maxmem, uptime: g.uptime });
      const pol = d.backupPolicy as { maxAgeDays: number; listOk: boolean } | undefined;
      if (pol?.listOk && pol.maxAgeDays > 0) {
        const b = f.backups ?? { tracked: 0, fresh: 0, stale: 0, uncovered: 0, maxAgeDays: pol.maxAgeDays, oldestDays: null as number | null };
        const nowS = Date.now() / 1000;
        for (const g of (d.guests ?? []) as Obj[]) {
          if (g.template || g.backupExcluded) continue;
          if (g.lastBackup) {
            const days = (nowS - g.lastBackup) / 86400;
            b.tracked += 1;
            if (days <= pol.maxAgeDays) b.fresh += 1; else b.stale += 1;
            b.oldestDays = Math.max(b.oldestDays ?? 0, days);
          } else if (g.backupCovered) { b.tracked += 1; b.stale += 1; }
          else b.uncovered += 1;
        }
        f.backups = b;
      }
      for (const n of (d.nodes ?? []) as Obj[]) if (typeof n.maxmem === "number") f.proxmox.push({ instanceId: i.instanceId, node: n.node, cpu: n.cpu * 100, mem: (n.mem / n.maxmem) * 100 });
      for (const s of (d.storage ?? []) as Obj[]) {
        if (!s.total) continue;
        const pct = (s.used / s.total) * 100;
        f.storages.push({ name: s.name, node: s.node, pct, used: s.used, total: s.total });
        if (!f.worstStorage || pct > f.worstStorage.pct) f.worstStorage = { name: s.name, node: s.node, pct };
      }
    } else if (i.moduleId === "uptime-kuma") {
      for (const m of (d.monitors ?? []) as Obj[]) f.monitors.push({ instanceId: i.instanceId, name: m.name, type: m.type, target: m.target, status: m.status, responseMs: m.responseMs });
    } else if (i.moduleId === "ilo4" && !f.ilo) {
      const temps = (d.temperatures ?? []) as Obj[];
      const hottest = temps.length ? temps.reduce((a, t) => (t.celsius > a.celsius ? t : a)) : null;
      f.ilo = {
        instanceId: i.instanceId, powerState: d.powerState ?? null, powerW: d.power?.nowW ?? null, health: d.health ?? null,
        inletC: temps.find((t) => /inlet/i.test(t.name))?.celsius ?? null, hottestC: hottest?.celsius ?? null, critical: hottest?.criticalC ?? null,
      };
    } else if (i.moduleId === "apcupsd" && !f.ups) {
      f.ups = {
        instanceId: i.instanceId, status: d.status, onBattery: !!d.onBattery, batteryPct: d.batteryPct ?? null, runtimeMin: d.runtimeMin ?? null,
        loadPct: d.loadPct ?? null, watts: d.loadPct != null && d.nominalW != null ? Math.round((d.loadPct / 100) * d.nominalW) : null,
      };
    } else if (i.moduleId === "cloudflare" && !f.tunnels) {
      const t = (d.tunnels ?? []) as Obj[];
      f.tunnels = { instanceId: i.instanceId, healthy: t.filter((x) => x.status === "healthy").length, total: t.length };
    }
  }
  return f;
}
