import type { Store } from "./db.js";

interface Bucket {
  minute: number;
  sum: number;
  count: number;
}

/** Keeps one averaged sample per minute per metric, so history stays small however fast an instance is polled. */
export class MetricsRecorder {
  private buckets = new Map<string, Bucket>();

  constructor(private store: Store) {}

  record(instanceId: string, values: Record<string, number>, nowMs = Date.now()) {
    const minute = Math.floor(nowMs / 60_000) * 60;
    const done: { instanceId: string; key: string; ts: number; value: number }[] = [];
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const id = `${instanceId}\u0000${key}`;
      const b = this.buckets.get(id);
      if (b && b.minute !== minute) {
        done.push({ instanceId, key, ts: b.minute, value: b.sum / b.count });
        this.buckets.set(id, { minute, sum: value, count: 1 });
      } else if (b) {
        b.sum += value;
        b.count += 1;
      } else {
        this.buckets.set(id, { minute, sum: value, count: 1 });
      }
    }
    if (done.length) this.store.metrics.insertMany(done);
  }

  flush() {
    const rows = [...this.buckets.entries()].map(([id, b]) => {
      const [instanceId, key] = id.split("\u0000");
      return { instanceId, key, ts: b.minute, value: b.sum / b.count };
    });
    this.buckets.clear();
    if (rows.length) this.store.metrics.insertMany(rows);
  }

  forget(instanceId: string) {
    for (const id of [...this.buckets.keys()]) if (id.startsWith(`${instanceId}\u0000`)) this.buckets.delete(id);
  }
}

export const RANGES: Record<string, { seconds: number; bucket: number }> = {
  "1h": { seconds: 3600, bucket: 60 },
  "6h": { seconds: 6 * 3600, bucket: 300 },
  "24h": { seconds: 24 * 3600, bucket: 600 },
  "7d": { seconds: 7 * 86400, bucket: 3600 },
};
