import type { AlertCondition } from "@lumina/sdk";
import type { Store } from "./db.js";

export interface StorageForecast {
  instanceId: string;
  key: string;
  name: string;
  node: string;
  currentPct: number;
  /** percentage points of the volume gained per day (negative = freeing space) */
  slopePerDay: number | null;
  daysToFull: number | null;
  /** how well a straight line fits (1 = perfectly); weekly backup cycles fit poorly */
  r2: number | null;
  spanDays: number;
  status: "growing" | "stable" | "shrinking" | "unclear" | "collecting";
}

const nowS = () => Math.floor(Date.now() / 1000);

/** Least-squares line through hourly averages of "percent used" over the last 14 days. */
export function forecastStorage(store: Store, now = nowS()): StorageForecast[] {
  const out: StorageForecast[] = [];
  const instances = store.metrics.instancesWithKey("guests:running"); // Proxmox instances
  for (const instanceId of instances) {
    for (const key of store.metrics.keysLike(instanceId, "storage:%")) {
      const label = key.slice("storage:".length);
      const at = label.lastIndexOf("@");
      const name = at === -1 ? label : label.slice(0, at);
      const node = at === -1 ? "" : label.slice(at + 1);
      const pts = store.metrics.aggregate(instanceId, key, now - 14 * 86400, 3600);
      const base = { instanceId, key, name, node };
      if (pts.length === 0) continue;
      const currentPct = pts.slice(-3).reduce((a, p) => a + p.avg, 0) / Math.min(3, pts.length);
      const spanDays = (pts[pts.length - 1].t - pts[0].t) / 86400;
      if (pts.length < 24 || spanDays < 1.5) { out.push({ ...base, currentPct, slopePerDay: null, daysToFull: null, r2: null, spanDays, status: "collecting" }); continue; }

      const xs = pts.map((p) => (p.t - pts[0].t) / 86400);
      const ys = pts.map((p) => p.avg);
      const n = xs.length;
      const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
      const slope = sxx > 0 ? sxy / sxx : 0;
      const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 1;
      let status: StorageForecast["status"] = "stable";
      let daysToFull: number | null = null;
      if (Math.abs(slope) < 0.05) status = "stable";
      else if (r2 < 0.3) status = "unclear";
      else if (slope > 0) { status = "growing"; daysToFull = currentPct >= 100 ? 0 : (100 - currentPct) / slope; if (daysToFull > 3650) daysToFull = null; }
      else status = "shrinking";
      out.push({ ...base, currentPct, slopePerDay: slope, daysToFull, r2, spanDays, status });
    }
  }
  return out;
}

export function forecastConditions(list: StorageForecast[], instanceId: string, warnDays: number): AlertCondition[] {
  return list
    .filter((f) => f.instanceId === instanceId && f.status === "growing" && f.daysToFull !== null && f.daysToFull <= warnDays)
    .map((f) => ({
      key: `storage-forecast:${f.name}@${f.node}`,
      severity: (f.daysToFull as number) <= 3 ? ("critical" as const) : ("warning" as const),
      title: `${f.name}${f.node ? ` on ${f.node}` : ""} will be full in about ${Math.max(1, Math.round(f.daysToFull as number))} day(s)`,
      detail: `${Math.round(f.currentPct)}% used, growing ${(f.slopePerDay as number).toFixed(1)} points per day`,
    }));
}
