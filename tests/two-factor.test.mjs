// Optional two-factor sign-in: off by default and never forced; a code works once; recovery codes work once; the admin can reset it.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { codeAt, stepNow, base32, fromBase32, matchStep } = await import(ROOT + "/packages/core/dist/totp.js");

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(300); } return false; };

// RFC 6238 test vector (secret "12345678901234567890", time 59 s -> 94287082, last 6 digits 287082)
check("matches the RFC 6238 test vector", codeAt(base32(Buffer.from("12345678901234567890")), 1) === "287082");
check("base32 round trip", fromBase32(base32(Buffer.from("hello lumina"))).toString() === "hello lumina");
check("a code of another time is refused", matchStep(base32(Buffer.from("12345678901234567890")), "000000", 59_000) === null);

const port = 3976;
const dir = mkdtempSync(join(tmpdir(), "lumina-2fa-"));
const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: String(port), LUMINA_DATA: dir, LUMINA_TLS: "off", LOG_LEVEL: "error", LUMINA_STARTUP_GRACE_SECONDS: "0" }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}`;
await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 20000);

async function call(method, path, body, cookie) {
  const r = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* none */ }
  const set = r.headers.get("set-cookie");
  return { status: r.status, json, cookie: set ? set.split(";")[0] : null };
}
const PW = "correct horse battery";
const setupCode = readFileSync(join(dir, "setup-code"), "utf8").trim();
const first = await call("POST", "/api/auth/setup", { username: "admin", password: PW, setupCode });
const admin = first.cookie;
check("first admin is created without any two-factor", first.status < 300 && admin);
check("nothing is switched on by default", (await call("GET", "/api/auth/2fa", null, admin)).json.enabled === false);
check("a normal sign-in works", (await call("POST", "/api/auth/login", { username: "admin", password: PW })).status === 200);

const wrong = await call("POST", "/api/auth/2fa/setup", { password: "nope nope nope" }, admin);
check("setup needs the password", wrong.status === 400);
const setup = await call("POST", "/api/auth/2fa/setup", { password: PW }, admin);
check("setup hands out a key and an otpauth link", /^[A-Z2-7]{32}$/.test(setup.json.secret) && setup.json.uri.startsWith("otpauth://totp/"));
check("until the first code, sign-in is unchanged", (await call("POST", "/api/auth/login", { username: "admin", password: PW })).status === 200);
check("a wrong first code does not turn it on", (await call("POST", "/api/auth/2fa/enable", { code: "000000" }, admin)).status === 400);

const secret = setup.json.secret;
const step = stepNow();
const enable = await call("POST", "/api/auth/2fa/enable", { code: codeAt(secret, step - 1) }, admin);
check("the first right code turns it on and shows 10 recovery codes", enable.status === 200 && enable.json.recoveryCodes.length === 10, JSON.stringify(enable.json).slice(0, 80));
const recovery = enable.json.recoveryCodes;

const noCode = await call("POST", "/api/auth/login", { username: "admin", password: PW });
check("a right password alone gets no session", noCode.status === 401 && noCode.json.needsCode === true && !noCode.cookie);
const badCode = await call("POST", "/api/auth/login", { username: "admin", password: PW, code: "123456" });
check("a wrong code gets no session", badCode.status === 401 && !badCode.cookie);
const badPw = await call("POST", "/api/auth/login", { username: "admin", password: "wrong wrong wrong", code: codeAt(secret, step) });
check("a right code with a wrong password gets nothing", badPw.status === 401 && !badPw.cookie && !badPw.json.needsCode);

const good = await call("POST", "/api/auth/login", { username: "admin", password: PW, code: codeAt(secret, step) });
check("password and code sign in", good.status === 200 && good.cookie);
const replay = await call("POST", "/api/auth/login", { username: "admin", password: PW, code: codeAt(secret, step) });
check("the same code cannot be used twice", replay.status === 401 && !replay.cookie);
const older = await call("POST", "/api/auth/login", { username: "admin", password: PW, code: codeAt(secret, step - 1) });
check("an older code than the last used one is refused", older.status === 401);
const next = await call("POST", "/api/auth/login", { username: "admin", password: PW, code: codeAt(secret, step + 1) });
check("the next code works", next.status === 200);

const rc = await call("POST", "/api/auth/login", { username: "admin", password: PW, code: recovery[0].toUpperCase() });
check("a recovery code signs in", rc.status === 200 && rc.cookie);
const rc2 = await call("POST", "/api/auth/login", { username: "admin", password: PW, code: recovery[0] });
check("and works only once", rc2.status === 401);
check("the count goes down", (await call("GET", "/api/auth/2fa", null, admin)).json.recoveryLeft === 9);

// another account is not affected, and the admin can reset one
const add = await call("POST", "/api/users", { username: "helper", password: PW, role: "operator" }, admin);
check("another user is created", add.status === 201);
check("that user signs in with the password only", (await call("POST", "/api/auth/login", { username: "helper", password: PW })).status === 200);
const users = await call("GET", "/api/users", null, admin);
check("the user list shows who uses two-step", users.json.find((u) => u.username === "admin").twoFactor === true && users.json.find((u) => u.username === "helper").twoFactor === false);

const adminId = users.json.find((u) => u.username === "admin").id;
const dis = await call("POST", "/api/auth/2fa/disable", { password: PW, code: "000000" }, admin);
check("turning it off needs a real code", dis.status === 400);
const reset = await call("PUT", `/api/users/${adminId}`, { resetTwoFactor: true }, admin);
check("an admin can reset it (for a lost phone)", reset.status === 200);
check("then the password alone works again", (await call("POST", "/api/auth/login", { username: "admin", password: PW })).status === 200);
const relog = await call("POST", "/api/auth/login", { username: "admin", password: PW });
const again = await call("POST", "/api/auth/2fa/setup", { password: PW }, relog.cookie);
const en2 = await call("POST", "/api/auth/2fa/enable", { code: codeAt(again.json.secret, stepNow()) }, relog.cookie);
check("it can be set up again", en2.status === 200);
const off = await call("POST", "/api/auth/2fa/disable", { password: PW, code: en2.json.recoveryCodes[0] }, relog.cookie);
check("and turned off with a recovery code", off.status === 200 && (await call("GET", "/api/auth/2fa", null, relog.cookie)).json.enabled === false);

// someone signed in who keeps guessing on the account pages is stopped after 5 wrong tries
let last = 0;
for (let i = 0; i < 5; i++) last = (await call("POST", "/api/auth/2fa/setup", { password: "wrong wrong wrong" }, relog.cookie)).status;
check("five wrong passwords on the two-factor page", last === 400);
const blocked = await call("POST", "/api/auth/2fa/setup", { password: PW }, relog.cookie);
check("then even the right password is refused for a while", blocked.status === 429, String(blocked.status));
const changeBlocked = await call("POST", "/api/auth/password", { current: PW, next: "another long password" }, relog.cookie);
check("and the password change is held too", changeBlocked.status === 429, String(changeBlocked.status));
check("signing in is not affected", (await call("POST", "/api/auth/login", { username: "admin", password: PW })).status === 200);

child.kill();
process.exit(ok ? 0 : 1);
