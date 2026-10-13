import { randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config.js";

const file = () => join(dataDir(), "setup-code");
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * A fresh install has no accounts, so the first visitor could claim the admin account. A one-time code, shown to whoever
 * installed it (installer output / service log / this file), proves they are that person.
 */
export function ensureSetupCode(announce: (code: string) => void) {
  if (existsSync(file())) return;
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const code = `${pick()}-${pick()}`;
  writeFileSync(file(), code, { mode: 0o600 });
  announce(code);
}

export const setupCodeRequired = () => existsSync(file());

export function checkSetupCode(given: unknown): boolean {
  if (!existsSync(file())) return true;
  if (typeof given !== "string") return false;
  const want = Buffer.from(readFileSync(file(), "utf8").trim().toUpperCase());
  const got = Buffer.from(given.trim().toUpperCase());
  return got.length === want.length && timingSafeEqual(got, want);
}

export const clearSetupCode = () => rmSync(file(), { force: true });
