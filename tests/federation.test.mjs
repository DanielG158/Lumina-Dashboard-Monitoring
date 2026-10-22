// Two real Lumina servers: "office" (has a fake UPS on battery, public viewing off) and "home" (watches the office through an access token).
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const until = async (fn, ms = 40000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(400); } return false; };

const nis = net.createServer((s) => s.on("data", () => {
  for (const l of ["MODEL    : Fake UPS\n", "UPSNAME  : office-ups\n", "STATUS   : ONLINE ONBATT\n", "LOADPCT  : 020.0 Percent\n", "BCHARGE  : 71.0 Percent\n", "TIMELEFT : 30.0 Minutes\n", "NOMPOWER : 700 Watts\n"]) {
    const b = Buffer.from(l); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); s.write(Buffer.concat([h, b]));
  }
  s.end(Buffer.alloc(2));
}));
await new Promise((r) => nis.listen(0, "127.0.0.1", r));

function start(port) {
  const dir = mkdtempSync(join(tmpdir(), "lumina-fed-"));
  const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: String(port), LUMINA_DB: join(dir, "t.db"), LUMINA_UI_DIR: join(dir, "none"), LOG_LEVEL: "error" }, stdio: ["ignore", "ignore", "inherit"] });
  const base = `http://127.0.0.1:${port}`;
  const jar = { cookie: "" };
  const api = async (method, path, { body, headers = {}, j = jar } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(j.cookie ? { cookie: j.cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get("set-cookie");
    if (sc && j) j.cookie = sc.split(";")[0].endsWith("=") ? "" : sc.split(";")[0];
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  };
  return { child, dir, base, api };
}
const office = start(3991), home = start(3992);
for (const s of [office, home]) {
  await until(async () => { try { return (await fetch(`${s.base}/health`)).ok; } catch { return false; } }, 15000);
  const code = readFileSync(join(s.dir, "setup-code"), "utf8").trim();
  await s.api("POST", "/api/auth/setup", { body: { username: "boss", password: "correct horse battery", setupCode: code } });
}
check("both servers are up with an admin", (await office.api("GET", "/api/users")).status === 200 && (await home.api("GET", "/api/users")).status === 200);

await office.api("POST", "/api/instances", { body: { moduleId: "apcupsd", instanceId: "Office-UPS", config: { host: "127.0.0.1", port: nis.address().port }, pollIntervalSec: 2 } });
await office.api("PUT", "/api/settings", { body: { sessionIdleMinutes: 480, alertConfirmPolls: 1, metricsRetentionDays: 14, publicView: false } });
check("the office has public viewing off", (await office.api("GET", "/api/instances", { j: { cookie: "" } })).status === 401);
await until(async () => (await office.api("GET", "/api/alerts")).data.active.some((a) => a.key === "on-battery"));

// home -> office without a token
let r = await home.api("POST", "/api/instances", { body: { moduleId: "lumina", instanceId: "Office", config: { url: office.base, label: "Office" }, pollIntervalSec: 10 } });
check("home adds the office as 'Another Lumina'", r.status === 201, JSON.stringify(r.data));
const homeInst = async () => (await home.api("GET", "/api/instances")).data.find((i) => i.instanceId === "Office");
check("without a token the office refuses and home says so", await until(async () => { const i = await homeInst(); return i.status === "disconnected" && /refused access|token/i.test(i.error ?? ""); }), (await homeInst()).error);

// token handling on the office
r = await office.api("POST", "/api/tokens", { body: { name: "Home Lumina" } });
const token = r.data?.token;
check("admin creates a token that is shown once", r.status === 200 && /^lum_[A-Za-z0-9_-]{30,}$/.test(token ?? ""));
check("the list never contains the token itself", JSON.stringify((await office.api("GET", "/api/tokens")).data).includes(token) === false);
const bearer = { Authorization: `Bearer ${token}` };
const none = { cookie: "" };
check("a token can read instances and alerts", (await office.api("GET", "/api/instances", { headers: bearer, j: none })).status === 200 && (await office.api("GET", "/api/alerts", { headers: bearer, j: none })).status === 200);
check("a token cannot read users, the audit log or tokens", (await Promise.all(["/api/users", "/api/audit", "/api/tokens", "/api/settings"].map((p) => office.api("GET", p, { headers: bearer, j: none })))).every((x) => x.status === 401));
check("a token cannot change anything", (await office.api("POST", "/api/instances", { headers: bearer, j: none, body: { moduleId: "apcupsd", instanceId: "x", config: {} } })).status === 401 && (await office.api("POST", "/api/instances/Office-UPS/refresh", { headers: bearer, j: none })).status === 401);
check("a made-up token is refused", (await office.api("GET", "/api/instances", { headers: { Authorization: "Bearer lum_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, j: none })).status === 401);
check("anonymous visitors still cannot read it", (await office.api("GET", "/api/instances", { j: none })).status === 401);

// home uses the token
await home.api("PUT", "/api/instances/Office", { body: { config: { url: office.base, label: "Office", token } } });
check("with the token home connects and lists the office's devices", await until(async () => { const i = await homeInst(); return i.status === "connected" && i.data?.devices?.some((d) => d.name === "Office-UPS" && /ON BATTERY/.test(d.line)); }), JSON.stringify((await homeInst()).data?.devices));
check("the office's alert appears on home with the office's name", await until(async () => (await home.api("GET", "/api/alerts")).data.active.some((a) => a.instanceId === "Office" && /^Office: UPS is running on battery/.test(a.title) && a.severity === "warning")), JSON.stringify((await home.api("GET", "/api/alerts")).data.active.map((a) => a.title)));
check("the token's last use is recorded", (await office.api("GET", "/api/tokens")).data[0].lastUsed !== null);

// revoke
const id = (await office.api("GET", "/api/tokens")).data[0].id;
check("revoking works", (await office.api("DELETE", `/api/tokens/${id}`)).status === 200);
check("home notices the revoked token (the card goes red)", await until(async () => (await homeInst()).status === "disconnected"));
check("the audit log records token creation and revocation", (await office.api("GET", "/api/audit")).data.some((e) => e.action === "token-created") && (await office.api("GET", "/api/audit")).data.some((e) => e.action === "token-revoked"));

// two servers watching each other must not echo
const { digest } = await import(ROOT + "/packages/modules/lumina-remote/dist/index.js");
const dg = digest([{ instanceId: "A", moduleId: "apcupsd", status: "connected", enabled: true, data: { status: "ONLINE" } }, { instanceId: "Other-Lumina", moduleId: "lumina", status: "connected", enabled: true, data: {} }], { active: [{ instanceId: "Other-Lumina", key: "x", severity: "critical", title: "echo" }, { instanceId: "A", key: "y", severity: "warning", title: "real", suppressed: false }, { instanceId: "A", key: "z", severity: "warning", title: "muted by maintenance", suppressed: true }] });
check("remote Luminas and alerts about them are left out (no echo loops)", dg.devices.length === 1 && dg.alerts.length === 1 && dg.alerts[0].title === "real");

office.child.kill(); home.child.kill(); nis.close();
process.exit(ok ? 0 : 1);
