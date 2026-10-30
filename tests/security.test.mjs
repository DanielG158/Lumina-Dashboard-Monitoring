import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const req = createRequire(ROOT + "/packages/ui/");
const { io: ioClient } = req("socket.io-client");
const { chromium } = createRequire(ROOT + "/")("playwright-core");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push([name, ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(300); } return false; };

// ---- fake devices ----
const kumaMetrics = `monitor_status{monitor_name="Router",monitor_type="http",monitor_url="http://10.99.99.1/secret-admin",monitor_hostname="null",monitor_port="null"} 1\nmonitor_response_time{monitor_name="Router",monitor_type="http",monitor_url="http://10.99.99.1/secret-admin",monitor_hostname="null",monitor_port="null"} 5\n`;
const dev = http.createServer((q, s) => s.end(kumaMetrics)).listen(0, "127.0.0.1");
await new Promise((r) => dev.on("listening", r));
const deadPort = await new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

// ---- server under test (HTTPS, temp data dir) ----
const dir = mkdtempSync(join(tmpdir(), "lumina-sec-"));
const PORT = 3998;
let logs = "";
const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], {
  env: { ...process.env, PORT: String(PORT), LUMINA_DATA: dir, LUMINA_TLS: "auto", LUMINA_UI_DIR: ROOT + "/packages/ui/dist", LOG_LEVEL: "info" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => (logs += d)); child.stderr.on("data", (d) => (logs += d));
const base = `https://127.0.0.1:${PORT}`;
check("server starts with HTTPS", await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 25000));

const jar = () => ({ cookie: "" });
const api = async (method, path, { j = null, body, raw, headers = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(j?.cookie ? { cookie: j.cookie } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const sc = res.headers.get("set-cookie");
  if (sc && j && sc.startsWith("lumina_session=") && !sc.startsWith("lumina_session=;")) j.cookie = sc.split(";")[0];
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data, headers: res.headers, setCookie: sc };
};
const anon = jar(), admin = jar(), op = jar();

// ===== 1. first-run setup code =====
let r = await api("GET", "/api/auth/status", { j: anon });
check("fresh install requires a setup code", r.data.setupRequired && r.data.setupCodeRequired);
const codeFile = join(dir, "setup-code");
check("setup code file exists and is private (0600)", existsSync(codeFile) && (statSync(codeFile).mode & 0o777) === 0o600);
const code = readFileSync(codeFile, "utf8").trim();
check("setup code is printed in the service log for the installer", logs.includes(code));
r = await api("POST", "/api/auth/setup", { j: anon, body: { username: "boss", password: "correct horse battery" } });
check("takeover attempt with no setup code is refused", r.status === 403);
r = await api("POST", "/api/auth/setup", { j: anon, body: { username: "boss", password: "correct horse battery", setupCode: "AAAA-AAAA" } });
check("takeover attempt with a wrong setup code is refused", r.status === 403);
r = await api("POST", "/api/auth/skip-setup", { j: anon, body: {} });
check("'skip setup' (open access) also needs the setup code", r.status === 403);
r = await api("POST", "/api/auth/restore", { j: anon, body: { bundle: {}, passphrase: "x" } });
check("first-run restore also needs the setup code", r.status === 403);
r = await api("POST", "/api/auth/setup", { j: admin, body: { username: "boss", password: "correct horse battery", setupCode: code.toLowerCase() } });
check("correct setup code (any letter case) creates the admin", r.status === 200 && r.data.role === "admin");
check("session cookie is HttpOnly, SameSite=Lax and Secure over HTTPS", /HttpOnly/.test(r.setCookie) && /SameSite=Lax/.test(r.setCookie) && /Secure/.test(r.setCookie), r.setCookie.replace(/=[0-9a-f]{20,}/, "=…"));
check("setup code is deleted once an account exists", !existsSync(codeFile));
await api("POST", "/api/users", { j: admin, body: { username: "helper", password: "operator pass 123", role: "operator" } });
await api("POST", "/api/auth/login", { j: op, body: { username: "helper", password: "operator pass 123" } });

// ===== 2. permission matrix generated from the real route list =====
const src = ["index.ts", "auth.ts"].map((f) => readFileSync(`${ROOT}/packages/core/src/${f}`, "utf8")).join("\n");
const routes = [...src.matchAll(/app\.(get|post|put|delete)\(\s*"([^"]+)"(?:\s*,\s*\{([^}]*)\})?/g)].map((m) => ({ method: m[1].toUpperCase(), path: m[2], opts: m[3] ?? "" }))
  .filter((x) => x.path.startsWith("/api/"));
const PUBLIC = new Set(["/api/auth/status", "/api/auth/login", "/api/auth/setup", "/api/auth/restore", "/api/auth/skip-setup"]);
const ANON_READ = [/^\/api\/modules$/, /^\/api\/instances$/, /^\/api\/instances\/[^/]+\/metrics$/, /^\/api\/instances\/[^/]+\/metric-keys$/, /^\/api\/alerts$/, /^\/api\/alerts\/history$/, /^\/api\/speedtests$/, /^\/api\/maintenance$/, /^\/api\/energy$/, /^\/api\/forecast$/];
let matrixFail = 0, tested = 0;
for (const rt of routes) {
  if (PUBLIC.has(rt.path) || rt.path === "/api/auth/logout") continue; // logout would end the operator's own session mid-test
  const path = rt.path.replace(/:[A-Za-z]+/g, "x");
  const guard = /admin/.test(rt.opts) ? "admin" : /operator/.test(rt.opts) ? "operator" : "any";
  const anonRead = rt.method === "GET" && ANON_READ.some((re) => re.test(path));
  const body = rt.method === "GET" || rt.method === "DELETE" ? undefined : {};
  const a = await api(rt.method, path, { j: anon, body });
  const o = await api(rt.method, path, { j: op, body });
  tested++;
  const anonOk = anonRead ? a.status !== 401 && a.status !== 403 : a.status === 401;
  const opOk = guard === "admin" ? o.status === 403 : o.status !== 401 && o.status !== 403;
  if (!anonOk || !opOk) { matrixFail++; console.log(`  MISMATCH ${rt.method} ${rt.path} guard=${guard} anon=${a.status} operator=${o.status}`); }
}
check(`permission matrix: ${tested} routes checked as anonymous and operator`, matrixFail === 0 && tested >= 30, `${matrixFail} mismatches`);

// ===== 3. cross-site, content-type, hostile input =====
r = await api("POST", "/api/instances", { j: admin, body: { moduleId: "apcupsd", instanceId: "csrf", config: { host: "127.0.0.1", port: deadPort } }, headers: { origin: "https://evil.example" } });
check("cross-site POST with a valid admin cookie is refused", r.status === 403, `status ${r.status}`);
r = await api("POST", "/api/instances", { j: admin, raw: JSON.stringify({ moduleId: "apcupsd", instanceId: "csrf", config: { host: "127.0.0.1", port: deadPort } }), headers: { "content-type": "text/plain" } });
check("form-style content type (text/plain) is refused", r.status === 415 || r.status === 400, `status ${r.status}`);
r = await api("POST", "/api/instances", { j: admin, raw: '{"moduleId":"apcupsd","instanceId":"pp","config":{"__proto__":{"admin":true},"host":"127.0.0.1"}}', headers: { "content-type": "application/json" } });
check("prototype-pollution payload is rejected", r.status === 400, `status ${r.status}`);
r = await api("POST", "/api/instances", { j: admin, body: { moduleId: "apcupsd", instanceId: "a/b", config: { host: "127.0.0.1" } } });
check("instance names with slashes are rejected", r.status === 400);
r = await api("POST", "/api/auth/login", { j: jar(), body: { username: "' OR 1=1 --", password: "x" } });
check("SQL injection in the login form does not work", r.status === 401);
r = await api("POST", "/api/instances", { j: admin, body: { moduleId: "apcupsd", instanceId: "x'; DROP TABLE users;--", config: { host: "127.0.0.1", port: deadPort } } });
await api("DELETE", `/api/instances/${encodeURIComponent("x'; DROP TABLE users;--")}`, { j: admin });
r = await api("GET", "/api/users", { j: admin });
check("SQL injection through an instance name leaves the database intact", r.status === 200 && r.data.length === 2);
// A server that refuses a huge body may answer 413 or simply cut the connection while the client is still sending; both are a refusal.
r = await api("POST", "/api/instances", { j: admin, raw: "x".repeat(3 * 1024 * 1024), headers: { "content-type": "application/json" } }).catch((e) => ({ status: 0, dropped: String(e?.cause?.code ?? e) }));
check("oversized request body is refused", r.status === 413 || (r.status === 0 && /EPIPE|ECONNRESET|UND_ERR/.test(r.dropped)), `status ${r.status}${r.dropped ? ` (${r.dropped})` : ""}`);
r = await api("POST", "/api/instances", { j: admin, raw: "{not json", headers: { "content-type": "application/json" } });
check("malformed JSON gives a clean 400", r.status === 400 && !/at .*\.js/.test(JSON.stringify(r.data)));
r = await api("GET", "/api/nonexistent", { j: admin });
check("unknown API path gives a clean 404 with no stack trace", r.status === 404 && !/node_modules|\.js:\d+/.test(JSON.stringify(r.data)));

// ===== 4. headers =====
r = await api("GET", "/api/instances", { j: anon });
check("API responses are not cacheable", /no-store/.test(r.headers.get("cache-control") ?? ""));
check("no server / x-powered-by banner", !r.headers.get("server") && !r.headers.get("x-powered-by"));
const csp = r.headers.get("content-security-policy") ?? "";
check("CSP forbids framing and external scripts", /default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && !/script-src[^;]*unsafe/.test(csp));
r = await api("GET", "/health", { j: anon });
check("/health reveals nothing beyond up/uptime", Object.keys(r.data).sort().join() === "ok,uptime");

// ===== 5. redaction for anonymous viewers (HTTP + websocket) =====
await api("POST", "/api/instances", { j: admin, body: { moduleId: "uptime-kuma", instanceId: "Kuma", config: { url: `http://127.0.0.1:${dev.address().port}`, apiKey: "k" }, pollIntervalSec: 5 } });
await api("POST", "/api/instances", { j: admin, body: { moduleId: "apcupsd", instanceId: "DeadUPS", config: { host: "127.0.0.1", port: deadPort }, pollIntervalSec: 2 } });
await until(async () => (await api("GET", "/api/instances", { j: admin })).data.some((i) => i.instanceId === "Kuma" && i.data));
await sleep(2500);
const full = (await api("GET", "/api/instances", { j: admin })).data;
const red = (await api("GET", "/api/instances", { j: anon })).data;
const kumaFull = full.find((i) => i.instanceId === "Kuma"), kumaRed = red.find((i) => i.instanceId === "Kuma");
const deadFull = full.find((i) => i.instanceId === "DeadUPS"), deadRed = red.find((i) => i.instanceId === "DeadUPS");
check("signed-in users see monitor targets", kumaFull.data.monitors[0].target.includes("10.99.99.1"));
check("anonymous viewers do not see internal monitor URLs", kumaRed.data.monitors[0].target === "" && !JSON.stringify(red).includes("10.99.99.1"));
check("signed-in users see the real error text", /ECONNREFUSED/.test(deadFull.error ?? ""));
check("anonymous viewers get no raw error text (internal addresses)", deadRed.error === "unreachable" && !JSON.stringify(red).includes("ECONNREFUSED"));

const wsSnapshot = (headers) => new Promise((resolve) => {
  const s = ioClient(base, { extraHeaders: headers, rejectUnauthorized: false, transports: ["websocket"], reconnection: false });
  const timer = setTimeout(() => { s.close(); resolve(null); }, 6000);
  s.on("snapshot", (d) => { clearTimeout(timer); s.close(); resolve(d); });
  s.on("connect_error", () => { clearTimeout(timer); resolve("refused"); });
});
const wsAnon = await wsSnapshot({});
check("websocket: anonymous snapshot is redacted too", Array.isArray(wsAnon) && !JSON.stringify(wsAnon).includes("10.99.99.1") && !JSON.stringify(wsAnon).includes("ECONNREFUSED"));
const wsAdmin = await wsSnapshot({ cookie: admin.cookie });
check("websocket: signed-in snapshot is complete", Array.isArray(wsAdmin) && JSON.stringify(wsAdmin).includes("10.99.99.1"));
const wsEvil = await wsSnapshot({ origin: "https://evil.example", cookie: admin.cookie });
check("websocket from a foreign origin is refused", wsEvil === "refused" || wsEvil === null);

// ===== 6. XSS: hostile instance name rendered in a real browser =====
const evil = `<img src=x onerror="window.__xss=1"><svg onload=window.__xss2=1>`;
await api("POST", "/api/instances", { j: admin, body: { moduleId: "uptime-kuma", instanceId: evil, config: { url: `http://127.0.0.1:${dev.address().port}`, apiKey: "k" }, pollIntervalSec: 5 } });
await sleep(1500);
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
await ctx.addCookies([{ name: "lumina_session", value: admin.cookie.split("=")[1], url: base }]);
const page = await ctx.newPage();
let dialogs = 0; page.on("dialog", (d) => { dialogs++; d.dismiss(); });
for (const tab of ["overview", "instances", "alerts"]) { await page.goto(`${base}/#/${tab}`, { waitUntil: "networkidle" }); await page.waitForTimeout(1200); }
const xss = await page.evaluate(() => ({ a: window.__xss ?? null, b: window.__xss2 ?? null, injectedImg: !!document.querySelector('img[src="x"]'), shown: document.body.innerText.includes("<img src=x") }));
check("XSS payload in an instance name is shown as text and never executes", !xss.a && !xss.b && !xss.injectedImg && dialogs === 0 && xss.shown, JSON.stringify(xss));
await browser.close();

// ===== 7. files, logs =====
const perms = (f) => (statSync(join(dir, f)).mode & 0o777).toString(8);
check("database, key and config are private (0600) with no systemd help", ["lumina.db", "lumina.key"].every((f) => perms(f) === "600"), `db ${perms("lumina.db")} key ${perms("lumina.key")}`);
check("TLS private key is private (0600)", (statSync(join(dir, "tls", "lumina.key")).mode & 0o777) === 0o600);
const leaked = ["correct horse battery", "operator pass 123", "k\"", admin.cookie.split("=")[1]].filter((s) => s.length > 3 && logs.includes(s));
check("no passwords or session tokens appear in the server log", leaked.length === 0, leaked.join(","));

child.kill("SIGTERM"); await new Promise((r) => child.on("exit", r)); dev.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log("FAILED:", failed.map(([n]) => n).join(" | "));
process.exit(failed.length ? 1 : 0);
