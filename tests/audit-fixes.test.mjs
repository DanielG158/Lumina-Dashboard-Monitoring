// Fixes from the code audit: no crash on a malformed cookie, anonymous viewers do not see raw errors or serial-number keys,
// mutes apply to one device, and a planned shutdown mutes only that device.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const E = await import(ROOT + "/packages/core/dist/email.js");

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 40000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(400); } return false; };

// ---- reminder time zone (pure) ----
const noonUtc = new Date(Date.UTC(2030, 0, 15, 2, 30)); // 02:30 UTC = 09:30 in Jakarta
check("09:00 in Jakarta is due at 02:30 UTC, and not yet in UTC terms", E.reminderDue(noonUtc, 540, null, "Asia/Jakarta") === true && E.wallClock(noonUtc, "Asia/Jakarta").minutes === 570 && E.wallClock(noonUtc, "UTC").minutes === 150);
check("the day follows the time zone too", E.wallClock(new Date(Date.UTC(2030, 0, 15, 20, 0)), "Asia/Jakarta").day === "2030-01-16");
check("a made-up time zone falls back to the server clock without failing", typeof E.wallClock(noonUtc, "Not/AZone").minutes === "number");

// a fake iLO: Redfish answers, and it accepts a power command
const iloPosts = [];
const ilo = http.createServer((q, s) => {
  let b = ""; q.on("data", (c) => { b += c; });
  q.on("end", () => {
    if (q.method === "POST") { if (/ComputerSystem\.Reset/.test(q.url)) iloPosts.push(q.url); s.end("{}"); return; } // only power commands are counted; the web login is a POST too
    const j = { "/redfish/v1/Systems/1/": { PowerState: "On", Model: "Fake", Status: { Health: "OK" } } }[q.url] ?? { Members: [] };
    s.setHeader("content-type", "application/json"); s.end(JSON.stringify(j));
  });
}).listen(0, "127.0.0.1");
await new Promise((r) => ilo.once("listening", r));
let upsOn = true;
const ups = net.createServer((s) => { if (!upsOn) return s.destroy(); s.on("data", () => { for (const l of ["STATUS   : ONLINE\n", "BCHARGE  : 100.0 Percent\n", "END APC  : x\n"]) { const b = Buffer.from(l); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); s.write(Buffer.concat([h, b])); } s.end(Buffer.alloc(2)); }); s.on("error", () => {}); });
await new Promise((r) => ups.listen(0, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "lumina-audit-"));
const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: "3975", LUMINA_DATA: dir, LUMINA_TLS: "off", LOG_LEVEL: "error", LUMINA_STARTUP_GRACE_SECONDS: "0", LUMINA_TRUST_PROXY: "1" }, stdio: "ignore" });
let died = false; child.on("exit", () => { died = true; });
const base = "http://127.0.0.1:3975";
const jar = { cookie: "" };
const api = async (method, path, body, headers = {}, useJar = true) => {
  const res = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(useJar && jar.cookie ? { cookie: jar.cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie"); if (useJar && sc && !sc.startsWith("lumina_session=;")) jar.cookie = sc.split(";")[0];
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
};
const raw = (path, headers, body) => new Promise((resolve) => {
  const req = http.request({ host: "127.0.0.1", port: 3975, path, method: body ? "POST" : "GET", headers }, (res) => { let t = ""; res.on("data", (c) => { t += c; }); res.on("end", () => resolve({ status: res.statusCode, text: t })); });
  req.on("error", () => resolve({ status: 0, text: "" }));
  if (body) req.write(body);
  req.end();
});
try {
  await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 20000);
  await api("POST", "/api/auth/setup", { username: "boss", password: "correct horse battery", setupCode: readFileSync(join(dir, "setup-code"), "utf8").trim() });
  await api("PUT", "/api/settings", { sessionIdleMinutes: 480, alertConfirmPolls: 1, metricsRetentionDays: 14, publicView: true });

  // ---- malformed cookie ----
  const bad = { cookie: "lumina_session=%E0%A4%A" };
  let r = await raw("/api/instances", bad);
  check("a malformed cookie on the API is treated as not signed in", r.status === 200, String(r.status));
  r = await raw("/socket.io/?EIO=4&transport=polling", bad);
  const sid = /"sid":"([^"]+)"/.exec(r.text)?.[1];
  await raw(`/socket.io/?EIO=4&transport=polling&sid=${sid}`, { ...bad, "content-type": "text/plain" }, "40");
  await sleep(1200);
  check("and on the live connection it no longer takes the server down", !died && (await fetch(`${base}/health`).then((x) => x.ok, () => false)));

  // ---- reserved names ----
  r = await api("POST", "/api/instances", { moduleId: "apcupsd", instanceId: "This Lumina", config: { host: "127.0.0.1", port: 1 } });
  check("a device cannot take the name Lumina uses for its own alerts", r.status === 400, `${r.status}`);

  // ---- what anonymous viewers see of alerts ----
  await api("POST", "/api/instances", { moduleId: "apcupsd", instanceId: "Gone", config: { host: "127.0.0.1", port: 1 }, pollIntervalSec: 2 });
  const mine = async () => (await api("GET", "/api/alerts")).data.active.find((a) => a.instanceId === "Gone" && a.key === "unreachable");
  check("the admin sees the raw error of an unreachable device", await until(async () => /127\.0\.0\.1|ECONNREFUSED/.test((await mine())?.detail ?? "")), (await mine())?.detail);
  const anon = (await api("GET", "/api/alerts", null, {}, false)).data;
  const theirs = anon.active.find((a) => a.instanceId === "Gone");
  check("an anonymous viewer sees the alert but not the raw error or the mute list", theirs && theirs.detail === null && anon.muted.length === 0 && !JSON.stringify(anon).includes("ECONNREFUSED"), JSON.stringify(theirs));
  const hist = (await api("GET", "/api/alerts/history?q=ECONNREFUSED", null, {}, false)).data;
  check("and cannot find it by searching for the hidden text", hist.events.length === 0 && (await api("GET", "/api/alerts/history?q=ECONNREFUSED")).data.events.length > 0);

  // ---- mutes are per device ----
  await api("POST", "/api/instances", { moduleId: "apcupsd", instanceId: "Gone too", config: { host: "127.0.0.1", port: 1 }, pollIntervalSec: 2 });
  const firing = async (id) => (await api("GET", "/api/alerts")).data.active.some((a) => a.instanceId === id && a.key === "unreachable");
  await until(() => firing("Gone too"));
  await api("POST", "/api/alerts/mute", { key: "unreachable", instanceId: "Gone" });
  check("muting an alert on one device leaves the same alert on another device alone", await until(async () => !(await firing("Gone")), 15000) && (await firing("Gone too")));
  await api("PUT", "/api/instances/Gone/name", { name: "Gone-1" });
  await sleep(5000);
  check("the mute follows a rename", !(await firing("Gone-1")) && (await api("GET", "/api/alerts")).data.muted.some((m) => m === "Gone-1\tunreachable"), JSON.stringify((await api("GET", "/api/alerts")).data.muted));
  await api("DELETE", `/api/alerts/mute?key=unreachable&instanceId=${encodeURIComponent("Gone-1")}`);
  check("unmuting brings it back", await until(() => firing("Gone-1"), 20000));
  await api("DELETE", "/api/instances/Gone-1"); await api("DELETE", `/api/instances/${encodeURIComponent("Gone too")}`);

  // ---- a planned shutdown mutes only that server ----
  await api("POST", "/api/instances", { moduleId: "ilo4", instanceId: "Rack", config: { host: `http://127.0.0.1:${ilo.address().port}`, username: "u", password: "p" }, pollIntervalSec: 15 });
  await api("POST", "/api/instances", { moduleId: "apcupsd", instanceId: "UPS", config: { host: "127.0.0.1", port: ups.address().port }, pollIntervalSec: 2 });
  await until(async () => (await api("GET", "/api/instances")).data.filter((i) => i.status === "connected").length === 2);
  r = await api("POST", "/api/instances/Rack/actions/shutdown", {});
  const maint = (await api("GET", "/api/maintenance")).data.active;
  check("shutting a server down opens a maintenance window for that server only", r.status === 200 && iloPosts.length === 1 && maint.length === 1 && JSON.stringify(maint[0].scope) === '["Rack"]', JSON.stringify(maint.map((m) => m.scope)));
  upsOn = false;
  const upsAlert = async () => (await api("GET", "/api/alerts")).data.active.find((a) => a.instanceId === "UPS" && a.key === "unreachable");
  check("so a real failure on another device is still reported, not silenced", await until(async () => { const a = await upsAlert(); return a && a.suppressed === false; }, 30000), JSON.stringify(await upsAlert()));
  r = await api("POST", "/api/instances/Nope/actions/shutdown", {});
  check("an action on a device that does not exist is a clean 404", r.status === 404, String(r.status));

  // ---- a login lock belongs to the device that guesses, not to the account ----
  const login = (ip, password) => api("POST", "/api/auth/login", { username: "boss", password }, { "x-forwarded-for": ip }, false);
  let last;
  for (let i = 0; i < 6; i++) last = await login("10.9.9.1", "wrong password");
  check("a device that keeps guessing a password is locked out", last.status === 429, String(last.status));
  check("even with the right password, that device stays locked", (await login("10.9.9.1", "correct horse battery")).status === 429);
  check("but the real owner, on another device, can still sign in", (await login("10.9.9.2", "correct horse battery")).status === 200);

  // ---- signing out ends the session ----
  check("signing out ends the session", (await api("POST", "/api/auth/logout", {})).status === 200 && (await api("GET", "/api/users")).status === 401);
} finally { child.kill(); ilo.close(); ups.close(); }
process.exit(ok ? 0 : 1);
