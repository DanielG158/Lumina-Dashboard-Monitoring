#!/usr/bin/env node
// Reset (or create) an account password from the server, e.g. when the only admin is locked out.
//   sudo -u lumina LUMINA_DATA=/var/lib/lumina node /opt/lumina/scripts/reset-password.mjs admin
// Prints a new random password unless you pass one as the second argument.
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const core = join(root, "packages/core");
const require = createRequire(join(core, "package.json"));
const Database = require("better-sqlite3");
const { hashPassword } = await import(join(core, "dist/crypto.js"));
const { dbPath } = await import(join(core, "dist/config.js"));

const [username, given] = process.argv.slice(2);
if (!username) { console.error("Usage: reset-password.mjs <username> [new-password]"); process.exit(2); }
const password = given ?? randomBytes(18).toString("base64").replace(/[/+=]/g, "").slice(0, 18);
if (password.length < 8) { console.error("The password must be at least 8 characters."); process.exit(2); }

const db = new Database(dbPath());
const user = db.prepare("SELECT id, role FROM users WHERE username = ?").get(username);
if (!user) { console.error(`No account named "${username}". Existing: ${db.prepare("SELECT username FROM users").all().map((u) => u.username).join(", ") || "(none)"}`); process.exit(1); }
db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(password), user.id);
db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
console.log(`Password for ${username} (${user.role}) reset; all its sessions were signed out.`);
if (!given) console.log(`New password: ${password}`);
