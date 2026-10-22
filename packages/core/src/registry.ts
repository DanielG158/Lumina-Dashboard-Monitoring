import type { Server } from "socket.io";
import type { FastifyBaseLogger as Logger } from "fastify";
import type { AlertCondition, ModuleDefinition, ModuleInstance, ModuleStatus } from "@lumina/sdk";

export interface InstanceOptions {
  intervalMs?: number | null;
  enabled?: boolean;
  position?: number;
}

export interface PollInfo {
  instanceId: string;
  moduleId: string;
  status: ModuleStatus;
  data: unknown;
  error: string | null;
  failures: number;
  /** null when the poll failed, so nothing is known about module-specific conditions. */
  conditions: AlertCondition[] | null;
  /** Alert key prefixes the module cannot judge in this poll; existing alerts with them are left as they are. */
  unknown: string[];
  metrics: Record<string, number>;
}

export interface InstanceState {
  instanceId: string;
  moduleId: string;
  status: ModuleStatus;
  enabled: boolean;
  data: unknown;
  error: string | null;
  at: number | null;
  intervalMs: number;
  defaultIntervalMs: number;
  minIntervalMs: number;
  customInterval: boolean;
  position: number;
}

interface RunningInstance {
  moduleId: string;
  instanceId: string;
  instance: ModuleInstance;
  intervalMs: number;
  timer: NodeJS.Timeout | null;
  polling: Promise<void> | null;
  lastData: unknown;
  lastStatus: ModuleStatus;
  lastError: string | null;
  failures: number;
  at: number | null;
}

interface Meta {
  moduleId: string;
  instanceId: string;
  enabled: boolean;
  intervalMs: number | null;
  position: number;
}

const DEFAULT_MIN_MS = 5000;
const MAX_INTERVAL_MS = 3_600_000;

export class ModuleRegistry {
  private definitions = new Map<string, ModuleDefinition<any>>();
  private running = new Map<string, RunningInstance>();
  private meta = new Map<string, Meta>();
  redact: (s: InstanceState) => InstanceState = (s) => s;
  onPoll: (info: PollInfo) => void = () => undefined;
  onRemoved: (instanceId: string) => void = () => undefined;

  constructor(private io: Server, private log: Logger) {}

  register(def: ModuleDefinition<any>) {
    this.definitions.set(def.id, def);
    this.log.info({ module: def.id }, "module registered");
  }

  list() {
    return [...this.definitions.values()].map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      multiInstance: d.multiInstance,
      fields: d.fields,
      pollIntervalMs: d.pollIntervalMs,
      minPollIntervalMs: d.minPollIntervalMs ?? DEFAULT_MIN_MS,
    }));
  }

  fieldsOf(moduleId: string) {
    return this.definitions.get(moduleId)?.fields ?? [];
  }

  clampInterval(moduleId: string, ms: number) {
    const min = this.definitions.get(moduleId)?.minPollIntervalMs ?? DEFAULT_MIN_MS;
    return Math.min(MAX_INTERVAL_MS, Math.max(min, Math.round(ms)));
  }

  private effectiveInterval(meta: Meta, def: ModuleDefinition<any>) {
    return this.clampInterval(meta.moduleId, meta.intervalMs ?? def.pollIntervalMs);
  }

  async start(moduleId: string, instanceId: string, rawConfig: unknown, opts: InstanceOptions = {}) {
    const def = this.definitions.get(moduleId);
    if (!def) throw new Error(`unknown module: ${moduleId}`);

    const previous = this.meta.get(instanceId);
    const meta: Meta = {
      moduleId,
      instanceId,
      enabled: opts.enabled ?? previous?.enabled ?? true,
      intervalMs: opts.intervalMs !== undefined ? opts.intervalMs : previous?.intervalMs ?? null,
      position: opts.position ?? previous?.position ?? this.meta.size + 1,
    };

    if (!meta.enabled) {
      await this.stop(instanceId);
      this.meta.set(instanceId, meta);
      this.broadcast(this.stateOf(meta));
      return;
    }

    // Validate and build the new instance before touching the running one, so a bad edit never kills a working instance.
    const config = def.configSchema.parse(rawConfig);
    const childLog = this.log.child({ module: moduleId, instance: instanceId });
    const instance = await def.create(config, {
      instanceId,
      log: {
        info: (m, meta) => childLog.info(meta, m),
        warn: (m, meta) => childLog.warn(meta, m),
        error: (m, meta) => childLog.error(meta, m),
      },
      emit: (event, payload) => this.io.emit(`module:${instanceId}:${event}`, payload),
    });

    await this.stop(instanceId);
    this.meta.set(instanceId, meta);

    const entry: RunningInstance = {
      moduleId,
      instanceId,
      instance,
      intervalMs: this.effectiveInterval(meta, def),
      timer: null,
      polling: null,
      lastData: null,
      lastStatus: "disconnected",
      lastError: null,
      failures: 0,
      at: null,
    };
    this.running.set(instanceId, entry);
    await this.tick(entry);
    this.schedule(entry);
  }

  private schedule(entry: RunningInstance) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      await this.tick(entry);
      if (this.running.get(entry.instanceId) === entry) this.schedule(entry);
    }, entry.intervalMs);
  }

  /** Polls now. A poll already in flight is shared instead of starting a second one. */
  private tick(entry: RunningInstance): Promise<void> {
    if (entry.polling) return entry.polling;
    entry.polling = this.pollOnce(entry).finally(() => {
      entry.polling = null;
    });
    return entry.polling;
  }

  private async pollOnce(entry: RunningInstance) {
    let conditions: AlertCondition[] | null = null;
    let unknown: string[] = [];
    let metrics: Record<string, number> = {};
    try {
      entry.lastData = await entry.instance.poll();
      entry.lastStatus = await entry.instance.status();
      entry.lastError = null;
      entry.failures = 0;
      try {
        const raised = entry.instance.alerts?.(entry.lastData) ?? [];
        conditions = Array.isArray(raised) ? raised : raised.conditions;
        unknown = Array.isArray(raised) ? [] : raised.unknown;
        metrics = entry.instance.metrics?.(entry.lastData) ?? {};
      } catch (err) {
        this.log.warn({ err, instance: entry.instanceId }, "alert/metric extraction failed");
      }
    } catch (err) {
      entry.failures += 1;
      entry.lastError = err instanceof Error ? err.message : String(err);
      entry.lastStatus = entry.failures >= 3 ? "disconnected" : "degraded";
      this.log.warn({ err, instance: entry.instanceId }, "poll failed");
    }
    entry.at = Date.now();
    try {
      this.onPoll({
        instanceId: entry.instanceId,
        moduleId: entry.moduleId,
        status: entry.lastStatus,
        data: entry.lastData,
        error: entry.lastError,
        failures: entry.failures,
        conditions,
        unknown,
        metrics,
      });
    } catch (err) {
      this.log.error({ err }, "onPoll hook failed");
    }
    this.broadcast(this.stateOf(this.meta.get(entry.instanceId)!, entry));
  }

  /** Signed-in sockets get everything; anonymous viewers get the redacted version. */
  private broadcast(state: InstanceState) {
    this.io.to("auth").emit("module:update", state);
    this.io.to("anon").emit("module:update", this.redact(state));
  }

  async refresh(instanceId: string) {
    const entry = this.running.get(instanceId);
    if (!entry) throw new Error(`instance not running: ${instanceId}`);
    await this.tick(entry);
    this.schedule(entry);
  }

  /** Stops polling and disposes the instance; its settings stay registered. */
  async stop(instanceId: string) {
    const entry = this.running.get(instanceId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.running.delete(instanceId);
    await entry.instance.dispose?.();
  }

  /** Stops an instance and forgets it without announcing a removal (used when it is renamed and carries on under another name). */
  async drop(instanceId: string) {
    await this.stop(instanceId);
    this.meta.delete(instanceId);
  }

  async remove(instanceId: string) {
    await this.stop(instanceId);
    this.meta.delete(instanceId);
    this.onRemoved(instanceId);
  }

  setOrder(ids: string[]) {
    ids.forEach((id, i) => {
      const m = this.meta.get(id);
      if (m) m.position = i + 1;
    });
  }

  private stateOf(meta: Meta, entry?: RunningInstance): InstanceState {
    const def = this.definitions.get(meta.moduleId)!;
    return {
      instanceId: meta.instanceId,
      moduleId: meta.moduleId,
      status: meta.enabled ? entry?.lastStatus ?? "disconnected" : "disabled",
      enabled: meta.enabled,
      data: meta.enabled ? entry?.lastData ?? null : null,
      error: meta.enabled ? entry?.lastError ?? null : null,
      at: entry?.at ?? null,
      intervalMs: this.effectiveInterval(meta, def),
      defaultIntervalMs: def.pollIntervalMs,
      minIntervalMs: def.minPollIntervalMs ?? DEFAULT_MIN_MS,
      customInterval: meta.intervalMs !== null,
      position: meta.position,
    };
  }

  snapshot(forViewer = false): InstanceState[] {
    const all = [...this.meta.values()]
      .sort((a, b) => a.position - b.position || a.instanceId.localeCompare(b.instanceId))
      .map((m) => this.stateOf(m, this.running.get(m.instanceId)));
    return forViewer ? all.map((s) => this.redact(s)) : all;
  }

  state(instanceId: string): InstanceState | null {
    const m = this.meta.get(instanceId);
    return m ? this.stateOf(m, this.running.get(instanceId)) : null;
  }

  async runAction(instanceId: string, actionId: string, input: unknown) {
    const entry = this.running.get(instanceId);
    if (!entry) throw new Error(`instance not running: ${instanceId}`);
    const action = entry.instance.actions.find((a) => a.id === actionId);
    if (!action) throw new Error(`unknown action: ${actionId}`);
    const parsed = action.input ? action.input.parse(input) : input;
    const result = await action.run(parsed, {
      instanceId,
      log: {
        info: (m, meta) => this.log.info(meta, m),
        warn: (m, meta) => this.log.warn(meta, m),
        error: (m, meta) => this.log.error(meta, m),
      },
      emit: (event, payload) => this.io.emit(`module:${instanceId}:${event}`, payload),
    });
    void this.tick(entry);
    return result;
  }

  schedulableActions(instanceId: string) {
    return (this.running.get(instanceId)?.instance.actions ?? []).filter((a) => a.schedulable).map((a) => ({ id: a.id, label: a.label, dangerous: !!a.dangerous }));
  }

  actionInfo(instanceId: string, actionId: string) {
    return this.running.get(instanceId)?.instance.actions.find((a) => a.id === actionId) ?? null;
  }
}
