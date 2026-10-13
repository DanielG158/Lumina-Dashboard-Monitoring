import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(ROOT + "/packages/core/");
const Database = require("better-sqlite3");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(300); } return false; };

// ---- fake UPS (apcupsd NIS) whose status can be flipped ----
let upsStatus = "ONLINE";
const upsLines = () => [`MODEL    : Fake UPS\n`, `UPSNAME  : fake\n`, `STATUS   : ${upsStatus}\n`, `LOADPCT  : 020.0 Percent\n`, `BCHARGE  : ${upsStatus === "ONLINE" ? 100 : 71}.0 Percent\n`, `TIMELEFT : 30.0 Minutes\n`, `NOMPOWER : 700 Watts\n`];
const makeNis = () => net.createServer((s) => s.on("data", () => {
  for (const l of upsLines()) { const b = Buffer.from(l); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); s.write(Buffer.concat([h, b])); }
  s.end(Buffer.alloc(2));
}));
let nis = makeNis();
await new Promise((r) => nis.listen(0, "127.0.0.1", r));
const nisPort = nis.address().port;

// ---- fake webhook receiver ----
const hooks = [];
const hook = http.createServer((q, s) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => { hooks.push({ auth: q.headers.authorization, body: JSON.parse(b) }); s.end("ok"); }); });
await new Promise((r) => hook.listen(0, "127.0.0.1", r));
const hookUrl = `http://127.0.0.1:${hook.address().port}/`;

// ---- Lumina under test ----
const dir = mkdtempSync(join(tmpdir(), "lumina-e2e-"));
const PORT = 3999;
const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], {
  env: { ...process.env, PORT: String(PORT), LUMINA_DB: join(dir, "t.db"), LUMINA_UI_DIR: join(dir, "none"), LOG_LEVEL: "warn" }, stdio: ["ignore", "inherit", "inherit"],
});
const base = `http://127.0.0.1:${PORT}`;
const ready = await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 15000);
check("server starts", ready);

const setupCode = readFileSync(join(dir, "setup-code"), "utf8").trim();
const jar = () => ({ cookie: "" });
const api = async (method, path, { j = null, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(j?.cookie ? { cookie: j.cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie");
  if (sc && j) j.cookie = sc.split(";")[0].endsWith("=") ? "" : sc.split(";")[0];
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data, headers: res.headers };
};
const anon = jar(), admin = jar(), op = jar();

// 1. first run + anonymous viewing
let r = await api("GET", "/api/auth/status", { j: anon });
check("fresh install asks for first-run setup", r.data.setupRequired === true && r.data.publicView === true);
r = await api("GET", "/api/instances", { j: anon });
check("anonymous can view instances without logging in", r.status === 200 && Array.isArray(r.data));
r = await api("POST", "/api/instances", { j: anon, body: { moduleId: "apcupsd", instanceId: "x", config: {} } });
check("anonymous cannot add instances", r.status === 401, `status ${r.status}`);
r = await api("GET", "/api/audit", { j: anon });
check("anonymous cannot read the audit log", r.status === 401);
r = await api("GET", "/api/users", { j: anon });
check("anonymous cannot list users", r.status === 401);

// 2. setup + roles
r = await api("POST", "/api/auth/setup", { j: admin, body: { username: "boss", password: "short", setupCode } });
check("weak password is rejected", r.status === 400, r.data?.error);
r = await api("POST", "/api/auth/setup", { j: admin, body: { username: "boss", password: "correct horse battery", setupCode } });
check("first admin is created and signed in", r.status === 200 && r.data.role === "admin" && admin.cookie.startsWith("lumina_session="));
r = await api("POST", "/api/auth/setup", { j: anon, body: { username: "evil", password: "another long password" } });
check("setup cannot be repeated", r.status === 409);
r = await api("POST", "/api/users", { j: admin, body: { username: "helper", password: "operator pass 123", role: "operator" } });
check("admin creates an operator", r.status === 201);
r = await api("POST", "/api/users", { j: admin, body: { username: "viewer1", password: "viewer pass 12345", role: "viewer" } });
check("'viewer' is not an account role", r.status === 400);
r = await api("POST", "/api/auth/login", { j: op, body: { username: "helper", password: "operator pass 123" } });
check("operator can sign in", r.status === 200 && r.data.role === "operator");

// 3. add a fake UPS as admin
r = await api("POST", "/api/instances", { j: op, body: { moduleId: "apcupsd", instanceId: "UPS", config: { host: "127.0.0.1", port: nisPort } } });
check("operator cannot add instances", r.status === 403, `status ${r.status}`);
r = await api("POST", "/api/instances", { j: admin, body: { moduleId: "apcupsd", instanceId: "UPS", config: { host: "127.0.0.1", port: nisPort }, pollIntervalSec: 1 } });
check("admin adds an instance", r.status === 201, JSON.stringify(r.data));
r = await api("POST", "/api/instances", { j: admin, body: { moduleId: "apcupsd", instanceId: "UPS", config: { host: "127.0.0.1", port: nisPort } } });
check("duplicate instance name is refused", r.status === 409);
r = await api("GET", "/api/instances", { j: anon });
const inst = r.data.find((i) => i.instanceId === "UPS");
check("anonymous sees live data", inst?.status === "connected" && inst.data?.model === "Fake UPS");
check("poll interval below the module minimum is clamped", inst?.intervalMs === 2000 && inst.customInterval === true, `${inst?.intervalMs}ms`);

// 4. permissions on instance operations
r = await api("POST", "/api/instances/UPS/refresh", { j: anon });
check("anonymous cannot refresh", r.status === 401);
r = await api("POST", "/api/instances/UPS/refresh", { j: op });
check("operator can refresh", r.status === 200);
r = await api("PUT", "/api/instances/UPS", { j: op, body: { config: { host: "127.0.0.1", port: nisPort } } });
check("operator cannot edit instances", r.status === 403);
r = await api("DELETE", "/api/instances/UPS", { j: op });
check("operator cannot remove instances", r.status === 403);
r = await api("GET", "/api/instances/UPS/config", { j: admin });
check("config endpoint hides secrets and shows interval", r.status === 200 && r.data.pollIntervalSec === 2 && !("apiKey" in r.data.config), JSON.stringify(r.data));

// 5. notification channel
r = await api("POST", "/api/channels", { j: op, body: { name: "n", type: "webhook", config: { url: hookUrl } } });
check("operator cannot manage channels", r.status === 403);
r = await api("POST", "/api/channels", { j: admin, body: { name: "Test hook", type: "webhook", config: { url: hookUrl, secret: "Bearer s3cret" }, minSeverity: "warning" } });
check("admin adds a channel", r.status === 201);
const chId = r.data.id;
r = await api("POST", `/api/channels/${chId}/test`, { j: admin });
check("channel test succeeds and arrives", r.data?.ok === true && hooks.length === 1 && hooks[0].auth === "Bearer s3cret", JSON.stringify(r.data));
r = await api("GET", "/api/channels", { j: admin });
check("channel secrets are not returned", !JSON.stringify(r.data).includes("s3cret") && !JSON.stringify(r.data).includes(hookUrl) && r.data[0].secretsSet.includes("url"));
hooks.length = 0;

// 6. alert fires, then resolves
upsStatus = "ONBATT";
check("'on battery' alert fires", await until(async () => (await api("GET", "/api/alerts", { j: anon })).data.active.some((a) => a.key === "on-battery")), "within debounce window");
check("notification sent for new alert", await until(async () => hooks.some((h) => h.body.state === "firing" && /battery/i.test(h.body.title))), JSON.stringify(hooks.at(-1)?.body.title));
r = await api("GET", "/api/alerts", { j: anon });
check("anonymous can read active alerts", r.status === 200 && r.data.active[0].severity === "warning");
upsStatus = "ONLINE";
check("alert resolves when UPS is back", await until(async () => !(await api("GET", "/api/alerts", { j: anon })).data.active.some((a) => a.key === "on-battery")));
check("resolved notification sent", await until(async () => hooks.some((h) => h.body.state === "resolved")));

// 7. unreachable
nis.close(); nis.unrefAll?.();
check("'unreachable' alert fires when the device dies", await until(async () => (await api("GET", "/api/alerts", { j: anon })).data.active.some((a) => a.key === "unreachable"), 30000));
r = await api("GET", "/api/instances", { j: admin });
check("instance shows disconnected with the real error (admins only: anonymous viewers get 'unreachable')", r.data[0].status === "disconnected" && /ECONNREFUSED/.test(r.data[0].error ?? ""), r.data[0].error);
nis = makeNis();
await new Promise((res) => nis.listen(nisPort, "127.0.0.1", res));
check("unreachable resolves when the device returns", await until(async () => !(await api("GET", "/api/alerts", { j: anon })).data.active.some((a) => a.key === "unreachable"), 30000));

// 8. mute (operator) and enable/disable (admin)
upsStatus = "ONBATT";
await until(async () => (await api("GET", "/api/alerts", { j: anon })).data.active.some((a) => a.key === "on-battery"));
r = await api("POST", "/api/alerts/mute", { j: anon, body: { key: "on-battery" } });
check("anonymous cannot mute", r.status === 401);
r = await api("POST", "/api/alerts/mute", { j: op, body: { key: "on-battery" } });
check("operator can mute an alert", r.status === 200 && !(await api("GET", "/api/alerts", { j: anon })).data.active.some((a) => a.key === "on-battery"));
await api("DELETE", "/api/alerts/mute?key=on-battery", { j: op });
r = await api("POST", "/api/instances/UPS/enabled", { j: admin, body: { enabled: false } });
r = await api("GET", "/api/instances", { j: anon });
check("disabling an instance stops polling and clears its alerts", r.data[0].status === "disabled" && r.data[0].data === null && (await api("GET", "/api/alerts", { j: anon })).data.active.length === 0);
await api("POST", "/api/instances/UPS/enabled", { j: admin, body: { enabled: true } });
upsStatus = "ONLINE";

// 9. metrics endpoint
r = await api("GET", "/api/instances/UPS/metrics?range=1h&keys=load,battery", { j: anon });
check("metrics endpoint answers for anonymous viewers", r.status === 200 && "load" in r.data.series);
r = await api("GET", "/api/instances/UPS/metrics?range=bogus", { j: anon });
check("bad metrics range is rejected", r.status === 400);

// 10. login protection
const bad = jar();
let last;
for (let i = 0; i < 6; i++) last = await api("POST", "/api/auth/login", { j: bad, body: { username: "helper", password: "wrong" + i } });
check("repeated bad logins get locked out", last.status === 429, last.data?.error);
r = await api("POST", "/api/auth/login", { j: bad, body: { username: "helper", password: "operator pass 123" } });
check("lockout applies even to the right password", r.status === 429);

// 11. public view switch
r = await api("PUT", "/api/settings", { j: admin, body: { sessionIdleMinutes: 480, alertConfirmPolls: 2, metricsRetentionDays: 14, publicView: false } });
r = await api("GET", "/api/instances", { j: anon });
check("with public viewing off, anonymous gets 401", r.status === 401);
r = await api("GET", "/api/instances", { j: op });
check("signed-in users still see data", r.status === 200);
await api("PUT", "/api/settings", { j: admin, body: { sessionIdleMinutes: 480, alertConfirmPolls: 2, metricsRetentionDays: 14, publicView: true } });

// 12. logout
r = await api("POST", "/api/auth/logout", { j: op });
r = await api("POST", "/api/instances/UPS/refresh", { j: { cookie: "lumina_session=garbage" } });
check("bogus session cookie is rejected", r.status === 401);

// 13. audit log
r = await api("GET", "/api/audit", { j: admin });
const actions = new Set(r.data.map((e) => e.action));
check("audit log recorded logins, failures and admin actions", ["setup", "login", "login-failed", "login-blocked", "instance-added", "alert-muted", "instance-disabled", "channel-added"].every((a) => actions.has(a)), [...actions].join(","));
check("audit log is not readable by operators", (await api("GET", "/api/audit", { j: { cookie: "" } })).status === 401);

// 14. shutdown flush + at-rest encryption
child.kill("SIGTERM");
await new Promise((res) => child.on("exit", res));
const db = new Database(join(dir, "t.db"), { readonly: true });
const cfg = db.prepare("select config from module_instances").get().config;
check("instance credentials are encrypted at rest", cfg.startsWith("enc:v1:") && !cfg.includes("127.0.0.1"));
const chCfg = db.prepare("select config from channels").get().config;
check("channel secrets are encrypted at rest", chCfg.startsWith("enc:v1:") && !chCfg.includes("s3cret"));
const pw = db.prepare("select password_hash from users where username='boss'").get().password_hash;
check("passwords are stored as scrypt hashes", pw.startsWith("scrypt$") && !pw.includes("correct"));
check("encryption key file has owner-only permissions", (statSync(join(dir, "lumina.key")).mode & 0o777) === 0o600);
const rows = db.prepare("select count(*) n from metrics where instance_id='UPS'").get().n;
check("metrics were flushed to disk on shutdown", rows > 0, `${rows} rows`);
const ev = db.prepare("select state, count(*) n from events group by state").all();
console.log("events:", JSON.stringify(ev));

nis.close(); hook.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
