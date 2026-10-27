// Right after a boot nothing is called unreachable for a while (the network may not be up yet); later it is, and with the grace switched off it is at once.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(500); } return false; };

async function run(port, grace, body) {
  const dir = mkdtempSync(join(tmpdir(), "lumina-grace-"));
  const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: String(port), LUMINA_DATA: dir, LUMINA_TLS: "off", LOG_LEVEL: "error", LUMINA_STARTUP_GRACE_SECONDS: String(grace) }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 20000);
  const jar = { cookie: "" };
  const api = async (method, path, b) => {
    const res = await fetch(base + path, { method, headers: { ...(b ? { "content-type": "application/json" } : {}), ...(jar.cookie ? { cookie: jar.cookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const sc = res.headers.get("set-cookie"); if (sc && !sc.startsWith("lumina_session=;")) jar.cookie = sc.split(";")[0];
    let d = null; try { d = await res.json(); } catch { /* empty */ }
    return { status: res.status, data: d };
  };
  await api("POST", "/api/auth/setup", { username: "boss", password: "correct horse battery", setupCode: readFileSync(join(dir, "setup-code"), "utf8").trim() });
  const r = await api("POST", "/api/instances", { moduleId: "apcupsd", instanceId: "Gone", config: { host: "127.0.0.1", port: 1 }, pollIntervalSec: 5 });
  check(`an instance that cannot connect is added (grace ${grace} s)`, r.status === 201, JSON.stringify(r.data));
  try { await body(api); } finally { child.kill(); }
}
const unreachable = async (api) => ((await api("GET", "/api/alerts")).data?.active ?? []).some((a) => a.key === "unreachable" && a.instanceId === "Gone");
const status = async (api) => (await api("GET", "/api/instances")).data?.find((i) => i.instanceId === "Gone")?.status;

await run(3985, 30, async (api) => {
  const t0 = Date.now();
  check("it shows as disconnected as soon as three polls fail", await until(async () => (await status(api)) === "disconnected", 25000));
  check("but no unreachable alert is raised during the grace period", !(await unreachable(api)) && Date.now() - t0 < 28000, `${Math.round((Date.now() - t0) / 1000)} s in`);
  check("once the grace is over the alert is raised", await until(() => unreachable(api), 40000));
});
await run(3984, 0, async (api) => {
  check("with the grace switched off the alert is raised at once", await until(() => unreachable(api), 30000));
});
process.exit(ok ? 0 : 1);
