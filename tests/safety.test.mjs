// Protect switch, token expiry and the single "network is down" alert, against a real server.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 40000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(400); } return false; };

// four fake UPSes that can be switched off together, like devices behind a router that restarts
let upsOn = true;
const upsLines = ["MODEL    : Fake UPS\n", "STATUS   : ONLINE\n", "LOADPCT  : 020.0 Percent\n", "BCHARGE  : 100.0 Percent\n", "TIMELEFT : 30.0 Minutes\n", "END APC  : x\n"];
const ups = () => net.createServer((s) => { if (!upsOn) return s.destroy(); s.on("data", () => { for (const l of upsLines) { const b = Buffer.from(l); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); s.write(Buffer.concat([h, b])); } s.end(Buffer.alloc(2)); }); s.on("error", () => {}); });
const fakes = [ups(), ups(), ups(), ups()];
for (const f of fakes) await new Promise((r) => f.listen(0, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "lumina-safe-"));
const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: "3977", LUMINA_DATA: dir, LUMINA_TLS: "off", LOG_LEVEL: "error", LUMINA_STARTUP_GRACE_SECONDS: "0" }, stdio: "ignore" });
const base = "http://127.0.0.1:3977";
const jar = { cookie: "" };
const api = async (method, path, body, headers = {}, useJar = true) => {
  const res = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(useJar && jar.cookie ? { cookie: jar.cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie"); if (useJar && sc && !sc.startsWith("lumina_session=;")) jar.cookie = sc.split(";")[0];
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
};
try {
  await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 20000);
  await api("POST", "/api/auth/setup", { username: "boss", password: "correct horse battery", setupCode: readFileSync(join(dir, "setup-code"), "utf8").trim() });
  await api("PUT", "/api/settings", { sessionIdleMinutes: 480, alertConfirmPolls: 1, metricsRetentionDays: 14, publicView: false });

  // ---- protect ----
  await api("POST", "/api/instances", { moduleId: "ilo4", instanceId: "Prod", config: { host: "http://127.0.0.1:9", username: "u", password: "p" }, pollIntervalSec: 60 });
  let r = await api("POST", "/api/instances/Prod/protected", { on: true });
  check("an admin can protect an instance", r.status === 200 && (await api("GET", "/api/instances")).data.find((i) => i.instanceId === "Prod").protected === true);
  r = await api("POST", "/api/instances/Prod/actions/force-off", {});
  check("a protected server refuses force-off, with a clear reason", r.status === 403 && /protected/.test(r.data?.error ?? ""), `${r.status} ${JSON.stringify(r.data)}`);
  r = await api("POST", "/api/instances/Prod/actions/shutdown", {});
  check("and refuses a graceful shutdown too", r.status === 403);
  const at = Math.floor(Date.now() / 1000) + 2;
  r = await api("POST", "/api/schedules", { name: "night off", instanceId: "Prod", actionId: "shutdown", input: {}, repeat: "once", atTs: at });
  const sid = r.data?.id;
  r = await api("POST", `/api/schedules/${sid}/run-now`, {});
  const sched = async () => (await api("GET", "/api/schedules")).data.find((x) => x.id === sid);
  check("a schedule cannot shut a protected server down either", await until(async () => { const x = await sched(); return x && /protected/.test(JSON.stringify(x)); }, 30000), JSON.stringify(await sched()).slice(0, 220));
  r = await api("PUT", "/api/instances/Prod/name", { name: "Prod-1" });
  check("the protection follows a rename", r.status === 200 && (await api("GET", "/api/instances")).data.find((i) => i.instanceId === "Prod-1")?.protected === true);
  r = await api("POST", "/api/instances/Prod-1/protected", { on: false });
  r = await api("POST", "/api/instances/Prod-1/actions/shutdown", {});
  check("once unprotected the action is allowed again (it now fails only because the fake server is not there)", r.status !== 403, `${r.status}`);
  check("protecting is written to the audit log", (await api("GET", "/api/audit")).data.some((e) => e.action === "instance-protected") && (await api("GET", "/api/audit")).data.some((e) => e.action === "instance-unprotected"));
  await api("DELETE", "/api/instances/Prod-1");

  // ---- token expiry ----
  r = await api("POST", "/api/tokens", { name: "short", days: 30 });
  const tok = r.data.token;
  check("a token gets an expiry date", r.data.expiresAt > Date.now() / 1000 + 29 * 86400 && (await api("GET", "/api/tokens")).data[0].expiresAt === r.data.expiresAt);
  check("it works before it expires", (await api("GET", "/api/instances", null, { Authorization: `Bearer ${tok}` }, false)).status === 200);
  r = await api("POST", "/api/tokens", { name: "forever" });
  check("a token without days never expires", r.data.expiresAt === null);
  const Database = createRequire(ROOT + "/packages/core/")("better-sqlite3");
  const db = new Database(join(dir, "lumina.db"));
  db.prepare("UPDATE api_tokens SET expires_at = ? WHERE name = 'short'").run(Math.floor(Date.now() / 1000) - 10);
  db.close();
  r = await api("GET", "/api/instances", null, { Authorization: `Bearer ${tok}` }, false);
  check("after the date it is refused, and the answer says it expired", r.status === 401 && /expired/.test(r.data?.error ?? ""), `${r.status} ${JSON.stringify(r.data)}`);

  // ---- one alert when most devices go quiet at once ----
  for (const [i, f] of fakes.entries()) await api("POST", "/api/instances", { moduleId: "apcupsd", instanceId: `UPS-${i + 1}`, config: { host: "127.0.0.1", port: f.address().port }, pollIntervalSec: 2 });
  const active = async () => (await api("GET", "/api/alerts")).data.active;
  check("four devices connect and nothing is wrong", await until(async () => (await api("GET", "/api/instances")).data.filter((i) => i.status === "connected").length === 4) && (await active()).length === 0);
  upsOn = false;
  check("when they all stop answering, one alert says the network is the likely cause", await until(async () => (await active()).some((a) => a.instanceId === "Lumina" && a.key === "network-down" && a.severity === "critical"), 60000), JSON.stringify((await active()).map((a) => `${a.instanceId}:${a.key}`)));
  await sleep(8000);
  const un = (await active()).filter((a) => a.key === "unreachable").length;
  check("and not one alert per device (at most the two that failed before it was clear)", un <= 2, `${un} unreachable alerts`);
  upsOn = true;
  check("when they are back, the network alert clears", await until(async () => !(await active()).some((a) => a.key === "network-down"), 60000));
  check("and nothing is left firing", await until(async () => (await active()).length === 0, 30000), JSON.stringify((await active()).map((a) => `${a.instanceId}:${a.key}`)));

  // one device failing on its own is still reported on its own
  fakes[0].close();
  await api("PUT", "/api/instances/UPS-1", { config: { host: "127.0.0.1", port: 1 } });
  check("a single device that fails is still reported by name", await until(async () => (await active()).some((a) => a.instanceId === "UPS-1" && a.key === "unreachable"), 60000) && !(await active()).some((a) => a.key === "network-down"));
} finally { child.kill(); for (const f of fakes) f.close(); }
process.exit(ok ? 0 : 1);
