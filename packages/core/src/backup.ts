import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { dataDir } from "./config.js";
import type { Store } from "./db.js";

export interface BackupBundle {
  "lumina-backup": 1;
  created: string;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

const kdf = (pass: string, salt: Buffer) =>
  new Promise<Buffer>((res, rej) => scryptCb(pass, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

/** One passphrase-protected file with the database (settings, users, credentials, channels) and the key that unlocks it. */
export async function createBackup(store: Store, passphrase: string, includeHistory: boolean): Promise<BackupBundle> {
  const tmp = join(tmpdir(), `lumina-backup-${randomBytes(6).toString("hex")}.db`);
  try {
    await store.backup(tmp);
    if (!includeHistory) {
      const copy = new Database(tmp);
      copy.exec("DELETE FROM metrics; DELETE FROM sessions; VACUUM;");
      copy.close();
    }
    const plain = JSON.stringify({ db: readFileSync(tmp).toString("base64"), key: store.keyHex() });
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await kdf(passphrase, salt), iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return {
      "lumina-backup": 1,
      created: new Date().toISOString(),
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  } finally {
    rmSync(tmp, { force: true });
  }
}

export async function openBackup(bundle: BackupBundle, passphrase: string): Promise<{ db: Buffer; key: string }> {
  if (bundle?.["lumina-backup"] !== 1) throw Object.assign(new Error("This is not a Lumina backup file"), { statusCode: 400 });
  try {
    const decipher = createDecipheriv("aes-256-gcm", await kdf(passphrase, Buffer.from(bundle.salt, "base64")), Buffer.from(bundle.iv, "base64"));
    decipher.setAuthTag(Buffer.from(bundle.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(bundle.data, "base64")), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plain) as { db: string; key: string };
    return { db: Buffer.from(parsed.db, "base64"), key: parsed.key };
  } catch {
    throw Object.assign(new Error("Wrong passphrase, or the backup file is damaged"), { statusCode: 400 });
  }
}

/** Checks the restored database really is a Lumina one, then stages it for the next start. */
export function stageRestore(db: Buffer, keyHex: string) {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw Object.assign(new Error("Backup contains an invalid key"), { statusCode: 400 });
  const dir = join(dataDir(), "restore");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dbFile = join(dir, "lumina.db");
  writeFileSync(dbFile, db, { mode: 0o600 });
  try {
    const check = new Database(dbFile, { readonly: true });
    const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    check.close();
    if (!["module_instances", "users", "settings"].every((t) => tables.includes(t))) throw new Error("missing tables");
  } catch {
    rmSync(dbFile, { force: true });
    throw Object.assign(new Error("The backup does not contain a valid Lumina database"), { statusCode: 400 });
  }
  writeFileSync(join(dir, "lumina.key"), keyHex.toLowerCase(), { mode: 0o600 });
}
