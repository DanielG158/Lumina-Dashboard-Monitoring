import type { Server } from "socket.io";
import type { MaintenanceRow, Store } from "./db.js";

const PERIOD = { daily: 86400, weekly: 604800 } as const;
const nowS = () => Math.floor(Date.now() / 1000);

export interface Occurrence {
  start: number;
  end: number;
}

/** The occurrence of a window that contains `now`, or null. Repeating windows repeat every 24 h or 7 days from their first start. */
export function occurrenceAt(m: MaintenanceRow, now: number): Occurrence | null {
  if (!m.enabled || now < m.startTs) return null;
  if (m.repeat === "none") {
    const end = Math.min(m.startTs + m.durationS, m.endedTs ?? Infinity);
    return now < end ? { start: m.startTs, end } : null;
  }
  const period = PERIOD[m.repeat];
  const n = Math.floor((now - m.startTs) / period);
  const start = m.startTs + n * period;
  const end = start + m.durationS;
  if (now >= end || (m.skipUntil !== null && now < m.skipUntil)) return null;
  return { start, end };
}

/** Occurrences that start (or are running) within the next `horizonS` seconds. */
export function upcomingOccurrences(m: MaintenanceRow, now: number, horizonS: number): Occurrence[] {
  if (!m.enabled) return [];
  if (m.repeat === "none") {
    const end = Math.min(m.startTs + m.durationS, m.endedTs ?? Infinity);
    return end > now && m.startTs < now + horizonS ? [{ start: m.startTs, end }] : [];
  }
  const period = PERIOD[m.repeat];
  const out: Occurrence[] = [];
  let n = Math.max(0, Math.floor((now - m.startTs) / period));
  for (; ; n++) {
    const start = m.startTs + n * period;
    if (start >= now + horizonS) break;
    const end = start + m.durationS;
    if (end > now && !(m.skipUntil !== null && start < m.skipUntil)) out.push({ start, end });
  }
  return out;
}

export interface ActiveMaintenance {
  id: number;
  name: string;
  scope: string[];
  endsAt: number;
  note: string | null;
  recurring: boolean;
}

export class Maintenance {
  constructor(private store: Store, private io: Server) {}

  private covers(m: MaintenanceRow, instanceId: string) {
    return m.scope.includes("*") || m.scope.includes(instanceId);
  }

  /** The window currently muting this instance, if any. */
  activeFor(instanceId: string, now = nowS()): ActiveMaintenance | null {
    for (const m of this.store.maintenance.list()) {
      const occ = occurrenceAt(m, now);
      if (occ && this.covers(m, instanceId)) return { id: m.id, name: m.name, scope: m.scope, endsAt: occ.end, note: m.note, recurring: m.repeat !== "none" };
    }
    return null;
  }

  status(now = nowS()) {
    const windows = this.store.maintenance.list();
    const active: ActiveMaintenance[] = [];
    const upcoming: { id: number; name: string; scope: string[]; start: number; end: number; recurring: boolean }[] = [];
    for (const m of windows) {
      const occ = occurrenceAt(m, now);
      if (occ) active.push({ id: m.id, name: m.name, scope: m.scope, endsAt: occ.end, note: m.note, recurring: m.repeat !== "none" });
      for (const o of upcomingOccurrences(m, now, 7 * 86400)) {
        if (o.start > now) upcoming.push({ id: m.id, name: m.name, scope: m.scope, start: o.start, end: o.end, recurring: m.repeat !== "none" });
      }
    }
    upcoming.sort((a, b) => a.start - b.start);
    return { now, active, upcoming, windows };
  }

  private changed() {
    this.io.emit("maintenance:changed");
    this.io.emit("alerts:changed");
  }

  startNow(o: { scope: string[]; minutes: number; name: string; note?: string | null; createdBy: string | null }) {
    const id = this.store.maintenance.create({ name: o.name, scope: o.scope, startTs: nowS(), durationS: Math.round(o.minutes * 60), repeat: "none", note: o.note ?? null, createdBy: o.createdBy });
    this.changed();
    return id;
  }

  create(m: { name: string; scope: string[]; startTs: number; durationS: number; repeat: string; note: string | null; createdBy: string | null }) {
    const id = this.store.maintenance.create(m);
    this.changed();
    return id;
  }

  update(id: number, m: { name: string; scope: string[]; startTs: number; durationS: number; repeat: string; note: string | null; enabled: boolean }) {
    this.store.maintenance.update(id, m);
    this.changed();
  }

  /** Ends the running occurrence now. A repeating window keeps its schedule and skips only this occurrence. */
  endNow(id: number, now = nowS()) {
    const m = this.store.maintenance.get(id);
    if (!m) return false;
    const occ = occurrenceAt(m, now);
    if (!occ) return false;
    if (m.repeat === "none") this.store.maintenance.end(id, now, null);
    else this.store.maintenance.end(id, null, occ.end);
    this.changed();
    return true;
  }

  delete(id: number) {
    this.store.maintenance.delete(id);
    this.changed();
  }
}
