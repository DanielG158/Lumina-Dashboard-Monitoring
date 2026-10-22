// Renaming an instance moves everything that refers to it by name.
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
  for (const l of ["MODEL    : Fake UPS\n", "UPSNAME  : ups\n", "STATUS   : ONLINE ONBATT\n", "LOADPCT  : 020.0 Percent\n", "BCHARGE  : 71.0 Percent\n", "TIMELEFT : 30.0 Minutes\n", "NOMPOWER : 700 Watts\n"]) { const b = Buffer.from(l); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); s.write(Buffer.concat([h, b])); }
  s.end(Buffer.alloc(2));
}));
await new Promise((r) => nis.listen(0, "127.0.0.1", r));

const dir = mkdtempSync(join(tmpdir(), "lumina-rename-"));
const PORT = 3988;
const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: String(PORT), LUMINA_DB: join(dir, "t.db"), LUMINA_UI_DIR: join(dir, "none"), LOG_LEVEL: "error" }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${PORT}`;
await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 15000);
const jar = { cookie: "" };
const api = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(jar.cookie ? { cookie: jar.cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie"); if (sc && !sc.startsWith("lumina_session=;")) jar.cookie = sc.split(";")[0];
  let d = null; try { d = await res.json(); } catch { /* empty */ }
  return { status: res.status, data: d };
};
await api("POST", "/api/auth/setup", { username: "boss", password: "correct horse battery", setupCode: readFileSync(join(dir, "setup-code"), "utf8").trim() });
await api("PUT", "/api/settings", { sessionIdleMinutes: 480, alertConfirmPolls: 1, metricsRetentionDays: 14, publicView: true });
await api("POST", "/api/instances", { moduleId: "apcupsd", instanceId: "UPS", config: { host: "127.0.0.1", port: nis.address().port }, pollIntervalSec: 2 });
await api("POST", "/api/instances", { moduleId: "apcupsd", instanceId: "Other", config: { host: "127.0.0.1", port: nis.address().port }, pollIntervalSec: 2 });
await until(async () => (await api("GET", "/api/alerts")).data.active.some((a) => a.instanceId === "UPS" && a.key === "on-battery"));
await api("POST", "/api/maintenance", { name: "Window", scope: ["UPS"], startTs: Math.floor(Date.now() / 1000) + 3600, durationMinutes: 10, repeat: "none", note: null });
const beforeId = (await api("GET", "/api/alerts")).data.active.find((a) => a.instanceId === "UPS" && a.key === "on-battery").id;
await sleep(65000); // let one minute of history be recorded

let r = await api("PUT", "/api/instances/UPS/name", { name: "Rack UPS" });
check("an admin can rename an instance", r.status === 200 && r.data.name === "Rack UPS", JSON.stringify(r.data));
const list = (await api("GET", "/api/instances")).data;
check("it shows under the new name and the old name is gone", list.some((i) => i.instanceId === "Rack UPS") && !list.some((i) => i.instanceId === "UPS"));
check("it keeps polling under the new name", await until(async () => (await api("GET", "/api/instances")).data.find((i) => i.instanceId === "Rack UPS")?.status === "connected"));
const act = (await api("GET", "/api/alerts")).data.active.filter((a) => a.instanceId === "Rack UPS");
check("its active alert carries on (same alert, not resolved and re-raised)", act.some((a) => a.key === "on-battery" && a.id === beforeId), JSON.stringify(act.map((a) => [a.id, a.key])));
check("the alert history follows the name", (await api("GET", "/api/alerts/history?instance=Rack%20UPS")).data.total >= 1 && (await api("GET", "/api/alerts/history?instance=UPS")).data.total === 0);
const keys = (await api("GET", "/api/instances/Rack%20UPS/metric-keys")).data;
check("its chart history moved with it", Array.isArray(keys) && keys.length > 0 && ((await api("GET", "/api/instances/UPS/metric-keys")).data ?? []).length === 0, JSON.stringify(keys).slice(0, 80));
const mw = (await api("GET", "/api/maintenance")).data;
const win = (mw.windows ?? []).find((w) => w.name === "Window");
check("maintenance windows that named it now name the new one", Boolean(win) && win.scope.includes("Rack UPS") && !win.scope.includes("UPS"), JSON.stringify(mw).slice(0, 300));
check("another instance is untouched", (await api("GET", "/api/instances")).data.some((i) => i.instanceId === "Other" && i.status === "connected"));
check("a name that is taken is refused (any letter case)", (await api("PUT", "/api/instances/Rack%20UPS/name", { name: "other" })).status === 409);
check("an empty or unsafe name is refused", (await api("PUT", "/api/instances/Rack%20UPS/name", { name: "  " })).status === 400 && (await api("PUT", "/api/instances/Rack%20UPS/name", { name: "a/b" })).status === 400);
check("an unknown instance gives 404", (await api("PUT", "/api/instances/Nope/name", { name: "X" })).status === 404);
check("the old name cannot be used any more", (await api("PUT", "/api/instances/UPS/name", { name: "Again" })).status === 404);
check("the change is in the audit log", (await api("GET", "/api/audit")).data.some((e) => e.action === "instance-renamed" && /UPS -> Rack UPS/.test(e.detail ?? "")));
const anon = await fetch(`${base}/api/instances/Rack%20UPS/name`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Hax" }) });
check("anonymous visitors cannot rename", anon.status === 401);
// survives a restart
child.kill();
await sleep(1500);
const child2 = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: String(PORT), LUMINA_DB: join(dir, "t.db"), LUMINA_UI_DIR: join(dir, "none"), LOG_LEVEL: "error" }, stdio: ["ignore", "ignore", "inherit"] });
await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 15000);
const jar2 = { cookie: "" };
check("after a restart the new name is still there", (await (await fetch(`${base}/api/instances`)).json()).some((i) => i.instanceId === "Rack UPS"));
child2.kill();
process.exit(ok ? 0 : 1);
