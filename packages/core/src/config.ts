import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ServerConfig {
  port: number;
  tls: "off" | "auto" | "custom";
  httpRedirectPort: number;
  names: string[];
  hsts: boolean;
}

export const DEFAULT_CONFIG: ServerConfig = { port: 3000, tls: "off", httpRedirectPort: 0, names: [], hsts: false };

export const dataDir = () => resolve(process.env.LUMINA_DATA ?? (process.env.LUMINA_DB ? dirname(process.env.LUMINA_DB) : "./data"));
export const dbPath = () => process.env.LUMINA_DB ?? join(dataDir(), "lumina.db");
export const configFile = () => join(dataDir(), "config.json");

export function ensureDataDir() {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
}

/** Fields an environment variable fixes; the UI shows these as read-only. */
export function envOverrides(): (keyof ServerConfig)[] {
  const out: (keyof ServerConfig)[] = [];
  if (process.env.PORT) out.push("port");
  if (process.env.LUMINA_TLS || (process.env.LUMINA_TLS_CERT && process.env.LUMINA_TLS_KEY)) out.push("tls");
  if (process.env.LUMINA_HTTP_REDIRECT_PORT) out.push("httpRedirectPort");
  if (process.env.LUMINA_TLS_NAMES) out.push("names");
  if (process.env.LUMINA_HSTS) out.push("hsts");
  return out;
}

export function readFileConfig(): Partial<ServerConfig> {
  try {
    return JSON.parse(readFileSync(configFile(), "utf8")) as Partial<ServerConfig>;
  } catch {
    return {};
  }
}

export function loadServerConfig(): ServerConfig {
  const file = readFileConfig();
  const cfg: ServerConfig = { ...DEFAULT_CONFIG, ...file };
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.LUMINA_TLS_CERT && process.env.LUMINA_TLS_KEY) cfg.tls = "custom";
  else if (process.env.LUMINA_TLS) cfg.tls = process.env.LUMINA_TLS === "off" ? "off" : process.env.LUMINA_TLS === "custom" ? "custom" : "auto";
  if (process.env.LUMINA_HTTP_REDIRECT_PORT) cfg.httpRedirectPort = Number(process.env.LUMINA_HTTP_REDIRECT_PORT);
  if (process.env.LUMINA_TLS_NAMES) cfg.names = process.env.LUMINA_TLS_NAMES.split(",").map((s) => s.trim()).filter(Boolean);
  if (process.env.LUMINA_HSTS) cfg.hsts = process.env.LUMINA_HSTS === "1";
  return cfg;
}

export function saveFileConfig(cfg: ServerConfig) {
  ensureDataDir();
  const tmp = `${configFile()}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, configFile());
}

/** A config written from the UI that stops the server from starting is set aside so the next start uses defaults. */
export function quarantineConfig(): boolean {
  if (!existsSync(configFile())) return false;
  renameSync(configFile(), `${configFile()}.failed`);
  return true;
}

/** True when something will start Lumina again after it exits. */
export const restartSupported = () => Boolean(process.env.INVOCATION_ID || process.env.LUMINA_RESTART === "1" || process.env.container === "docker");

/**
 * A restore uploaded in the UI is staged in <data>/restore and swapped in here, before the database is opened.
 * The previous database and key are kept under <data>/backups.
 */
export function applyPendingRestore(): string | null {
  const dir = join(dataDir(), "restore");
  const db = join(dir, "lumina.db");
  const key = join(dir, "lumina.key");
  if (!existsSync(db) || !existsSync(key)) return null;
  const archive = join(dataDir(), "backups", `before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  for (const f of ["lumina.db", "lumina.db-wal", "lumina.db-shm", "lumina.key"]) {
    const src = join(dataDir(), f);
    if (existsSync(src)) renameSync(src, join(archive, f));
  }
  renameSync(db, dbPath());
  renameSync(key, join(dirname(dbPath()), "lumina.key"));
  chmodSync(join(dirname(dbPath()), "lumina.key"), 0o600);
  chmodSync(dbPath(), 0o600);
  return archive;
}
