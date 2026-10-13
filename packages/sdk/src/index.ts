import type { z } from "zod";

export type ModuleStatus = "connected" | "degraded" | "disconnected" | "disabled";

export interface ModuleContext {
  instanceId: string;
  log: {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
  };
  emit: (event: string, payload: unknown) => void;
}

export interface ModuleAction<TInput = any> {
  id: string;
  label: string;
  dangerous?: boolean;
  /** Lowest role allowed to run this action. Defaults to "operator"; use "admin" for configuration changes. */
  minRole?: "operator" | "admin";
  /** May be run by a schedule (the core still checks the input and the instance). Leave off for anything that should stay manual. */
  schedulable?: boolean;
  /** Running this action takes things down on purpose: the core opens a maintenance window (all instances) for this many minutes. */
  plannedDowntimeMinutes?: number;
  input?: z.ZodType<TInput, any, any>;
  run: (input: TInput, ctx: ModuleContext) => Promise<unknown>;
}

export type AlertSeverity = "info" | "warning" | "critical";

/** Alerts whose key starts with one of the `unknown` prefixes are left untouched when a module cannot judge them yet (e.g. data still loading). */
/** A problem that is currently true. The core tracks when each key appears and disappears. */
export interface AlertCondition {
  key: string;
  severity: AlertSeverity;
  title: string;
  detail?: string;
}

export interface ModuleInstance {
  poll: () => Promise<unknown>;
  status: () => Promise<ModuleStatus>;
  actions: ModuleAction[];
  /** Conditions that are firing for the data returned by the latest poll(). */
  alerts?: (data: any) => AlertCondition[] | { conditions: AlertCondition[]; unknown: string[] };
  /** Numeric samples to keep as history (sparklines). Keys are stable names, values are numbers. */
  metrics?: (data: any) => Record<string, number>;
  dispose?: () => Promise<void>;
}

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean";
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: string | number | boolean;
}

export interface ModuleDefinition<TConfig = unknown> {
  id: string;
  name: string;
  description: string;
  fields: ConfigField[];
  configSchema: z.ZodType<TConfig, any, any>;
  pollIntervalMs: number;
  /** Lowest refresh interval a user may choose (default 5000). */
  minPollIntervalMs?: number;
  multiInstance: boolean;
  create: (config: TConfig, ctx: ModuleContext) => Promise<ModuleInstance>;
}

export * from "./http.js";

export function defineModule<TConfig>(def: ModuleDefinition<TConfig>): ModuleDefinition<TConfig> {
  return def;
}
