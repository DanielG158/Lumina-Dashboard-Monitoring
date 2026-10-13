import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PREFIX = "enc:v1:";

/** Key comes from LUMINA_SECRET_KEY, otherwise from a 0600 key file stored next to the database. */
export function loadKey(dbPath: string): Buffer {
  const fromEnv = process.env.LUMINA_SECRET_KEY;
  if (fromEnv) return createHash("sha256").update(fromEnv).digest();
  const file = process.env.LUMINA_KEY_FILE ?? join(dirname(resolve(dbPath)), "lumina.key");
  if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
  const key = randomBytes(32);
  writeFileSync(file, key.toString("hex"), { mode: 0o600 });
  return key;
}

export const isEncrypted = (s: string) => s.startsWith(PREFIX);

export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

export function decrypt(key: Buffer, stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(":").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = () => randomBytes(32).toString("hex");

const scrypt = (password: string, salt: Buffer, len: number) =>
  new Promise<Buffer>((res, rej) => scryptCb(password, salt, len, (err, out) => (err ? rej(err) : res(out))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${(await scrypt(password, salt, 64)).toString("hex")}`;
}

const DUMMY_HASH = `scrypt$${"00".repeat(16)}$${"00".repeat(64)}`;

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [scheme, saltHex, hashHex] = (stored ?? DUMMY_HASH).split("$");
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return scheme === "scrypt" && stored !== null && timingSafeEqual(actual, expected);
}
