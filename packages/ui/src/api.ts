export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "textarea" | "password" | "number" | "boolean";
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: string | number | boolean;
}

export interface ModuleInfo {
  id: string;
  name: string;
  description: string;
  multiInstance: boolean;
  fields: ConfigField[];
  pollIntervalMs: number;
  minPollIntervalMs: number;
}

export type InstanceStatus = "connected" | "degraded" | "disconnected" | "disabled";
export type Severity = "info" | "warning" | "critical";
export type Role = "viewer" | "operator" | "admin";

export interface InstanceUpdate {
  instanceId: string;
  moduleId: string;
  status: InstanceStatus;
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

export interface ActiveAlert {
  id: number;
  instanceId: string;
  key: string;
  severity: Severity;
  title: string;
  detail: string | null;
  since: number;
  /** a maintenance window is muting this alert's instance */
  suppressed: boolean;
  maintenance: string | null;
}

export interface EventRow {
  id: number;
  ts: number;
  instanceId: string;
  key: string;
  severity: Severity;
  title: string;
  detail: string | null;
  state: "firing" | "resolved";
  resolvedTs: number | null;
}

export interface AlertsPayload {
  active: ActiveAlert[];
  recent: EventRow[];
  muted: string[];
}

export interface AuthStatus {
  setupRequired: boolean;
  setupCodeRequired: boolean;
  openAccess: boolean;
  publicView: boolean;
  user: { id: number; username: string; role: "operator" | "admin" } | null;
}

export interface UserInfo {
  id: number;
  username: string;
  role: "operator" | "admin";
  createdAt: number;
  lastLogin: number | null;
}

export interface Channel {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  minSeverity: Severity;
  lastError: string | null;
  lastSentAt: number | null;
  config: Record<string, string>;
  secretsSet: string[];
}

export interface ChannelType {
  id: string;
  name: string;
  fields: { key: string; label: string; type: "text" | "password"; required?: boolean; placeholder?: string; help?: string }[];
}

export interface AppSettings {
  forecastWarnDays: number;
  sessionIdleMinutes: number;
  alertConfirmPolls: number;
  metricsRetentionDays: number;
  muted: string[];
  publicView: boolean;
}

export interface AuditEntry {
  id: number;
  ts: number;
  user: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
}

export interface MetricSeries {
  range: string;
  since: number;
  series: Record<string, [number, number, number, number][]>;
}

export interface ServerInfo {
  version: string;
  dataDir: string;
  running: { port: number; https: boolean; redirectPort: number; selfSigned: boolean };
  config: { port: number; tls: "off" | "auto" | "custom"; httpRedirectPort: number; names: string[]; hsts: boolean };
  overridden: string[];
  certificate: { subject: string; validTo: string; validFrom: string; altNames: string } | null;
  restartSupported: boolean;
  restoredFrom: string | null;
}

export interface MaintenanceWindow {
  id: number;
  name: string;
  scope: string[];
  startTs: number;
  durationS: number;
  repeat: "none" | "daily" | "weekly";
  enabled: boolean;
  note: string | null;
  createdBy: string | null;
}
export interface ActiveMaintenance { id: number; name: string; scope: string[]; endsAt: number; note: string | null; recurring: boolean }
export interface UpcomingMaintenance { id: number; name: string; scope: string[]; start: number; end: number; recurring: boolean }
export interface MaintenanceStatus { now: number; active: ActiveMaintenance[]; upcoming: UpcomingMaintenance[]; windows: MaintenanceWindow[] }

export interface ScheduleRow {
  id: number;
  name: string;
  instanceId: string;
  actionId: string;
  input: Record<string, unknown>;
  repeat: "once" | "daily" | "weekly";
  atTs: number;
  enabled: boolean;
  lastRunTs: number | null;
  lastStatus: string | null;
  lastMessage: string | null;
  nextRun: number | null;
}
export interface ScheduleTarget { instanceId: string; moduleId: string; actions: { id: string; label: string; dangerous: boolean }[] }

export interface Forecast {
  instanceId: string;
  key: string;
  name: string;
  node: string;
  currentPct: number;
  slopePerDay: number | null;
  daysToFull: number | null;
  r2: number | null;
  spanDays: number;
  status: "growing" | "stable" | "shrinking" | "unclear" | "collecting";
}

export interface Currency { symbol: string; code: string; locale: string; decimals: number; position: "before" | "after" }
export interface TouRule { name: string; days: number[]; start: string; end: string; price: number }
export interface EnergySettings {
  source: string;
  calibration: number;
  extraWatts: number;
  gapFill: "estimate" | "off";
  gapFillMaxHours: number;
  timezone: string | null;
  billingDay: number;
  guestSplit: { baselinePct: number; hostPct: number };
  fixedMonthly: number;
  taxPercent: number;
  budgetMonthly: number | null;
  currency: Currency;
  tariff: {
    type: "flat" | "tou" | "tiered";
    flat: { price: number };
    tou: { defaultPrice: number; rules: TouRule[] };
    tiers: { upToKwh: number | null; price: number }[];
  };
}
export interface EnergySource { key: string; kind: "ups" | "server"; instanceId: string; label: string; first: number; last: number }
/** A custom period: two YYYY-MM-DD dates, both days included. */
export interface Period { from: string; to: string }
export interface Money { energy: number; fixed: number; tax: number; total: number }
export interface GuestShare { instanceId: string; vmid: number; kwh: number; cost: number; avgCores: number; hoursRunning: number }
export interface GuestEnergy { serverKwh: number; serverCost: number; hostKwh: number; unattributedKwh: number; coverage: number; list: GuestShare[] }
export interface EnergyResult {
  guests: GuestEnergy | null;
  guestNames: Record<string, { name: string; type: string; node: string }>;
  range: string;
  from: number;
  to: number;
  timezone: string;
  source: EnergySource | null;
  sources: EnergySource[];
  currency: Currency;
  tariffType: "flat" | "tou" | "tiered";
  kwh: number;
  estimatedKwh: number;
  cost: Money;
  avgW: number | null;
  peakW: number | null;
  minW: number | null;
  coverage: number;
  adjustments: { calibration: number; extraWatts: number; gapFill: string };
  granularity: "hour" | "day";
  series: { t: number; label: string; kwh: number; cost: number; avgW: number | null }[];
  byHour: { hour: number; avgW: number }[];
  breakdown: { serverKwh: number; otherKwh: number; serverLabel: string; otherLabel: string; serverShare: number } | null;
  projection: { kwh: number; cost: Money; avgDailyKwh: number; daysLeft: number } | null;
  budget: { amount: number; used: number; projected: number | null; usedPct: number; projectedPct: number | null } | null;
  settingsNote: string | null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.error) message = String(j.error);
    } catch { /* not JSON */ }
    if (res.status === 401 && !path.startsWith("/auth/login") && !path.startsWith("/auth/setup")) {
      window.dispatchEvent(new CustomEvent("lumina:unauthorized"));
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const api = {
  authStatus: () => req<AuthStatus>("/auth/status"),
  skipSetup: (setupCode?: string) => req("/auth/skip-setup", json("POST", { setupCode })),
  setup: (username: string, password: string, setupCode?: string) => req("/auth/setup", json("POST", { username, password, setupCode })),
  probeFingerprint: (url: string) => req<{ fingerprint: string }>("/probe-fingerprint", json("POST", { url })),
  login: (username: string, password: string) => req("/auth/login", json("POST", { username, password })),
  logout: () => req("/auth/logout", { method: "POST" }),
  changePassword: (current: string, next: string) => req("/auth/password", json("POST", { current, next })),

  modules: () => req<ModuleInfo[]>("/modules"),
  instances: () => req<InstanceUpdate[]>("/instances"),
  addInstance: (moduleId: string, instanceId: string, config: unknown, pollIntervalSec?: number | null) =>
    req("/instances", json("POST", { moduleId, instanceId, config, pollIntervalSec })),
  getConfig: (id: string) => req<{ moduleId: string; config: Record<string, unknown>; pollIntervalSec: number | null }>(`/instances/${enc(id)}/config`),
  updateInstance: (id: string, config: unknown, pollIntervalSec?: number | null) => req(`/instances/${enc(id)}`, json("PUT", { config, pollIntervalSec })),
  removeInstance: (id: string) => req(`/instances/${enc(id)}`, { method: "DELETE" }),
  setEnabled: (id: string, enabled: boolean) => req(`/instances/${enc(id)}/enabled`, json("POST", { enabled })),
  reorder: (order: string[]) => req("/instances-order", json("PUT", { order })),
  refresh: (id: string) => req(`/instances/${enc(id)}/refresh`, { method: "POST" }),
  action: (id: string, action: string, input: unknown) => req<{ ok: boolean; result: unknown }>(`/instances/${enc(id)}/actions/${action}`, json("POST", input)),
  metrics: (id: string, keys: string[], range: string) => req<MetricSeries>(`/instances/${enc(id)}/metrics?range=${range}&keys=${keys.map(enc).join(",")}`),
  metricKeys: (id: string) => req<string[]>(`/instances/${enc(id)}/metric-keys`),

  alerts: () => req<AlertsPayload>("/alerts"),
  mute: (key: string) => req("/alerts/mute", json("POST", { key })),
  unmute: (key: string) => req(`/alerts/mute?key=${enc(key)}`, { method: "DELETE" }),

  channelTypes: () => req<ChannelType[]>("/channel-types"),
  channels: () => req<Channel[]>("/channels"),
  addChannel: (c: unknown) => req("/channels", json("POST", c)),
  updateChannel: (id: number, c: unknown) => req(`/channels/${id}`, json("PUT", c)),
  deleteChannel: (id: number) => req(`/channels/${id}`, { method: "DELETE" }),
  testChannel: (id: number) => req<{ ok: boolean; error?: string }>(`/channels/${id}/test`, { method: "POST" }),

  users: () => req<UserInfo[]>("/users"),
  tokens: () => req<{ id: number; name: string; createdAt: number; lastUsed: number | null; createdBy: string | null }[]>("/tokens"),
  createToken: (name: string) => req<{ id: number; name: string; token: string }>("/tokens", json("POST", { name })),
  deleteToken: (id: number) => req(`/tokens/${id}`, { method: "DELETE" }),
  addUser: (username: string, password: string, role: string) => req("/users", json("POST", { username, password, role })),
  updateUser: (id: number, patch: { role?: string; password?: string }) => req(`/users/${id}`, json("PUT", patch)),
  deleteUser: (id: number) => req(`/users/${id}`, { method: "DELETE" }),

  settings: () => req<AppSettings>("/settings"),
  saveSettings: (s: Omit<AppSettings, "muted">) => req("/settings", json("PUT", s)),
  server: () => req<ServerInfo>("/server"),
  saveServer: (c: ServerInfo["config"]) => req<{ restartRequired: boolean; url: string }>("/server", json("PUT", c)),
  uploadCertificate: (cert: string, key: string) => req<{ ok: boolean; certificate: NonNullable<ServerInfo["certificate"]> }>("/server/certificate", json("POST", { cert, key })),
  restart: () => req("/server/restart", { method: "POST" }),
  restore: (bundle: unknown, passphrase: string) => req("/restore", json("POST", { bundle, passphrase })),
  restoreFirstRun: (bundle: unknown, passphrase: string, setupCode?: string) => req<{ ok: boolean; restarting: boolean }>("/auth/restore", json("POST", { bundle, passphrase, setupCode })),
  backup: async (passphrase: string, includeHistory: boolean): Promise<Blob> => {
    const res = await fetch("/api/backup", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase, includeHistory }) });
    if (!res.ok) {
      let m = `${res.status} ${res.statusText}`;
      try { m = (await res.json()).error ?? m; } catch { /* not JSON */ }
      throw new ApiError(res.status, m);
    }
    return res.blob();
  },
  maintenance: () => req<MaintenanceStatus>("/maintenance"),
  startMaintenance: (b: { scope: string[]; minutes: number; name?: string; note?: string }) => req<{ id: number }>("/maintenance/start", json("POST", b)),
  endMaintenance: (id: number) => req(`/maintenance/${id}/end`, { method: "POST" }),
  createWindow: (b: unknown) => req("/maintenance", json("POST", b)),
  updateWindow: (id: number, b: unknown) => req(`/maintenance/${id}`, json("PUT", b)),
  deleteWindow: (id: number) => req(`/maintenance/${id}`, { method: "DELETE" }),

  schedules: () => req<ScheduleRow[]>("/schedules"),
  scheduleTargets: () => req<ScheduleTarget[]>("/schedule-targets"),
  createSchedule: (b: unknown) => req("/schedules", json("POST", b)),
  updateSchedule: (id: number, b: unknown) => req(`/schedules/${id}`, json("PUT", b)),
  setScheduleEnabled: (id: number, enabled: boolean) => req(`/schedules/${id}/enabled`, json("POST", { enabled })),
  runScheduleNow: (id: number) => req(`/schedules/${id}/run-now`, { method: "POST" }),
  deleteSchedule: (id: number) => req(`/schedules/${id}`, { method: "DELETE" }),

  energy: (range: string, tz: string, p?: Period) => req<EnergyResult>(`/energy?range=${range}&tz=${enc(tz)}${p && range === "custom" ? `&from=${p.from}&to=${p.to}` : ""}`),
  energySettings: () => req<{ settings: EnergySettings; sources: EnergySource[] }>("/energy/settings"),
  saveEnergySettings: (s: EnergySettings) => req("/energy/settings", json("PUT", s)),
  previewEnergy: (settings: EnergySettings, range: string, tz: string, p?: Period) => req<EnergyResult>("/energy/preview", json("POST", { settings, range, tz, ...(range === "custom" && p ? p : {}) })),
  calibrate: (b: { from: number; to: number; meterKwh: number }) =>
    req<{ source: EnergySource; luminaKwh: number; estimatedKwh: number; coverage: number; meterKwh: number; factor: number }>("/energy/calibrate", json("POST", b)),
  forecast: () => req<Forecast[]>("/forecast"),

  audit: (limit = 150) => req<AuditEntry[]>(`/audit?limit=${limit}`),
};
