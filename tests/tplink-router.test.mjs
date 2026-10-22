// The TP-Link Archer router module against a fake router that implements the real login protocol (RSA password, AES + signatures).
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import { startFakeRouter } from "./helpers/tplink-fake.mjs";

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const mod = (await import(ROOT + "/packages/modules/tplink-router/dist/index.js")).default;
const { parseStatus, RouterCipher, rsaEncryptHex } = await import(ROOT + "/packages/modules/tplink-router/dist/index.js");
const { redactState } = await import(ROOT + "/packages/core/dist/redact.js");
const log = { info() {}, warn() {}, error() {} };
const make = (r, extra = {}) => mod.create(mod.configSchema.parse({ url: r.url, password: r.password, ...extra }), { log });

// ---- the building blocks ----
const c = new RouterCipher();
check("the AES layer round-trips and uses 16-character key and iv", c.key.length === 16 && c.iv.length === 16 && c.decrypt(c.encrypt('{"operation": "read"}')) === '{"operation": "read"}');
check("status values are read: percentages, internet, clients", (() => {
  const s = parseStatus({ cpu_usage: 0.25, mem_usage: "0.5", wan_ipv4_ipaddr: "1.2.3.4", wan_ipv4_uptime: "120", access_devices_wired: [{ hostname: "a", ipaddr: "10.0.0.2", macaddr: "aa-bb" }], access_devices_wireless_host: [{}, {}], access_devices_wireless_guest: [{}] });
  return s.cpu === 25 && s.mem === 50 && s.wan.up && s.wan.uptimeS === 120 && s.clients.total === 4 && s.clients.wifi === 2 && s.list[0].mac === "AA:BB";
})());
check("no internet address means the internet is down", parseStatus({ wan_ipv4_ipaddr: "0.0.0.0" }).wan.up === false && parseStatus({}).wan.up === false);

for (const mode of ["aes", "plain"]) {
  const label = mode === "aes" ? "older firmware (AES + signature)" : "newer firmware (RSA only)";
  const r = await startFakeRouter({ mode });
  let inst = await make(r);
  let d = await inst.poll();
  check(`${label}: it signs in and reads the status`, d.cpu === 12 && d.mem === 43 && d.wan.up && d.wan.ip === "203.0.113.9" && d.clients.total === 4 && d.clients.wired === 1 && d.clients.wifi === 2 && d.clients.guest === 1, JSON.stringify({ cpu: d.cpu, clients: d.clients, wan: d.wan }));
  check(`${label}: model and firmware come from the firmware page`, d.model === "Archer AX12" && /^1\.1\.2/.test(d.firmware ?? ""));
  check(`${label}: it signs out again so the admin page is free`, r.state.logouts === 1 && r.state.sessionOpen === false);
  await inst.poll();
  check(`${label}: every reading signs in and out`, r.state.logins === 2 && r.state.logouts === 2);
  check(`${label}: the firmware page is only asked about now and then`, r.state.requests.filter((x) => x.startsWith("admin/firmware")).length === 1);

  // wrong password: one attempt, then it waits
  const bad = await mod.create(mod.configSchema.parse({ url: r.url, password: "nope" }), { log });
  let e = null; try { await bad.poll(); } catch (x) { e = x.message; }
  const attempts = r.state.loginAttempts;
  let e2 = null; try { await bad.poll(); } catch (x) { e2 = x.message; }
  check(`${label}: a wrong password is explained`, /refused the login/.test(e ?? "") && /local password/.test(e ?? ""), e);
  check(`${label}: and is not tried again for a while (so the router can never lock the login)`, r.state.loginAttempts === attempts && e2 === e);

  // someone else is signed in: keep the last reading
  r.state.busy = true;
  d = await inst.poll();
  check(`${label}: when someone else is signed in the last reading is kept and marked busy`, d.busy === true && d.clients.total === 4);
  const fresh = await make(r);
  let e3 = null; try { await fresh.poll(); } catch (x) { e3 = x.message; }
  check(`${label}: with nothing to show yet it says why`, /someone else is signed in/.test(e3 ?? ""), e3);
  r.state.busy = false;

  // alerts and history
  r.state.status = { ...r.state.status, wan_ipv4_ipaddr: "0.0.0.0", cpu_usage: 0.95 };
  d = await (await make(r)).poll();
  const al = inst.alerts(d);
  check(`${label}: no internet address raises a critical alert, a very busy CPU a warning`, al.some((a) => a.key === "internet-down" && a.severity === "critical") && al.some((a) => a.key === "high-cpu"));
  const m = inst.metrics(d);
  check(`${label}: history keeps CPU, memory and client counts`, m.cpu === 95 && m["clients:total"] === 4 && m["wan:up"] === 0, JSON.stringify(m));
  r.close();
}

// ---- not a TP-Link router / not the right address ----
const web = (await import("node:http")).createServer((q, s) => s.end("<html>hello</html>")).listen(0, "127.0.0.1");
await new Promise((x) => web.once("listening", x));
let e = null; try { await (await mod.create(mod.configSchema.parse({ url: `http://127.0.0.1:${web.address().port}`, password: "x" }), { log })).poll(); } catch (x) { e = x.message; }
check("something that is not a TP-Link router is said so", /did not answer like a TP-Link Archer router/.test(e ?? ""), e);
web.close();

// ---- what anonymous viewers see ----
const r2 = await startFakeRouter({ mode: "aes" });
const d2 = await (await make(r2)).poll();
const red = redactState({ instanceId: "R", moduleId: "tplink-router", status: "connected", enabled: true, error: null, data: d2 });
check("anonymous viewers see counts and load but no client names, addresses or MACs", red.data.list.length === 0 && red.data.wan.ip === "" && red.data.lan.ip === "" && red.data.clients.total === 4 && red.data.cpu === 12);
check("the password never appears in the data", !JSON.stringify(d2).includes(r2.password));
r2.close();
process.exit(ok ? 0 : 1);
