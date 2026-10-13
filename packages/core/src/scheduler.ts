import type { ScheduleRow, Store } from "./db.js";
import type { ModuleRegistry } from "./registry.js";
import type { Notification } from "./notify.js";

const PERIOD = { daily: 86400, weekly: 604800 } as const;
const nowS = () => Math.floor(Date.now() / 1000);
/** How late a run may start and still count (the service may have been restarting). Later than this and it is skipped. */
const GRACE = { once: 3600, daily: 1800, weekly: 1800 } as const;

export interface DueRun {
  /** the occurrence time this run belongs to */
  at: number;
}

/** The occurrence that is due now (or most recently passed) and has not run yet; null if none. */
export function dueOccurrence(s: ScheduleRow, now: number): number | null {
  if (!s.enabled || now < s.atTs) return null;
  const at = s.repeat === "once" ? s.atTs : s.atTs + Math.floor((now - s.atTs) / PERIOD[s.repeat]) * PERIOD[s.repeat];
  if (s.lastRunTs !== null && s.lastRunTs >= at) return null;
  return at;
}

export function nextRun(s: ScheduleRow, now: number): number | null {
  if (!s.enabled) return null;
  if (s.repeat === "once") return s.lastRunTs !== null ? null : s.atTs;
  if (now < s.atTs) return s.atTs;
  const n = Math.floor((now - s.atTs) / PERIOD[s.repeat]);
  const current = s.atTs + n * PERIOD[s.repeat];
  return s.lastRunTs !== null && s.lastRunTs >= current ? current + PERIOD[s.repeat] : current;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private store: Store,
    private registry: ModuleRegistry,
    private notify: (n: Notification) => Promise<void>,
    private log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void },
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick(), 20_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = nowS()) {
    if (this.running) return;
    this.running = true;
    try {
      for (const s of this.store.schedules.list()) {
        const at = dueOccurrence(s, now);
        if (at === null) continue;
        if (now - at > GRACE[s.repeat]) {
          this.store.schedules.recordRun(s.id, at, "missed", `Skipped: it was due ${Math.round((now - at) / 60)} minutes ago and Lumina was not running or the instance was unavailable`);
          continue;
        }
        await this.run(s, at);
      }
    } finally {
      this.running = false;
    }
  }

  async run(s: ScheduleRow, at: number) {
    let status = "ok";
    let message: string | null = null;
    try {
      const info = this.registry.actionInfo(s.instanceId, s.actionId);
      if (!info) throw new Error(`"${s.actionId}" is not available on ${s.instanceId} (is the instance paused?)`);
      if (!info.schedulable) throw new Error(`"${s.actionId}" cannot be scheduled`);
      const result = await this.registry.runAction(s.instanceId, s.actionId, s.input);
      message = result === undefined || result === null ? null : JSON.stringify(result).slice(0, 300);
      this.log.info({ schedule: s.name, instance: s.instanceId, action: s.actionId }, "scheduled action ran");
    } catch (err) {
      status = "failed";
      message = err instanceof Error ? err.message : String(err);
      this.log.warn({ schedule: s.name, err: message }, "scheduled action failed");
      await this.notify({ severity: "warning", resolved: false, instanceId: s.instanceId, title: `Scheduled action failed: ${s.name}`, lines: [message] });
    }
    this.store.schedules.recordRun(s.id, at, status, message);
    this.store.audit.add("scheduler", status === "ok" ? "scheduled-action" : "scheduled-action-failed", `${s.instanceId}/${s.actionId}`, `${s.name}${message ? `: ${message}` : ""}`.slice(0, 300), null);
  }
}
