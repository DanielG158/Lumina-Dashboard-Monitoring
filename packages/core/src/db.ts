import Database from "better-sqlite3";
import { decrypt, encrypt, isEncrypted, loadKey } from "./crypto.js";

export interface InstanceRow {
  instanceId: string;
  moduleId: string;
  config: Record<string, unknown>;
  pollIntervalMs: number | null;
  enabled: boolean;
  position: number;
}

export interface UserRow {
  id: number;
  username: string;
  role: "admin" | "operator" | "viewer";
  passwordHash: string;
  createdAt: number;
  lastLogin: number | null;
}

export interface MaintenanceRow {
  id: number;
  name: string;
  scope: string[];
  startTs: number;
  durationS: number;
  repeat: "none" | "daily" | "weekly";
  enabled: boolean;
  note: string | null;
  createdBy: string | null;
  endedTs: number | null;
  skipUntil: number | null;
}

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
  createdBy: string | null;
}

export interface EventRow {
  id: number;
  ts: number;
  instanceId: string;
  key: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string | null;
  state: "firing" | "resolved";
  resolvedTs: number | null;
  /** false while the alert was raised during a maintenance window and nobody has been told yet */
  notified: boolean;
}

export interface ChannelRow {
  id: number;
  name: string;
  type: string;
  config: Record<string, string>;
  enabled: boolean;
  minSeverity: "info" | "warning" | "critical";
  lastError: string | null;
  lastSentAt: number | null;
}

export type Store = ReturnType<typeof openDb>;

export function openDb(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const key = loadKey(path);
  const seal = (v: unknown) => encrypt(key, JSON.stringify(v));
  const open = <T>(s: string) => JSON.parse(decrypt(key, s)) as T;

  db.exec(`
    CREATE TABLE IF NOT EXISTS module_instances (
      instance_id TEXT PRIMARY KEY,
      module_id   TEXT NOT NULL,
      config      TEXT NOT NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'viewer',
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      last_login    INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip         TEXT,
      user_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     INTEGER NOT NULL,
      user   TEXT,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT,
      ip     TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_ts ON audit_log(ts);
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      instance_id TEXT NOT NULL,
      key         TEXT NOT NULL,
      severity    TEXT NOT NULL,
      title       TEXT NOT NULL,
      detail      TEXT,
      state       TEXT NOT NULL,
      resolved_ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS events_state ON events(state);
    CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
    CREATE TABLE IF NOT EXISTS channels (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      type         TEXT NOT NULL,
      config       TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      min_severity TEXT NOT NULL DEFAULT 'warning',
      last_error   TEXT,
      last_sent_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS metrics (
      instance_id TEXT NOT NULL,
      key         TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      value       REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS metrics_lookup ON metrics(instance_id, key, ts);
    CREATE TABLE IF NOT EXISTS maintenance (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      scope       TEXT NOT NULL,
      start_ts    INTEGER NOT NULL,
      duration_s  INTEGER NOT NULL,
      repeat      TEXT NOT NULL DEFAULT 'none',
      enabled     INTEGER NOT NULL DEFAULT 1,
      note        TEXT,
      created_by  TEXT,
      ended_ts    INTEGER,
      skip_until  INTEGER
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      instance_id  TEXT NOT NULL,
      action_id    TEXT NOT NULL,
      input        TEXT NOT NULL,
      repeat       TEXT NOT NULL DEFAULT 'once',
      at_ts        INTEGER NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      last_run_ts  INTEGER,
      last_status  TEXT,
      last_message TEXT,
      created_by   TEXT
    );
    -- Every internet speed test result (the speed test itself runs in the Network checks module).
    CREATE TABLE IF NOT EXISTS speed_results (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      down_mbps   REAL,
      up_mbps     REAL,
      latency_ms  REAL,
      error       TEXT,
      UNIQUE (instance_id, ts)
    );
    -- Read-only access tokens for other Lumina servers (only a hash is kept).
    CREATE TABLE IF NOT EXISTS api_tokens (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_used  INTEGER,
      created_by TEXT
    );
    -- Average cores in use per guest per 30-minute slot (a row exists only while the guest was running).
    CREATE TABLE IF NOT EXISTS energy_guest_buckets (
      instance_id TEXT NOT NULL,
      vmid        INTEGER NOT NULL,
      ts          INTEGER NOT NULL,
      cores       REAL NOT NULL,
      PRIMARY KEY (instance_id, vmid, ts)
    );
    -- Average power per 30-minute slot, kept long after the minute-by-minute history is purged.
    CREATE TABLE IF NOT EXISTS energy_buckets (
      source_key TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      avg_w      REAL NOT NULL,
      peak_w     REAL NOT NULL,
      min_w      REAL NOT NULL,
      samples    INTEGER NOT NULL,
      PRIMARY KEY (source_key, ts)
    );
  `);

  const eventCols = (db.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name);
  if (!eventCols.includes("notified")) db.exec("ALTER TABLE events ADD COLUMN notified INTEGER NOT NULL DEFAULT 1");

  const cols = (db.prepare("PRAGMA table_info(module_instances)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("poll_interval_ms")) db.exec("ALTER TABLE module_instances ADD COLUMN poll_interval_ms INTEGER");
  if (!cols.includes("enabled")) db.exec("ALTER TABLE module_instances ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
  if (!cols.includes("position")) {
    db.exec("ALTER TABLE module_instances ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE module_instances SET position = rowid");
  }

  // Credentials written by older versions were plaintext JSON; seal them on first start.
  for (const r of db.prepare("SELECT instance_id, config FROM module_instances").all() as { instance_id: string; config: string }[]) {
    if (!isEncrypted(r.config)) {
      db.prepare("UPDATE module_instances SET config = ? WHERE instance_id = ?").run(seal(JSON.parse(r.config)), r.instance_id);
    }
  }

  type RawInstance = { instance_id: string; module_id: string; config: string; poll_interval_ms: number | null; enabled: number; position: number };
  const toInstance = (r: RawInstance): InstanceRow => ({
    instanceId: r.instance_id,
    moduleId: r.module_id,
    config: open(r.config),
    pollIntervalMs: r.poll_interval_ms,
    enabled: r.enabled === 1,
    position: r.position,
  });

  type RawUser = { id: number; username: string; password_hash: string; role: UserRow["role"]; created_at: number; last_login: number | null };
  const toUser = (r: RawUser): UserRow => ({
    id: r.id, username: r.username, role: r.role, passwordHash: r.password_hash, createdAt: r.created_at, lastLogin: r.last_login,
  });

  type RawEvent = { id: number; ts: number; instance_id: string; key: string; severity: EventRow["severity"]; title: string; detail: string | null; state: EventRow["state"]; resolved_ts: number | null; notified: number };
  const toEvent = (r: RawEvent): EventRow => ({
    id: r.id, ts: r.ts, instanceId: r.instance_id, key: r.key, severity: r.severity, title: r.title, detail: r.detail, state: r.state, resolvedTs: r.resolved_ts, notified: r.notified === 1,
  });

  type RawMaint = { id: number; name: string; scope: string; start_ts: number; duration_s: number; repeat: MaintenanceRow["repeat"]; enabled: number; note: string | null; created_by: string | null; ended_ts: number | null; skip_until: number | null };
  const toMaint = (r: RawMaint): MaintenanceRow => ({
    id: r.id, name: r.name, scope: JSON.parse(r.scope), startTs: r.start_ts, durationS: r.duration_s, repeat: r.repeat, enabled: r.enabled === 1,
    note: r.note, createdBy: r.created_by, endedTs: r.ended_ts, skipUntil: r.skip_until,
  });

  type RawSched = { id: number; name: string; instance_id: string; action_id: string; input: string; repeat: ScheduleRow["repeat"]; at_ts: number; enabled: number; last_run_ts: number | null; last_status: string | null; last_message: string | null; created_by: string | null };
  const toSched = (r: RawSched): ScheduleRow => ({
    id: r.id, name: r.name, instanceId: r.instance_id, actionId: r.action_id, input: JSON.parse(r.input), repeat: r.repeat, atTs: r.at_ts,
    enabled: r.enabled === 1, lastRunTs: r.last_run_ts, lastStatus: r.last_status, lastMessage: r.last_message, createdBy: r.created_by,
  });

  type RawChannel = { id: number; name: string; type: string; config: string; enabled: number; min_severity: ChannelRow["minSeverity"]; last_error: string | null; last_sent_at: number | null };
  const toChannel = (r: RawChannel): ChannelRow => ({
    id: r.id, name: r.name, type: r.type, config: open(r.config), enabled: r.enabled === 1, minSeverity: r.min_severity, lastError: r.last_error, lastSentAt: r.last_sent_at,
  });

  const now = () => Math.floor(Date.now() / 1000);

  return {
    backup: (dest: string) => db.backup(dest),
    keyHex: () => key.toString("hex"),

    instances: {
      save(instanceId: string, moduleId: string, config: unknown, opts: { pollIntervalMs?: number | null; enabled?: boolean } = {}) {
        const exists = db.prepare("SELECT 1 FROM module_instances WHERE instance_id = ?").get(instanceId);
        if (exists) {
          db.prepare("UPDATE module_instances SET module_id = ?, config = ? WHERE instance_id = ?").run(moduleId, seal(config), instanceId);
        } else {
          const pos = (db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM module_instances").get() as { p: number }).p;
          db.prepare("INSERT INTO module_instances (instance_id, module_id, config, position) VALUES (?, ?, ?, ?)").run(instanceId, moduleId, seal(config), pos);
        }
        if (opts.pollIntervalMs !== undefined) db.prepare("UPDATE module_instances SET poll_interval_ms = ? WHERE instance_id = ?").run(opts.pollIntervalMs, instanceId);
        if (opts.enabled !== undefined) db.prepare("UPDATE module_instances SET enabled = ? WHERE instance_id = ?").run(opts.enabled ? 1 : 0, instanceId);
      },
      get: (id: string) => {
        const r = db.prepare("SELECT * FROM module_instances WHERE instance_id = ?").get(id) as RawInstance | undefined;
        return r && toInstance(r);
      },
      list: () => (db.prepare("SELECT * FROM module_instances ORDER BY position, instance_id").all() as RawInstance[]).map(toInstance),
      delete: (id: string) => {
        db.prepare("DELETE FROM module_instances WHERE instance_id = ?").run(id);
        db.prepare("DELETE FROM metrics WHERE instance_id = ?").run(id);
      },
      setEnabled: (id: string, enabled: boolean) => db.prepare("UPDATE module_instances SET enabled = ? WHERE instance_id = ?").run(enabled ? 1 : 0, id),
      setOrder: (ids: string[]) => {
        const upd = db.prepare("UPDATE module_instances SET position = ? WHERE instance_id = ?");
        db.transaction(() => ids.forEach((id, i) => upd.run(i + 1, id)))();
      },
    },

    settings: {
      get<T>(k: string, fallback: T): T {
        const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined;
        return r ? (JSON.parse(r.value) as T) : fallback;
      },
      set: (k: string, v: unknown) =>
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, JSON.stringify(v)),
    },

    users: {
      count: () => (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n,
      countAdmins: () => (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n,
      create: (username: string, passwordHash: string, role: UserRow["role"]) =>
        Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").run(username, passwordHash, role).lastInsertRowid),
      byName: (username: string) => {
        const r = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as RawUser | undefined;
        return r && toUser(r);
      },
      byId: (id: number) => {
        const r = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as RawUser | undefined;
        return r && toUser(r);
      },
      list: () => (db.prepare("SELECT * FROM users ORDER BY username").all() as RawUser[]).map(toUser),
      setPassword: (id: number, hash: string) => db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id),
      setRole: (id: number, role: UserRow["role"]) => db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id),
      touchLogin: (id: number) => db.prepare("UPDATE users SET last_login = ? WHERE id = ?").run(now(), id),
      delete: (id: number) => db.prepare("DELETE FROM users WHERE id = ?").run(id),
    },

    speed: {
      add: (r: { instanceId: string; ts: number; down: number | null; up: number | null; latency: number | null; error: string | null }) =>
        db.prepare("INSERT OR IGNORE INTO speed_results (instance_id, ts, down_mbps, up_mbps, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?)").run(r.instanceId, r.ts, r.down, r.up, r.latency, r.error).changes,
      list: (f: { instance?: string; since?: number; limit: number }) => {
        const where: string[] = []; const args: (string | number)[] = [];
        if (f.instance) { where.push("instance_id = ?"); args.push(f.instance); }
        if (f.since) { where.push("ts >= ?"); args.push(f.since); }
        return db.prepare(`SELECT id, instance_id AS instanceId, ts, down_mbps AS downMbps, up_mbps AS upMbps, latency_ms AS latencyMs, error FROM speed_results ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts DESC LIMIT ?`).all(...args, f.limit) as { id: number; instanceId: string; ts: number; downMbps: number | null; upMbps: number | null; latencyMs: number | null; error: string | null }[];
      },
      remove: (instanceId: string) => db.prepare("DELETE FROM speed_results WHERE instance_id = ?").run(instanceId),
      purge: (before: number) => db.prepare("DELETE FROM speed_results WHERE ts < ?").run(before),
    },

    tokens: {
      list: () => db.prepare("SELECT id, name, created_at AS createdAt, last_used AS lastUsed, created_by AS createdBy FROM api_tokens ORDER BY id").all() as { id: number; name: string; createdAt: number; lastUsed: number | null; createdBy: string | null }[],
      create: (name: string, hash: string, by: string | null) => Number(db.prepare("INSERT INTO api_tokens (name, token_hash, created_at, created_by) VALUES (?, ?, ?, ?)").run(name, hash, now(), by).lastInsertRowid),
      find: (hash: string) => db.prepare("SELECT id, name, last_used AS lastUsed FROM api_tokens WHERE token_hash = ?").get(hash) as { id: number; name: string; lastUsed: number | null } | undefined,
      touch: (id: number) => db.prepare("UPDATE api_tokens SET last_used = ? WHERE id = ?").run(now(), id),
      delete: (id: number) => db.prepare("DELETE FROM api_tokens WHERE id = ?").run(id).changes,
    },

    sessions: {
      create: (tokenHash: string, userId: number, expiresAt: number, ip: string | null, ua: string | null) =>
        db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(tokenHash, userId, now(), now(), expiresAt, ip, ua),
      get: (tokenHash: string) =>
        db.prepare(
          `SELECT s.token_hash AS tokenHash, s.created_at AS createdAt, s.last_seen AS lastSeen, s.expires_at AS expiresAt,
                  u.id AS userId, u.username AS username, u.role AS role
             FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
        ).get(tokenHash) as
          | { tokenHash: string; createdAt: number; lastSeen: number; expiresAt: number; userId: number; username: string; role: UserRow["role"] }
          | undefined,
      touch: (tokenHash: string, expiresAt: number) => db.prepare("UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?").run(now(), expiresAt, tokenHash),
      delete: (tokenHash: string) => db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash),
      deleteForUser: (userId: number) => db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId),
      purge: () => db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now()),
    },

    audit: {
      add: (user: string | null, action: string, target: string | null, detail: string | null, ip: string | null) =>
        db.prepare("INSERT INTO audit_log (ts, user, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)").run(now(), user, action, target, detail, ip),
      list: (limit: number, offset = 0) =>
        db.prepare("SELECT id, ts, user, action, target, detail, ip FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset) as {
          id: number; ts: number; user: string | null; action: string; target: string | null; detail: string | null; ip: string | null;
        }[],
      purge: (before: number) => db.prepare("DELETE FROM audit_log WHERE ts < ?").run(before),
    },

    events: {
      insert: (e: { instanceId: string; key: string; severity: string; title: string; detail: string | null; notified?: boolean }) =>
        Number(db.prepare("INSERT INTO events (ts, instance_id, key, severity, title, detail, state, notified) VALUES (?, ?, ?, ?, ?, ?, 'firing', ?)")
          .run(now(), e.instanceId, e.key, e.severity, e.title, e.detail, e.notified === false ? 0 : 1).lastInsertRowid),
      setNotified: (id: number) => db.prepare("UPDATE events SET notified = 1 WHERE id = ?").run(id),
      resolve: (id: number) => db.prepare("UPDATE events SET state = 'resolved', resolved_ts = ? WHERE id = ?").run(now(), id),
      firing: () => (db.prepare("SELECT * FROM events WHERE state = 'firing' ORDER BY ts DESC").all() as RawEvent[]).map(toEvent),
      recent: (limit: number) => (db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as RawEvent[]).map(toEvent),
      purge: (before: number) => db.prepare("DELETE FROM events WHERE state = 'resolved' AND ts < ?").run(before),
      /** History with filters, newest first, in pages (`before` is the id of the last row already shown). */
      search: (f: { limit: number; before?: number; instance?: string; severity?: string; state?: string; q?: string; since?: number }) => {
        const where: string[] = [];
        const args: (string | number)[] = [];
        if (f.instance) { where.push("instance_id = ?"); args.push(f.instance); }
        if (f.severity) { where.push("severity = ?"); args.push(f.severity); }
        if (f.state) { where.push("state = ?"); args.push(f.state); }
        if (f.since) { where.push("ts >= ?"); args.push(f.since); }
        if (f.q) {
          where.push("(title LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\')");
          const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
          args.push(like, like, like);
        }
        const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const total = (db.prepare(`SELECT COUNT(*) AS n FROM events ${clause}`).get(...args) as { n: number }).n;
        const page = db.prepare(`SELECT * FROM events ${clause}${f.before ? `${clause ? " AND" : "WHERE"} id < ?` : ""} ORDER BY id DESC LIMIT ?`).all(...args, ...(f.before ? [f.before] : []), f.limit + 1) as RawEvent[];
        return { events: page.slice(0, f.limit).map(toEvent), hasMore: page.length > f.limit, total };
      },
      instances: () => (db.prepare("SELECT DISTINCT instance_id AS id FROM events ORDER BY instance_id").all() as { id: string }[]).map((r) => r.id),
    },

    channels: {
      list: () => (db.prepare("SELECT * FROM channels ORDER BY id").all() as RawChannel[]).map(toChannel),
      get: (id: number) => {
        const r = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as RawChannel | undefined;
        return r && toChannel(r);
      },
      create: (c: { name: string; type: string; config: unknown; enabled: boolean; minSeverity: string }) =>
        Number(db.prepare("INSERT INTO channels (name, type, config, enabled, min_severity) VALUES (?, ?, ?, ?, ?)")
          .run(c.name, c.type, seal(c.config), c.enabled ? 1 : 0, c.minSeverity).lastInsertRowid),
      update: (id: number, c: { name: string; config: unknown; enabled: boolean; minSeverity: string }) =>
        db.prepare("UPDATE channels SET name = ?, config = ?, enabled = ?, min_severity = ? WHERE id = ?").run(c.name, seal(c.config), c.enabled ? 1 : 0, c.minSeverity, id),
      delete: (id: number) => db.prepare("DELETE FROM channels WHERE id = ?").run(id),
      recordResult: (id: number, error: string | null) =>
        db.prepare("UPDATE channels SET last_error = ?, last_sent_at = ? WHERE id = ?").run(error, now(), id),
    },

    metrics: {
      insertMany: (rows: { instanceId: string; key: string; ts: number; value: number }[]) => {
        const ins = db.prepare("INSERT INTO metrics (instance_id, key, ts, value) VALUES (?, ?, ?, ?)");
        db.transaction(() => rows.forEach((r) => ins.run(r.instanceId, r.key, r.ts, r.value)))();
      },
      keys: (instanceId: string) =>
        (db.prepare("SELECT DISTINCT key FROM metrics WHERE instance_id = ? ORDER BY key").all(instanceId) as { key: string }[]).map((r) => r.key),
      query: (instanceId: string, k: string, since: number, bucketSec: number) =>
        db.prepare(
          `SELECT (CAST(ts AS INTEGER) / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS t, AVG(value) AS v, MIN(value) AS lo, MAX(value) AS hi
             FROM metrics WHERE instance_id = ? AND key = ? AND ts >= ? GROUP BY t ORDER BY t`,
        ).all(bucketSec, bucketSec, instanceId, k, since) as { t: number; v: number; lo: number; hi: number }[],
      aggregate: (instanceId: string, k: string, since: number, bucketSec: number) =>
        db.prepare(
          `SELECT (CAST(ts AS INTEGER) / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS t, AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max, COUNT(*) AS n
             FROM metrics WHERE instance_id = ? AND key = ? AND ts >= ? GROUP BY t ORDER BY t`,
        ).all(bucketSec, bucketSec, instanceId, k, since) as { t: number; avg: number; min: number; max: number; n: number }[],
      instancesWithKeyLike: (pattern: string) => (db.prepare("SELECT DISTINCT instance_id FROM metrics WHERE key LIKE ?").all(pattern) as { instance_id: string }[]).map((r) => r.instance_id),
      instancesWithKey: (k: string) => (db.prepare("SELECT DISTINCT instance_id FROM metrics WHERE key = ?").all(k) as { instance_id: string }[]).map((r) => r.instance_id),
      keysLike: (instanceId: string, pattern: string) =>
        (db.prepare("SELECT DISTINCT key FROM metrics WHERE instance_id = ? AND key LIKE ? ORDER BY key").all(instanceId, pattern) as { key: string }[]).map((r) => r.key),
      purge: (before: number) => db.prepare("DELETE FROM metrics WHERE ts < ?").run(before),
    },

    maintenance: {
      list: () => (db.prepare("SELECT * FROM maintenance ORDER BY start_ts DESC").all() as RawMaint[]).map(toMaint),
      get: (id: number) => {
        const r = db.prepare("SELECT * FROM maintenance WHERE id = ?").get(id) as RawMaint | undefined;
        return r && toMaint(r);
      },
      create: (m: { name: string; scope: string[]; startTs: number; durationS: number; repeat: string; note: string | null; createdBy: string | null }) =>
        Number(db.prepare("INSERT INTO maintenance (name, scope, start_ts, duration_s, repeat, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(m.name, JSON.stringify(m.scope), m.startTs, m.durationS, m.repeat, m.note, m.createdBy).lastInsertRowid),
      update: (id: number, m: { name: string; scope: string[]; startTs: number; durationS: number; repeat: string; note: string | null; enabled: boolean }) =>
        db.prepare("UPDATE maintenance SET name = ?, scope = ?, start_ts = ?, duration_s = ?, repeat = ?, note = ?, enabled = ?, ended_ts = NULL, skip_until = NULL WHERE id = ?")
          .run(m.name, JSON.stringify(m.scope), m.startTs, m.durationS, m.repeat, m.note, m.enabled ? 1 : 0, id),
      end: (id: number, endedTs: number | null, skipUntil: number | null) =>
        db.prepare("UPDATE maintenance SET ended_ts = ?, skip_until = ? WHERE id = ?").run(endedTs, skipUntil, id),
      delete: (id: number) => db.prepare("DELETE FROM maintenance WHERE id = ?").run(id),
      purgeOld: (before: number) => db.prepare("DELETE FROM maintenance WHERE repeat = 'none' AND start_ts + duration_s < ?").run(before),
    },

    schedules: {
      list: () => (db.prepare("SELECT * FROM schedules ORDER BY at_ts").all() as RawSched[]).map(toSched),
      get: (id: number) => {
        const r = db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as RawSched | undefined;
        return r && toSched(r);
      },
      create: (s: { name: string; instanceId: string; actionId: string; input: unknown; repeat: string; atTs: number; createdBy: string | null }) =>
        Number(db.prepare("INSERT INTO schedules (name, instance_id, action_id, input, repeat, at_ts, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(s.name, s.instanceId, s.actionId, JSON.stringify(s.input), s.repeat, s.atTs, s.createdBy).lastInsertRowid),
      update: (id: number, s: { name: string; input: unknown; repeat: string; atTs: number; enabled: boolean }) =>
        db.prepare("UPDATE schedules SET name = ?, input = ?, repeat = ?, at_ts = ?, enabled = ?, last_run_ts = NULL, last_status = NULL, last_message = NULL WHERE id = ?")
          .run(s.name, JSON.stringify(s.input), s.repeat, s.atTs, s.enabled ? 1 : 0, id),
      setEnabled: (id: number, enabled: boolean) => db.prepare("UPDATE schedules SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id),
      recordRun: (id: number, ts: number, status: string, message: string | null) =>
        db.prepare("UPDATE schedules SET last_run_ts = ?, last_status = ?, last_message = ? WHERE id = ?").run(ts, status, message, id),
      delete: (id: number) => db.prepare("DELETE FROM schedules WHERE id = ?").run(id),
    },

    energy: {
      upsert: (rows: { sourceKey: string; ts: number; avg: number; peak: number; min: number; samples: number }[]) => {
        const stmt = db.prepare(
          `INSERT INTO energy_buckets (source_key, ts, avg_w, peak_w, min_w, samples) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_key, ts) DO UPDATE SET avg_w = excluded.avg_w, peak_w = excluded.peak_w, min_w = excluded.min_w, samples = excluded.samples`,
        );
        db.transaction(() => rows.forEach((r) => stmt.run(r.sourceKey, r.ts, r.avg, r.peak, r.min, r.samples)))();
      },
      buckets: (sourceKey: string, from: number, to: number) =>
        db.prepare("SELECT ts, avg_w AS avg, peak_w AS peak, min_w AS min, samples FROM energy_buckets WHERE source_key = ? AND ts >= ? AND ts < ? ORDER BY ts")
          .all(sourceKey, from, to) as { ts: number; avg: number; peak: number; min: number; samples: number }[],
      sources: () => (db.prepare("SELECT source_key, MIN(ts) AS first, MAX(ts) AS last FROM energy_buckets GROUP BY source_key ORDER BY source_key").all() as { source_key: string; first: number; last: number }[]),
      purge: (before: number) => {
        db.prepare("DELETE FROM energy_buckets WHERE ts < ?").run(before);
        db.prepare("DELETE FROM energy_guest_buckets WHERE ts < ?").run(before);
      },
      upsertGuests: (rows: { instanceId: string; vmid: number; ts: number; cores: number }[]) => {
        const stmt = db.prepare("INSERT INTO energy_guest_buckets (instance_id, vmid, ts, cores) VALUES (?, ?, ?, ?) ON CONFLICT(instance_id, vmid, ts) DO UPDATE SET cores = excluded.cores");
        db.transaction(() => rows.forEach((r) => stmt.run(r.instanceId, r.vmid, r.ts, r.cores)))();
      },
      guestBuckets: (from: number, to: number) =>
        db.prepare("SELECT instance_id AS instanceId, vmid, ts, cores FROM energy_guest_buckets WHERE ts >= ? AND ts < ? ORDER BY ts").all(from, to) as { instanceId: string; vmid: number; ts: number; cores: number }[],
    },
  };
}
