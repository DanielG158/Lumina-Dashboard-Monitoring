import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_S = 30;

export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of s.replace(/[\s=-]/g, "").toUpperCase()) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32(randomBytes(20));

/** The 6-digit code for a time step (RFC 6238 over RFC 4226, HMAC-SHA1, as every authenticator app does it). */
export function codeAt(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", fromBase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

export const stepNow = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / STEP_S);

/**
 * The time step a typed code belongs to (this one, or one either side to allow for clock drift), or null.
 * The caller refuses a step that was already used, so a code that was seen once cannot be replayed.
 */
export function matchStep(secret: string, typed: string, nowMs = Date.now()): number | null {
  const t = typed.replace(/\s/g, "");
  if (!/^\d{6}$/.test(t)) return null;
  const now = stepNow(nowMs);
  let hit: number | null = null;
  for (const s of [now - 1, now, now + 1]) {
    const a = Buffer.from(codeAt(secret, s));
    if (timingSafeEqual(a, Buffer.from(t)) && hit === null) hit = s;
  }
  return hit;
}

export const otpauthUri = (secret: string, account: string, issuer: string) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_S}`;

/** "ab12-cd34-ef56": easy to write down, 60 bits */
export const newRecoveryCode = () => {
  const h = randomBytes(6).toString("hex");
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8)}`;
};
export const normalizeRecovery = (s: string) => s.trim().toLowerCase().replace(/[^0-9a-f]/g, "");
