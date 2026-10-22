import type { Server } from "socket.io";
import type { AlertCondition } from "@lumina/sdk";
import type { Store } from "./db.js";
import type { Notification, Severity } from "./notify.js";

export interface ActiveAlert {
  id: number;
  instanceId: string;
  key: string;
  severity: Severity;
  title: string;
  detail: string | null;
  since: number;
  /** true while a maintenance window is muting this alert's instance */
  suppressed: boolean;
  maintenance: string | null;
}

interface Tracked extends Omit<ActiveAlert, "suppressed" | "maintenance"> {
  absent: number;
  /** false while the alert was raised during maintenance and nobody has been told yet */
  notified: boolean;
}

interface Pending {
  seen: number;
  condition: AlertCondition;
}

export interface EngineSettings {
  confirmPolls: number;
  muted: string[];
}

const UNREACHABLE = "unreachable";

export class AlertEngine {
  private firing = new Map<string, Tracked>();
  private pending = new Map<string, Pending>();

  constructor(
    private store: Store,
    private io: Server,
    private notify: (n: Notification) => Promise<void>,
    private settings: () => EngineSettings,
    private maintenance: (instanceId: string) => { name: string } | null = () => null,
  ) {
    // Alerts that were firing before a restart keep firing, so a restart never re-sends notifications.
    for (const e of store.events.firing()) {
      this.firing.set(`${e.instanceId}\u0000${e.key}`, {
        id: e.id, instanceId: e.instanceId, key: e.key, severity: e.severity, title: e.title, detail: e.detail, since: e.ts, absent: 0, notified: e.notified,
      });
    }
  }

  active(): ActiveAlert[] {
    const muted = new Set(this.settings().muted);
    return [...this.firing.values()]
      .filter((a) => !muted.has(a.key))
      .map(({ absent: _a, notified: _n, ...a }) => {
        const m = this.maintenance(a.instanceId);
        return { ...a, suppressed: m !== null, maintenance: m?.name ?? null };
      })
      .sort((a, b) => b.since - a.since);
  }

  forInstance(instanceId: string): ActiveAlert[] {
    return this.active().filter((a) => a.instanceId === instanceId);
  }

  /**
   * Called after every poll. `conditions` is null when the poll failed: then only reachability is known, so module
   * conditions are left untouched and only the "unreachable" alert is raised once the instance counts as down.
   */
  async evaluate(instanceId: string, r: { conditions: AlertCondition[] | null; down: boolean; error: string | null; unknown?: string[] }) {
    const isUnknown = (key: string) => (r.unknown ?? []).some((p) => key.startsWith(p));
    const { confirmPolls, muted } = this.settings();
    const mutedSet = new Set(muted);
    const scopeAll = r.conditions !== null;
    if (!scopeAll && !r.down) return;

    const list = r.conditions ? [...r.conditions] : [];
    if (r.down) list.push({ key: UNREACHABLE, severity: "critical", title: `${instanceId} is unreachable`, detail: r.error ?? undefined });
    const threshold = (key: string) => (key === UNREACHABLE ? 1 : confirmPolls);

    const fired: Tracked[] = [];
    const resolved: Tracked[] = [];
    const present = new Set<string>();
    const maint = this.maintenance(instanceId);

    // Anything raised during maintenance that is still broken once the window is over is reported now.
    if (!maint && scopeAll) {
      const catchUp = [...this.firing.values()].filter((a) => a.instanceId === instanceId && !a.notified && !mutedSet.has(a.key));
      if (catchUp.length) {
        for (const a of catchUp) { a.notified = true; this.store.events.setNotified(a.id); }
        await this.dispatch(instanceId, catchUp, [], "still active after maintenance");
      }
    }

    for (const c of list) {
      if (mutedSet.has(c.key)) continue;
      const id = `${instanceId}\u0000${c.key}`;
      present.add(id);
      const existing = this.firing.get(id);
      if (existing) {
        existing.absent = 0;
        existing.severity = c.severity;
        existing.title = c.title;
        existing.detail = c.detail ?? null;
        continue;
      }
      const p = this.pending.get(id) ?? { seen: 0, condition: c };
      p.seen += 1;
      p.condition = c;
      this.pending.set(id, p);
      if (p.seen >= threshold(c.key)) {
        this.pending.delete(id);
        const quiet = maint !== null;
        const eventId = this.store.events.insert({ instanceId, key: c.key, severity: c.severity, title: c.title, detail: c.detail ?? null, notified: !quiet });
        const a: Tracked = { id: eventId, instanceId, key: c.key, severity: c.severity, title: c.title, detail: c.detail ?? null, since: Math.floor(Date.now() / 1000), absent: 0, notified: !quiet };
        this.firing.set(id, a);
        if (!quiet) fired.push(a);
        else this.io.emit("alerts:changed");
      }
    }

    if (scopeAll) {
      for (const id of [...this.pending.keys()]) if (id.startsWith(`${instanceId}\u0000`) && !present.has(id)) this.pending.delete(id);
    }

    for (const [id, a] of [...this.firing]) {
      if (a.instanceId !== instanceId || present.has(id) || isUnknown(a.key)) continue;
      if (!scopeAll && a.key !== UNREACHABLE) continue;
      a.absent += 1;
      if (a.absent >= threshold(a.key) || mutedSet.has(a.key)) {
        this.store.events.resolve(a.id);
        this.firing.delete(id);
        if (!mutedSet.has(a.key) && a.notified) resolved.push(a);
      }
    }

    if (fired.length || resolved.length) {
      this.io.emit("alerts:changed");
      await this.dispatch(instanceId, fired, resolved);
    }
  }

  /** Instance removed or disabled: close its alerts quietly. */
  /** An instance was renamed: its alerts carry on under the new name without being resolved or announced again. */
  rename(from: string, to: string) {
    const f = [...this.firing.entries()].filter(([, a]) => a.instanceId === from);
    for (const [k, a] of f) { this.firing.delete(k); a.instanceId = to; this.firing.set(`${to}\u0000${a.key}`, a); }
    for (const k of [...this.pending.keys()]) {
      if (!k.startsWith(`${from}\u0000`)) continue;
      const v = this.pending.get(k)!;
      this.pending.delete(k);
      this.pending.set(`${to}\u0000${k.slice(from.length + 1)}`, v);
    }
    if (f.length) this.io.emit("alerts:changed");
  }

  clearInstance(instanceId: string) {
    let changed = false;
    for (const [id, a] of this.firing) {
      if (a.instanceId !== instanceId) continue;
      this.store.events.resolve(a.id);
      this.firing.delete(id);
      changed = true;
    }
    for (const id of [...this.pending.keys()]) if (id.startsWith(`${instanceId}\u0000`)) this.pending.delete(id);
    if (changed) this.io.emit("alerts:changed");
  }

  private async dispatch(instanceId: string, fired: Tracked[], resolved: Tracked[], suffix?: string) {
    const line = (a: Tracked) => `- ${a.title}${a.detail ? ` (${a.detail})` : ""}`;
    const many = (list: Tracked[]) => [...list.slice(0, 10).map(line), ...(list.length > 10 ? [`...and ${list.length - 10} more`] : [])];
    const worst = (list: Tracked[]): Severity => (list.some((a) => a.severity === "critical") ? "critical" : list.some((a) => a.severity === "warning") ? "warning" : "info");
    if (fired.length) {
      await this.notify({
        severity: worst(fired), resolved: false, instanceId,
        title: fired.length === 1 ? fired[0].title : `${fired.length} ${suffix ? "alerts" : "new alerts"} on ${instanceId}`,
        lines: [...(fired.length === 1 ? (fired[0].detail ? [fired[0].detail] : []) : many(fired)), ...(suffix ? [`(${suffix})`] : [])],
      });
    }
    if (resolved.length) {
      await this.notify({
        severity: worst(resolved), resolved: true, instanceId,
        title: resolved.length === 1 ? resolved[0].title : `${resolved.length} alerts resolved on ${instanceId}`,
        lines: resolved.length === 1 ? [] : many(resolved),
      });
    }
  }
}
