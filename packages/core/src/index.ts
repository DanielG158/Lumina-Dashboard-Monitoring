import { uptime as osUptime } from "node:os";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { Server as SocketServer } from "socket.io";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { X509Certificate, createPrivateKey, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import proxmox from "@lumina/module-proxmox";
import apcupsd from "@lumina/module-apcupsd";
import ilo4 from "@lumina/module-ilo4";
import iloSnmp from "@lumina/module-ilo-snmp";
import luminaRemote from "@lumina/module-lumina-remote";
import netcheck from "@lumina/module-netcheck";
import omada from "@lumina/module-omada";
import tplinkRouter from "@lumina/module-tplink-router";
import snmpModule from "@lumina/module-snmp";
import cloudflare from "@lumina/module-cloudflare";
import uptimeKuma from "@lumina/module-uptime-kuma";
import { openDb } from "./db.js";
import { ModuleRegistry } from "./registry.js";
import { AlertEngine } from "./alerts.js";
import { MetricsRecorder, RANGES } from "./metrics.js";
import { CHANNEL_TYPES, createNotifier, deliver } from "./notify.js";
import { loadTls, startHttpRedirect } from "./tls.js";
import { redactState } from "./redact.js";
import { sha256 } from "./crypto.js";
import { Maintenance } from "./maintenance.js";
import { Scheduler, nextRun } from "./scheduler.js";
import { EnergySettingsSchema, MAX_CUSTOM_DAYS, RANGE_NAMES, computeEnergy, formatMoney, listSources, loadEnergySettings, rawKwhBetween, rollupEnergy } from "./energy.js";
import { forecastConditions, forecastStorage, type StorageForecast } from "./forecast.js";
import { checkSetupCode, clearSetupCode, ensureSetupCode, setupCodeRequired } from "./setup-code.js";
import { connect as tlsConnect } from "node:tls";
import { DEFAULT_CONFIG, applyPendingRestore, dataDir, dbPath, ensureDataDir, envOverrides, loadServerConfig, quarantineConfig, readFileConfig, restartSupported, saveFileConfig } from "./config.js";
import { createBackup, openBackup, stageRestore, type BackupBundle } from "./backup.js";
import { PUBLIC_PATHS, clientIp, createAuth, parseCookies, registerAuthRoutes, requireRole } from "./auth.js";

process.umask(0o077); // everything Lumina writes (database, key, certificates, config) is private to its own user
ensureDataDir();
const restoredFrom = applyPendingRestore();
const DB_PATH = dbPath();
const serverConfig = loadServerConfig();
const PORT = serverConfig.port;
const VERSION = process.env.npm_package_version ?? "0.1.0";
const UI_DIR = resolve(process.env.LUMINA_UI_DIR ?? fileURLToPath(new URL("../../ui/dist", import.meta.url)));

let tls: ReturnType<typeof loadTls> = null;
try {
  tls = loadTls(serverConfig, dataDir(), { info: (o, m) => console.log(m, JSON.stringify(o)) });
} catch (err) {
  console.error("Could not set up HTTPS:", err instanceof Error ? err.message : err);
  if (quarantineConfig()) console.error("The saved server settings were set aside; Lumina will start with defaults.");
  process.exit(1);
}
// With TLS on, Fastify serves HTTPS directly; the cast keeps the rest of the code on the common FastifyInstance type.
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, ...(tls ? { https: { key: tls.key, cert: tls.cert } } : {}) }) as unknown as FastifyInstance;
await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });

const store = openDb(DB_PATH);

const settings = () => ({
  sessionIdleMinutes: store.settings.get("sessionIdleMinutes", 480),
  alertConfirmPolls: store.settings.get("alertConfirmPolls", 2),
  metricsRetentionDays: store.settings.get("metricsRetentionDays", 14),
  forecastWarnDays: store.settings.get("forecastWarnDays", 14),
  eventRetentionDays: store.settings.get("eventRetentionDays", 365),
  siteName: store.settings.get<string>("siteName", ""),
  muted: store.settings.get<string[]>("muted", []),
  publicView: store.settings.get("publicView", true),
});
// "Skip setup": until the first account exists, everyone is treated as an admin. Creating any account ends it.
const openAccess = () => store.settings.get("openAccess", false) && store.users.count() === 0;
const OPEN_USER = { id: 0, username: "open-access", role: "admin" as const };
const auth = createAuth(store, () => settings().sessionIdleMinutes);

const io = new SocketServer(app.server, {
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    cb(null, !origin || new URL(origin).host === req.headers.host);
  },
});
io.use((socket, next) => {
  const session = auth.authenticate(socket.request.headers.cookie);
  if (session) socket.data.user = session.user;
  else if (!settings().publicView && !openAccess()) return next(new Error("unauthorized"));
  void socket.join(session || openAccess() ? "auth" : "anon");
  next();
});
app.addHook("onClose", (_, done) => void io.close(() => done()));

const audit = (req: FastifyRequest, action: string, target: string | null = null, detail: string | null = null, user: string | null = null) =>
  store.audit.add(user ?? req.user?.username ?? null, action, target, detail, clientIp(req));

const registry = new ModuleRegistry(io, app.log);
for (const mod of [proxmox, apcupsd, ilo4, cloudflare, uptimeKuma, luminaRemote, netcheck, snmpModule, omada, tplinkRouter, iloSnmp]) registry.register(mod);
registry.redact = redactState;

const notifier = createNotifier(store, app.log);
const maintenance = new Maintenance(store, io);
const engine = new AlertEngine(store, io, (n) => notifier.send(n), () => ({ confirmPolls: settings().alertConfirmPolls, muted: settings().muted }), (id) => maintenance.activeFor(id));

// Storage forecasts are derived from history, so the core (not a module) adds the matching alerts.
let forecastCache: { at: number; list: StorageForecast[] } = { at: 0, list: [] };
const forecasts = () => {
  if (Date.now() - forecastCache.at > 600_000) forecastCache = { at: Date.now(), list: forecastStorage(store) };
  return forecastCache.list;
};
const metrics = new MetricsRecorder(store);

registry.onPoll = (info) => {
  const ok = info.conditions !== null;
  if (ok) metrics.record(info.instanceId, info.metrics);
  if (info.moduleId === "netcheck") {
    const sp = (info.data as { speed?: { at: number; downMbps: number | null; upMbps: number | null; latencyMs: number | null; error: string | null } | null } | null)?.speed;
    if (sp?.at) store.speed.add({ instanceId: info.instanceId, ts: Math.floor(sp.at / 1000), down: sp.downMbps, up: sp.upMbps, latency: sp.latencyMs, error: sp.error });
  }
  const derived = ok && info.moduleId === "proxmox" ? forecastConditions(forecasts(), info.instanceId, settings().forecastWarnDays) : [];
  void engine.evaluate(info.instanceId, { conditions: info.conditions ? [...info.conditions, ...derived] : null, down: info.status === "disconnected" && Date.now() - startedAt >= startupGraceMs, error: info.error, unknown: info.unknown });
};
registry.onRemoved = (id) => {
  engine.clearInstance(id);
  metrics.forget(id);
  store.speed.remove(id);
};

app.setErrorHandler((err: Error & { statusCode?: number; issues?: { path: (string | number)[]; message: string }[] }, req, reply) => {
  if (err.name === "ZodError" && err.issues) {
    return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ") });
  }
  const status = err.statusCode ?? 500;
  if (status >= 500) req.log.error({ err }, "request failed");
  return reply.code(status).send({ error: err.message });
});

// Read-only data that anonymous visitors may fetch while public viewing is on. Everything else needs a signed-in account.
const ANONYMOUS_READS = [/^\/api\/modules$/, /^\/api\/instances$/, /^\/api\/instances\/[^/]+\/metrics$/, /^\/api\/instances\/[^/]+\/metric-keys$/, /^\/api\/alerts$/, /^\/api\/alerts\/history$/, /^\/api\/speedtests$/, /^\/api\/maintenance$/, /^\/api\/energy$/, /^\/api\/forecast$/];

app.addHook("onRequest", async (req, reply) => {
  if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "same-origin");
  if (tls && serverConfig.hsts) reply.header("Strict-Transport-Security", "max-age=31536000");
  reply.header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'");
  const path = req.url.split("?")[0];
  // Decide from the matched route as well as the raw URL, so odd encodings can never slip past the sign-in check.
  const route = req.routeOptions?.url ?? "";
  if (!(path.startsWith("/api/") || route.startsWith("/api/"))) return;
  if (req.method !== "GET" && req.method !== "HEAD" && req.headers.origin) {
    let sameSite = false;
    try { sameSite = new URL(req.headers.origin).host === req.headers.host; } catch { /* malformed origin */ }
    if (!sameSite) return reply.code(403).send({ error: "Cross-site request refused" });
  }
  if (PUBLIC_PATHS.has(path) || PUBLIC_PATHS.has(route)) return;
  const session = auth.authenticate(req.headers.cookie);
  if (session) {
    req.user = session.user;
    req.sessionHash = session.hash;
    return;
  }
  if (openAccess()) {
    req.user = OPEN_USER;
    return;
  }
  if (req.method === "GET" && settings().publicView && ANONYMOUS_READS.some((re) => re.test(path))) return;
  // Another Lumina reading this one: a token allows exactly what anonymous viewing allows, even when public viewing is off.
  const bearer = /^Bearer (lum_[A-Za-z0-9_-]{20,100})$/.exec(String(req.headers.authorization ?? ""))?.[1];
  if (bearer && req.method === "GET" && ANONYMOUS_READS.some((re) => re.test(path))) {
    const t = store.tokens.find(sha256(bearer));
    if (t) {
      if (!t.lastUsed || Date.now() / 1000 - t.lastUsed > 60) store.tokens.touch(t.id);
      return;
    }
  }
  return reply.code(401).send({ error: "Sign in to do this" });
});

const operator = requireRole("operator");
const admin = requireRole("admin");

// Right after the machine boots, the network and the DNS server may not be up yet; nothing is called unreachable until it had a chance.
// The first minutes after a boot are given 120 s of grace. LUMINA_STARTUP_GRACE_SECONDS overrides it (0 switches it off).
const startedAt = Date.now();
const startupGraceMs = Math.max(0, Number(process.env.LUMINA_STARTUP_GRACE_SECONDS ?? (osUptime() < 600 ? 120 : 0))) * 1000;
app.get("/health", async () => ({ ok: true, uptime: Math.round(process.uptime()) }));

registerAuthRoutes(app, store, auth, audit, () => settings().publicView, openAccess, { check: checkSetupCode, clear: clearSetupCode, required: () => store.users.count() === 0 && setupCodeRequired() });
if (store.users.count() === 0 && !openAccess()) ensureSetupCode((code) => console.log(`First-run setup code: ${code}`));
if (store.users.count() > 0) clearSetupCode();

app.post("/api/auth/skip-setup", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
  if (store.users.count() > 0) return reply.code(409).send({ error: "This Lumina already has accounts" });
  if (!checkSetupCode((req.body as { setupCode?: unknown } | null)?.setupCode)) return reply.code(403).send({ error: "Wrong setup code" });
  store.settings.set("openAccess", true);
  audit(req, "open-access-enabled", null, "setup skipped; everyone is an admin until an account is created", "open-access");
  return { ok: true };
});

// ---- modules & instances ---------------------------------------------------------------------------------------

app.get("/api/modules", async () => registry.list());
app.get("/api/instances", async (req) => registry.snapshot(!req.user));

const InstanceName = z.string().trim().min(1).max(64).regex(/^[^\u0000-\u001f/\\]+$/, "Name can't contain slashes or control characters");
const PollSeconds = z.number().min(1).max(3600).nullable().optional();

app.post("/api/instances", { preHandler: admin }, async (req, reply) => {
  const body = z.object({ moduleId: z.string(), instanceId: InstanceName, config: z.record(z.unknown()), pollIntervalSec: PollSeconds }).parse(req.body);
  if (store.instances.get(body.instanceId)) return reply.code(409).send({ error: `An instance named "${body.instanceId}" already exists` });
  const intervalMs = body.pollIntervalSec ? registry.clampInterval(body.moduleId, body.pollIntervalSec * 1000) : null;
  await registry.start(body.moduleId, body.instanceId, body.config, { intervalMs });
  store.instances.save(body.instanceId, body.moduleId, body.config, { pollIntervalMs: intervalMs, enabled: true });
  audit(req, "instance-added", body.instanceId, body.moduleId);
  io.emit("instances:reordered");
  return reply.code(201).send({ ok: true });
});

// Secret fields are never sent back to the browser; a blank value on update keeps the stored one.
app.get("/api/instances/:id/config", { preHandler: admin }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const row = store.instances.get(id);
  if (!row) return reply.code(404).send({ error: "instance not found" });
  const secrets = new Set(registry.fieldsOf(row.moduleId).filter((f) => f.type === "password").map((f) => f.key));
  const config = Object.fromEntries(Object.entries(row.config).filter(([k]) => !secrets.has(k)));
  return { moduleId: row.moduleId, config, pollIntervalSec: row.pollIntervalMs ? row.pollIntervalMs / 1000 : null };
});

app.put("/api/instances/:id", { preHandler: admin }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const row = store.instances.get(id);
  if (!row) return reply.code(404).send({ error: "instance not found" });
  const body = z.object({ config: z.record(z.unknown()), pollIntervalSec: PollSeconds }).parse(req.body);
  const merged = { ...body.config };
  for (const f of registry.fieldsOf(row.moduleId)) {
    if (f.type === "password" && (merged[f.key] === undefined || merged[f.key] === "")) merged[f.key] = row.config[f.key];
  }
  const intervalMs = body.pollIntervalSec === undefined ? row.pollIntervalMs : body.pollIntervalSec ? registry.clampInterval(row.moduleId, body.pollIntervalSec * 1000) : null;
  await registry.start(row.moduleId, id, merged, { intervalMs, enabled: row.enabled });
  store.instances.save(id, row.moduleId, merged, { pollIntervalMs: intervalMs });
  audit(req, "instance-edited", id, intervalMs ? `refresh ${intervalMs / 1000}s` : null);
  io.emit("instances:reordered");
  return { ok: true };
});

// Rename: the name is how history, alerts, schedules and maintenance windows refer to an instance, so all of them are moved too.
app.put("/api/instances/:id/name", { preHandler: admin }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const { name } = z.object({ name: InstanceName }).parse(req.body);
  const row = store.instances.get(id);
  if (!row) return reply.code(404).send({ error: "instance not found" });
  if (name === id) return { ok: true, name };
  if (store.instances.list().some((i) => i.instanceId.toLowerCase() === name.toLowerCase() && i.instanceId !== id)) return reply.code(409).send({ error: `An instance named "${name}" already exists` });
  metrics.flush(); // minute-by-minute history still in memory is saved under the old name first, so it moves too
  await registry.drop(id);
  store.instances.rename(id, name);
  engine.rename(id, name);
  await registry.start(row.moduleId, name, row.config, { intervalMs: row.pollIntervalMs, enabled: row.enabled, position: row.position });
  audit(req, "instance-renamed", id, `${id} -> ${name}`);
  io.emit("instances:reordered");
  io.emit("alerts:changed");
  io.emit("maintenance:changed");
  return { ok: true, name };
});

app.delete("/api/instances/:id", { preHandler: admin }, async (req) => {
  const { id } = req.params as { id: string };
  await registry.remove(id);
  store.instances.delete(id);
  audit(req, "instance-removed", id);
  io.emit("instances:reordered");
  return { ok: true };
});

app.post("/api/instances/:id/enabled", { preHandler: admin }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  const row = store.instances.get(id);
  if (!row) return reply.code(404).send({ error: "instance not found" });
  await registry.start(row.moduleId, id, row.config, { enabled, intervalMs: row.pollIntervalMs });
  store.instances.setEnabled(id, enabled);
  if (!enabled) engine.clearInstance(id);
  audit(req, enabled ? "instance-enabled" : "instance-disabled", id);
  io.emit("instances:reordered");
  return { ok: true };
});

app.put("/api/instances-order", { preHandler: admin }, async (req) => {
  const { order } = z.object({ order: z.array(z.string()) }).parse(req.body);
  store.instances.setOrder(order);
  registry.setOrder(order);
  io.emit("instances:reordered", order);
  return { ok: true };
});

app.post("/api/instances/:id/refresh", { preHandler: operator }, async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!registry.state(id)) return reply.code(404).send({ error: "instance not found" });
  await registry.refresh(id);
  return { ok: true };
});

app.post("/api/instances/:id/actions/:action", { preHandler: operator }, async (req, reply) => {
  const { id, action } = req.params as { id: string; action: string };
  const info = registry.actionInfo(id, action);
  if (info?.minRole === "admin" && req.user!.role !== "admin") return reply.code(403).send({ error: "This action needs the admin role" });
  const result = await registry.runAction(id, action, req.body ?? {});
  audit(req, info?.dangerous ? "action-dangerous" : "action", `${id}/${action}`, JSON.stringify(req.body ?? {}).slice(0, 300));
  if (info?.plannedDowntimeMinutes) {
    // Taking something down on purpose should not page anyone: mute alerts for a while (it can be ended early).
    maintenance.startNow({ scope: ["*"], minutes: info.plannedDowntimeMinutes, name: `Planned: ${info.label}`, note: `Opened automatically by ${id}/${action}`, createdBy: req.user!.username });
    audit(req, "maintenance-auto", id, `${info.plannedDowntimeMinutes} min after ${action}`);
  }
  return { ok: true, result };
});

app.get("/api/instances/:id/metrics", async (req, reply) => {
  const { id } = req.params as { id: string };
  const q = req.query as { keys?: string; range?: string };
  const range = RANGES[q.range ?? "1h"];
  if (!range) return reply.code(400).send({ error: "range must be one of " + Object.keys(RANGES).join(", ") });
  const keys = q.keys ? q.keys.split(",").filter(Boolean).slice(0, 12) : store.metrics.keys(id);
  const since = Math.floor(Date.now() / 1000) - range.seconds;
  const series: Record<string, [number, number, number, number][]> = {};
  for (const k of keys) series[k] = store.metrics.query(id, k, since, range.bucket).map((r) => [r.t, r.v, r.lo, r.hi]);
  return { range: q.range ?? "1h", since, series };
});

app.get("/api/instances/:id/metric-keys", async (req) => store.metrics.keys((req.params as { id: string }).id));

// ---- alerts & notifications ------------------------------------------------------------------------------------

// Access tokens: let another Lumina (or a script) read what an anonymous visitor can see, without public viewing being on.
app.get("/api/tokens", { preHandler: admin }, async () => store.tokens.list());
app.post("/api/tokens", { preHandler: admin }, async (req) => {
  const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
  const token = `lum_${randomBytes(24).toString("base64url")}`;
  const id = store.tokens.create(name, sha256(token), req.user?.username ?? null);
  audit(req, "token-created", name);
  return { id, name, token };
});
app.delete("/api/tokens/:id", { preHandler: admin }, async (req, reply) => {
  const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
  if (!store.tokens.delete(id)) return reply.code(404).send({ error: "No such token" });
  audit(req, "token-revoked", String(id));
  return { ok: true };
});

app.get("/api/alerts", async () => ({ active: engine.active(), recent: store.events.recent(100), muted: settings().muted }));

// The full alert history, with filters and paging. Anonymous visitors may read it, exactly like the recent list.
app.get("/api/alerts/history", async (req) => {
  const q = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.coerce.number().int().min(1).optional(),
    instance: z.string().max(100).optional(),
    severity: z.enum(["critical", "warning", "info"]).optional(),
    state: z.enum(["firing", "resolved"]).optional(),
    q: z.string().trim().max(100).optional(),
    since: z.coerce.number().int().min(0).optional(),
  }).parse(req.query);
  return { ...store.events.search({ ...q, q: q.q || undefined }), instances: store.events.instances() };
});

// Internet speed test results, newest first. Readable like the other history.
app.get("/api/speedtests", async (req) => {
  const q = z.object({ instance: z.string().max(100).optional(), since: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
  return store.speed.list(q);
});

app.post("/api/alerts/mute", { preHandler: operator }, async (req) => {
  const { key } = z.object({ key: z.string().min(1).max(200) }).parse(req.body);
  const muted = new Set(settings().muted);
  muted.add(key);
  store.settings.set("muted", [...muted]);
  audit(req, "alert-muted", key);
  io.emit("alerts:changed");
  return { ok: true };
});

app.delete("/api/alerts/mute", { preHandler: operator }, async (req) => {
  const { key } = z.object({ key: z.string().min(1) }).parse(req.query);
  store.settings.set("muted", settings().muted.filter((k) => k !== key));
  audit(req, "alert-unmuted", key);
  io.emit("alerts:changed");
  return { ok: true };
});

app.get("/api/channel-types", { preHandler: admin }, async () => CHANNEL_TYPES);

const secretKeys = (type: string) => new Set((CHANNEL_TYPES.find((t) => t.id === type)?.fields ?? []).filter((f) => f.type === "password").map((f) => f.key));
const ChannelBody = z.object({
  name: z.string().trim().min(1).max(64),
  type: z.string(),
  config: z.record(z.string()),
  enabled: z.boolean().default(true),
  minSeverity: z.enum(["info", "warning", "critical"]).default("warning"),
});

app.get("/api/channels", { preHandler: admin }, async () =>
  store.channels.list().map((c) => {
    const secrets = secretKeys(c.type);
    return {
      id: c.id, name: c.name, type: c.type, enabled: c.enabled, minSeverity: c.minSeverity, lastError: c.lastError, lastSentAt: c.lastSentAt,
      config: Object.fromEntries(Object.entries(c.config).filter(([k]) => !secrets.has(k))),
      secretsSet: Object.keys(c.config).filter((k) => secrets.has(k) && c.config[k]),
    };
  }),
);

function checkChannel(type: string, config: Record<string, string>) {
  const def = CHANNEL_TYPES.find((t) => t.id === type);
  if (!def) throw Object.assign(new Error(`Unknown channel type: ${type}`), { statusCode: 400 });
  for (const f of def.fields) {
    if (f.required && !config[f.key]) throw Object.assign(new Error(`${f.label} is required`), { statusCode: 400 });
  }
}

app.post("/api/channels", { preHandler: admin }, async (req, reply) => {
  const body = ChannelBody.parse(req.body);
  checkChannel(body.type, body.config);
  const id = store.channels.create(body);
  audit(req, "channel-added", body.name, body.type);
  return reply.code(201).send({ id });
});

app.put("/api/channels/:id", { preHandler: admin }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const row = store.channels.get(id);
  if (!row) return reply.code(404).send({ error: "channel not found" });
  const body = ChannelBody.parse(req.body);
  const config = { ...body.config };
  for (const k of secretKeys(row.type)) if (!config[k]) config[k] = row.config[k];
  checkChannel(row.type, config);
  store.channels.update(id, { name: body.name, config, enabled: body.enabled, minSeverity: body.minSeverity });
  audit(req, "channel-edited", body.name);
  return { ok: true };
});

app.delete("/api/channels/:id", { preHandler: admin }, async (req) => {
  const id = Number((req.params as { id: string }).id);
  store.channels.delete(id);
  audit(req, "channel-removed", String(id));
  return { ok: true };
});

app.post("/api/channels/:id/test", { preHandler: admin }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const ch = store.channels.get(id);
  if (!ch) return reply.code(404).send({ error: "channel not found" });
  try {
    await deliver(ch, { severity: "warning", resolved: false, instanceId: "lumina", title: "Test notification from Lumina", lines: [`Sent by ${req.user!.username}. If you can read this, the channel works.`] });
    store.channels.recordResult(id, null);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.channels.recordResult(id, message);
    return { ok: false, error: message };
  }
});

// Reads the certificate a device presents, so the UI can offer to pin it (trust on first use).
app.post("/api/probe-fingerprint", { preHandler: admin }, async (req, reply) => {
  const { url } = z.object({ url: z.string().url() }).parse(req.body);
  const u = new URL(url);
  if (u.protocol !== "https:") return reply.code(400).send({ error: "That address is not HTTPS, so there is no certificate to pin" });
  try {
    const fp = await new Promise<string>((resolve, reject) => {
      const sock = tlsConnect({ host: u.hostname, port: Number(u.port || 443), rejectUnauthorized: false, servername: /^[\d.]+$/.test(u.hostname) ? undefined : u.hostname, timeout: 6000 }, () => {
        const c = sock.getPeerCertificate();
        sock.end();
        c?.fingerprint256 ? resolve(c.fingerprint256) : reject(new Error("The device did not present a certificate"));
      });
      sock.on("error", reject);
      sock.on("timeout", () => { sock.destroy(); reject(new Error("Timed out connecting")); });
    });
    return { fingerprint: fp };
  } catch (err) {
    return reply.code(502).send({ error: `Could not read the certificate: ${err instanceof Error ? err.message : err}` });
  }
});

// ---- settings & audit ------------------------------------------------------------------------------------------

app.get("/api/settings", { preHandler: admin }, async () => settings());

app.put("/api/settings", { preHandler: admin }, async (req) => {
  const body = z.object({
    sessionIdleMinutes: z.number().int().min(5).max(7 * 24 * 60),
    alertConfirmPolls: z.number().int().min(1).max(10),
    metricsRetentionDays: z.number().int().min(1).max(365),
    forecastWarnDays: z.number().int().min(1).max(365).default(14),
    eventRetentionDays: z.number().int().min(7).max(3650).default(365),
    siteName: z.string().trim().max(40).default(""),
    publicView: z.boolean(),
  }).parse(req.body);
  for (const [k, v] of Object.entries(body)) store.settings.set(k, v);
  audit(req, "settings-changed", null, JSON.stringify(body));
  return { ok: true };
});

app.get("/api/audit", { preHandler: admin }, async (req) => {
  const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
  return store.audit.list(q.limit, q.offset);
});

// ---- server settings, backup & restore ------------------------------------------------------------------------

const certInfo = (pem: Buffer | string) => {
  const x = new X509Certificate(pem);
  return { subject: x.subject.replace(/\n/g, ", "), validTo: x.validTo, validFrom: x.validFrom, altNames: x.subjectAltName ?? "" };
};

app.get("/api/server", { preHandler: admin }, async () => ({
  version: VERSION,
  dataDir: dataDir(),
  running: { port: PORT, https: !!tls, redirectPort: tls ? serverConfig.httpRedirectPort : 0, selfSigned: tls?.generated ?? false },
  config: { ...DEFAULT_CONFIG, ...readFileConfig() },
  overridden: envOverrides(),
  certificate: tls ? certInfo(tls.cert) : null,
  restartSupported: restartSupported(),
  restoredFrom,
}));

const Names = z.array(z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.\-:]+$/, "Names can only contain letters, numbers, dots, dashes and colons")).max(20);
const ServerBody = z.object({
  port: z.number().int().min(1).max(65535),
  tls: z.enum(["off", "auto", "custom"]),
  httpRedirectPort: z.number().int().min(0).max(65535),
  names: Names,
  hsts: z.boolean(),
});

app.put("/api/server", { preHandler: admin }, async (req, reply) => {
  const body = ServerBody.parse(req.body);
  if (body.httpRedirectPort && body.httpRedirectPort === body.port) return reply.code(400).send({ error: "The redirect port must differ from the main port" });
  if (body.tls === "custom" && !existsSync(`${dataDir()}/tls/custom.crt`)) return reply.code(400).send({ error: "Upload a certificate first, or choose another HTTPS mode" });
  saveFileConfig(body);
  audit(req, "server-settings-changed", null, JSON.stringify({ ...body, names: body.names.length }));
  const host = (req.headers.host ?? "localhost").replace(/:\d+$/, "");
  const https = body.tls !== "off";
  return { restartRequired: true, url: `${https ? "https" : "http"}://${host}${(https ? body.port === 443 : body.port === 80) ? "" : `:${body.port}`}/` };
});

app.post("/api/server/certificate", { preHandler: admin }, async (req, reply) => {
  const body = z.object({ cert: z.string().min(50).max(100_000), key: z.string().min(50).max(100_000) }).parse(req.body);
  let info;
  try {
    const x = new X509Certificate(body.cert);
    if (!x.checkPrivateKey(createPrivateKey(body.key))) return reply.code(400).send({ error: "That private key does not belong to that certificate" });
    info = certInfo(body.cert);
  } catch {
    return reply.code(400).send({ error: "Could not read the certificate or key. Paste PEM text (-----BEGIN CERTIFICATE----- ...) and an unencrypted private key." });
  }
  const dir = `${dataDir()}/tls`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(`${dir}/custom.crt`, body.cert, { mode: 0o600 });
  writeFileSync(`${dir}/custom.key`, body.key, { mode: 0o600 });
  chmodSync(`${dir}/custom.key`, 0o600);
  saveFileConfig({ ...DEFAULT_CONFIG, ...readFileConfig(), tls: "custom" });
  audit(req, "certificate-uploaded", info.subject, `valid until ${info.validTo}`);
  return { ok: true, certificate: info, restartRequired: true };
});

function scheduleRestart() {
  setTimeout(() => process.exit(0), 700);
}

app.post("/api/server/restart", { preHandler: admin }, async (req, reply) => {
  if (!restartSupported()) return reply.code(409).send({ error: "Lumina can't restart itself here because no service manager was detected. Restart it from the host." });
  audit(req, "restart");
  scheduleRestart();
  return { ok: true };
});

const BackupBody = z.object({ passphrase: z.string().min(8).max(200), includeHistory: z.boolean().default(false) });

app.post("/api/backup", { preHandler: admin }, async (req, reply) => {
  const body = BackupBody.parse(req.body);
  const bundle = await createBackup(store, body.passphrase, body.includeHistory);
  audit(req, "backup-created", null, body.includeHistory ? "with history" : "settings only");
  return reply
    .header("Content-Disposition", `attachment; filename="lumina-backup-${new Date().toISOString().slice(0, 10)}.json"`)
    .type("application/json")
    .send(bundle);
});

const RestoreBody = z.object({ passphrase: z.string().min(1).max(200), bundle: z.record(z.unknown()), setupCode: z.string().optional() });

async function stageFromBundle(raw: unknown) {
  const body = RestoreBody.parse(raw);
  const { db, key } = await openBackup(body.bundle as unknown as BackupBundle, body.passphrase);
  stageRestore(db, key);
}

app.post("/api/restore", { preHandler: admin, bodyLimit: 100 * 1024 * 1024 }, async (req) => {
  await stageFromBundle(req.body);
  audit(req, "restore-staged", null, "takes effect on restart");
  return { ok: true, restartRequired: true };
});

// Before any account exists a brand-new install may restore a backup from another Lumina.
app.post("/api/auth/restore", { bodyLimit: 100 * 1024 * 1024, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
  if (store.users.count() > 0) return reply.code(409).send({ error: "This Lumina is already set up. Sign in as an admin and restore from Settings." });
  if (!checkSetupCode((req.body as { setupCode?: unknown } | null)?.setupCode)) return reply.code(403).send({ error: "Wrong setup code" });
  await stageFromBundle(req.body);
  audit(req, "restore-staged", null, "first-run restore");
  if (restartSupported()) scheduleRestart();
  return { ok: true, restarting: restartSupported() };
});

// ---- maintenance windows ---------------------------------------------------------------------------------------

const Scope = z.array(z.string().min(1).max(64)).min(1).max(50);
const cleanScope = (scope: string[]) => {
  if (scope.includes("*")) return ["*"];
  const unknown = scope.filter((id) => !registry.state(id));
  if (unknown.length) throw Object.assign(new Error(`Unknown instance: ${unknown.join(", ")}`), { statusCode: 400 });
  return scope;
};
const WindowBody = z.object({
  name: z.string().trim().min(1).max(80),
  scope: Scope,
  startTs: z.number().int().min(0),
  durationMinutes: z.number().min(1).max(7 * 24 * 60),
  repeat: z.enum(["none", "daily", "weekly"]).default("none"),
  note: z.string().max(300).nullable().optional(),
});
const checkWindow = (b: z.infer<typeof WindowBody>) => {
  const period = b.repeat === "daily" ? 86400 : b.repeat === "weekly" ? 604800 : Infinity;
  if (b.durationMinutes * 60 >= period) throw Object.assign(new Error("A repeating window must be shorter than its repeat interval"), { statusCode: 400 });
};

app.get("/api/maintenance", async (req) => {
  const st = maintenance.status();
  if (req.user) return st;
  return { now: st.now, active: st.active.map((a) => ({ ...a, note: null })), upcoming: st.upcoming, windows: [] };
});

app.post("/api/maintenance/start", { preHandler: operator }, async (req) => {
  const b = z.object({ scope: Scope, minutes: z.number().min(1).max(7 * 24 * 60), name: z.string().trim().max(80).optional(), note: z.string().max(300).optional() }).parse(req.body);
  const scope = cleanScope(b.scope);
  const id = maintenance.startNow({ scope, minutes: b.minutes, name: b.name || "Maintenance", note: b.note ?? null, createdBy: req.user!.username });
  audit(req, "maintenance-started", scope.join(", "), `${b.minutes} min${b.name ? `: ${b.name}` : ""}`);
  return { id };
});

app.post("/api/maintenance/:id/end", { preHandler: operator }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (!maintenance.endNow(id)) return reply.code(404).send({ error: "That maintenance window is not running" });
  audit(req, "maintenance-ended", String(id));
  return { ok: true };
});

app.post("/api/maintenance", { preHandler: admin }, async (req, reply) => {
  const b = WindowBody.parse(req.body);
  checkWindow(b);
  const id = maintenance.create({ name: b.name, scope: cleanScope(b.scope), startTs: b.startTs, durationS: Math.round(b.durationMinutes * 60), repeat: b.repeat, note: b.note ?? null, createdBy: req.user!.username });
  audit(req, "maintenance-scheduled", b.name, b.repeat);
  return reply.code(201).send({ id });
});

app.put("/api/maintenance/:id", { preHandler: admin }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (!store.maintenance.get(id)) return reply.code(404).send({ error: "Not found" });
  const b = WindowBody.extend({ enabled: z.boolean().default(true) }).parse(req.body);
  checkWindow(b);
  maintenance.update(id, { name: b.name, scope: cleanScope(b.scope), startTs: b.startTs, durationS: Math.round(b.durationMinutes * 60), repeat: b.repeat, note: b.note ?? null, enabled: b.enabled });
  audit(req, "maintenance-edited", b.name);
  return { ok: true };
});

app.delete("/api/maintenance/:id", { preHandler: admin }, async (req) => {
  const id = Number((req.params as { id: string }).id);
  maintenance.delete(id);
  audit(req, "maintenance-deleted", String(id));
  return { ok: true };
});

// ---- scheduled actions -----------------------------------------------------------------------------------------

const scheduler = new Scheduler(store, registry, (n) => notifier.send(n), app.log);
const SchedBody = z.object({
  name: z.string().trim().min(1).max(80),
  instanceId: z.string().min(1).max(64),
  actionId: z.string().min(1).max(64),
  input: z.record(z.unknown()).default({}),
  repeat: z.enum(["once", "daily", "weekly"]),
  atTs: z.number().int().min(0),
});
function checkSchedule(b: z.infer<typeof SchedBody>) {
  const info = registry.actionInfo(b.instanceId, b.actionId);
  if (!info) throw Object.assign(new Error(`"${b.actionId}" is not available on ${b.instanceId} (is it paused?)`), { statusCode: 400 });
  if (!info.schedulable) throw Object.assign(new Error("That action can only be run by hand"), { statusCode: 400 });
  if (b.repeat === "once" && b.atTs < Math.floor(Date.now() / 1000) - 60) throw Object.assign(new Error("That time is in the past"), { statusCode: 400 });
  return info.input ? (info.input.parse(b.input) as Record<string, unknown>) : b.input;
}

app.get("/api/schedules", { preHandler: operator }, async () => {
  const now = Math.floor(Date.now() / 1000);
  return store.schedules.list().map((s) => ({ ...s, nextRun: nextRun(s, now) }));
});
app.get("/api/schedule-targets", { preHandler: admin }, async () =>
  registry.snapshot().filter((i) => i.enabled).map((i) => ({ instanceId: i.instanceId, moduleId: i.moduleId, actions: registry.schedulableActions(i.instanceId) })),
);
app.post("/api/schedules", { preHandler: admin }, async (req, reply) => {
  const b = SchedBody.parse(req.body);
  const input = checkSchedule(b);
  const id = store.schedules.create({ name: b.name, instanceId: b.instanceId, actionId: b.actionId, input, repeat: b.repeat, atTs: b.atTs, createdBy: req.user!.username });
  audit(req, "schedule-created", `${b.instanceId}/${b.actionId}`, `${b.name} (${b.repeat})`);
  return reply.code(201).send({ id });
});
app.put("/api/schedules/:id", { preHandler: admin }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const row = store.schedules.get(id);
  if (!row) return reply.code(404).send({ error: "Not found" });
  const b = SchedBody.extend({ enabled: z.boolean().default(true) }).parse({ ...(req.body as object), instanceId: row.instanceId, actionId: row.actionId });
  const input = checkSchedule(b);
  store.schedules.update(id, { name: b.name, input, repeat: b.repeat, atTs: b.atTs, enabled: b.enabled });
  audit(req, "schedule-edited", `${row.instanceId}/${row.actionId}`, b.name);
  return { ok: true };
});
app.post("/api/schedules/:id/enabled", { preHandler: admin }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (!store.schedules.get(id)) return reply.code(404).send({ error: "Not found" });
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  store.schedules.setEnabled(id, enabled);
  audit(req, enabled ? "schedule-enabled" : "schedule-disabled", String(id));
  return { ok: true };
});
app.post("/api/schedules/:id/run-now", { preHandler: admin }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const row = store.schedules.get(id);
  if (!row) return reply.code(404).send({ error: "Not found" });
  await scheduler.run(row, Math.floor(Date.now() / 1000));
  audit(req, "schedule-run-now", `${row.instanceId}/${row.actionId}`, row.name);
  return { ok: true, result: store.schedules.get(id) };
});
app.delete("/api/schedules/:id", { preHandler: admin }, async (req) => {
  const id = Number((req.params as { id: string }).id);
  store.schedules.delete(id);
  audit(req, "schedule-deleted", String(id));
  return { ok: true };
});

// ---- energy and cost -------------------------------------------------------------------------------------------

const validTz = (tz: string | undefined) => {
  if (!tz) return null;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch { return null; }
};

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(d)), "not a real date");
const periodQuery = z.object({
  range: z.enum(RANGE_NAMES).default("cycle"), tz: z.string().max(60).optional(),
  from: dateStr.optional(), to: dateStr.optional(),
});
/** Checks the dates of a custom period (start before end, not too long) and returns them. */
function customPeriod(q: { range: string; from?: string; to?: string }): { custom?: { from: string; to: string }; error?: string } {
  if (q.range !== "custom") return {};
  if (!q.from || !q.to) return { error: "Pick a start and an end date" };
  if (q.to < q.from) return { error: "The end date is before the start date" };
  if ((Date.parse(q.to) - Date.parse(q.from)) / 86400000 + 1 > MAX_CUSTOM_DAYS) return { error: `Pick at most ${MAX_CUSTOM_DAYS} days at a time` };
  return { custom: { from: q.from, to: q.to } };
}

/** Adds the guests' current names, which the history does not keep. */
function withGuestNames<T extends { guests: { list: { instanceId: string; vmid: number }[] } | null }>(r: T): T & { guestNames: Record<string, { name: string; type: string; node: string }> } {
  const names: Record<string, { name: string; type: string; node: string }> = {};
  for (const inst of registry.snapshot()) {
    if (inst.moduleId !== "proxmox") continue;
    for (const g of ((inst.data as { guests?: { vmid: number; name: string; type: string; node: string }[] } | null)?.guests ?? [])) names[`${inst.instanceId}:${g.vmid}`] = { name: g.name, type: g.type, node: g.node };
  }
  return { ...r, guestNames: names };
}

app.get("/api/energy", async (req, reply) => {
  const q = periodQuery.parse(req.query);
  const p = customPeriod(q);
  if (p.error) return reply.code(400).send({ error: p.error });
  return withGuestNames(computeEnergy(store, loadEnergySettings(store), q.range, validTz(q.tz), undefined, p.custom));
});
app.get("/api/energy/settings", { preHandler: admin }, async () => ({ settings: loadEnergySettings(store), sources: listSources(store) }));
app.put("/api/energy/settings", { preHandler: admin }, async (req) => {
  const parsed = EnergySettingsSchema.parse(req.body);
  store.settings.set("energy", parsed);
  audit(req, "energy-settings-changed", null, `${parsed.tariff.type} tariff, source ${parsed.source}`);
  evaluateBudget();
  return { ok: true };
});
// "What would this have cost?" without saving anything.
app.post("/api/energy/preview", { preHandler: admin }, async (req, reply) => {
  const b = periodQuery.extend({ settings: z.unknown() }).parse(req.body);
  const p = customPeriod(b);
  if (p.error) return reply.code(400).send({ error: p.error });
  return withGuestNames(computeEnergy(store, EnergySettingsSchema.parse(b.settings), b.range, validTz(b.tz), undefined, p.custom));
});
// Compare Lumina's reading with your electricity meter and suggest the correction factor.
app.post("/api/energy/calibrate", { preHandler: admin }, async (req, reply) => {
  const b = z.object({ from: z.number().int(), to: z.number().int(), meterKwh: z.number().positive().max(1e6) }).parse(req.body);
  if (b.to <= b.from) return reply.code(400).send({ error: "The end must be after the start" });
  const raw = rawKwhBetween(store, loadEnergySettings(store), b.from, b.to);
  if (!raw.source || raw.kwh <= 0) return reply.code(400).send({ error: "Lumina has no power readings for that period" });
  return { source: raw.source, luminaKwh: raw.kwh, estimatedKwh: raw.estimatedKwh, coverage: raw.coverage, meterKwh: b.meterKwh, factor: b.meterKwh / raw.kwh };
});
app.get("/api/forecast", async () => forecasts());

function evaluateBudget() {
  const es = loadEnergySettings(store);
  const conditions: { key: string; severity: "warning" | "critical"; title: string; detail: string }[] = [];
  if (es.budgetMonthly && es.budgetMonthly > 0) {
    const r = computeEnergy(store, es, "cycle", null);
    const used = r.cost.total;
    const projected = r.projection?.cost.total ?? used;
    const money = (n: number) => formatMoney(es.currency, n);
    if (used >= es.budgetMonthly) conditions.push({ key: "energy-budget-exceeded", severity: "critical", title: "Electricity budget exceeded", detail: `${money(used)} spent of ${money(es.budgetMonthly)} this billing cycle` });
    else if (projected > es.budgetMonthly) conditions.push({ key: "energy-budget-projected", severity: "warning", title: "Electricity bill is on course to exceed the budget", detail: `Projected ${money(projected)} against a budget of ${money(es.budgetMonthly)}` });
  }
  void engine.evaluate("Lumina", { conditions, down: false, error: null });
}

// ---- realtime --------------------------------------------------------------------------------------------------

io.on("connection", (socket) => {
  socket.emit("snapshot", registry.snapshot(!socket.rooms.has("auth")));
});

// ---- web UI ----------------------------------------------------------------------------------------------------

if (existsSync(UI_DIR)) {
  await app.register(fastifyStatic, { root: UI_DIR, wildcard: false, index: false });
  const indexHtml = readFileSync(resolve(UI_DIR, "index.html"), "utf8");
  app.get("/", async (_req, reply) => reply.type("text/html").send(indexHtml));
  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split("?")[0];
    if (req.method === "GET" && !path.startsWith("/api/") && !path.startsWith("/socket.io/")) {
      try {
        return await reply.sendFile(path.slice(1));
      } catch {
        return reply.type("text/html").send(indexHtml);
      }
    }
    return reply.code(404).send({ error: "Not found" });
  });
} else {
  app.log.warn({ dir: UI_DIR }, "UI build not found; serving the API only (run `pnpm build`, or use the Vite dev server)");
}

// ---- housekeeping ----------------------------------------------------------------------------------------------

const day = 86400;
const housekeeping = setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  store.sessions.purge();
  store.metrics.purge(now - settings().metricsRetentionDays * day);
  store.audit.purge(now - 365 * day);
  store.events.purge(now - settings().eventRetentionDays * day);
  store.maintenance.purgeOld(now - 30 * day);
  store.energy.purge(now - 3 * 365 * day);
  store.speed.purge(now - 2 * 365 * day);
}, 3_600_000);
let energyTimer: NodeJS.Timeout | undefined;

async function shutdown() {
  clearInterval(housekeeping);
  if (energyTimer) clearInterval(energyTimer);
  scheduler.stop();
  metrics.flush();
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

try {
  await app.listen({ port: PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error({ err, port: PORT }, "could not listen");
  if (quarantineConfig()) app.log.error("The saved server settings were set aside; restarting with defaults.");
  process.exit(1);
}
if (restoredFrom) app.log.info({ previousData: restoredFrom }, "restored from backup; previous data kept");
if (tls) {
  const redirectPort = serverConfig.httpRedirectPort;
  if (redirectPort) startHttpRedirect(redirectPort, PORT, app.log);
  app.log.info({ port: PORT, selfSigned: tls.generated }, "serving HTTPS");
}

// Fold the stored power readings into 30-minute slots now (this also backfills history), then keep doing it.
rollupEnergy(store, 0);
energyTimer = setInterval(() => {
  rollupEnergy(store, Math.floor(Date.now() / 1000) - 6 * 3600);
  evaluateBudget();
}, 10 * 60_000);
setTimeout(evaluateBudget, 90_000);
scheduler.start();

await Promise.allSettled(
  store.instances.list().map((row) =>
    registry.start(row.moduleId, row.instanceId, row.config, { intervalMs: row.pollIntervalMs, enabled: row.enabled, position: row.position }).catch((err) => {
      app.log.error({ err, instance: row.instanceId }, "failed to restore instance");
    }),
  ),
);
