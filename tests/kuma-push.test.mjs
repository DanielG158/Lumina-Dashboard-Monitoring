import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
const { parseKumaMetrics, applyHeartbeats, statusPageSlug } = await import(ROOT + "/packages/modules/uptime-kuma/dist/index.js");
let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };

const metrics = [
  'monitor_status{monitor_name="Disk SMART",monitor_type="push",monitor_url="null",monitor_hostname="null",monitor_port="null"} 1',
  'monitor_response_time{monitor_name="Disk SMART",monitor_type="push",monitor_url="null",monitor_hostname="null",monitor_port="null"} 38',
  'monitor_status{monitor_name="Web",monitor_type="http",monitor_url="https://x.test",monitor_hostname="null",monitor_port="null"} 1',
].join("\n");
const mons = parseKumaMetrics(metrics);
check("push monitor is listed with its type", mons.find((m) => m.name === "Disk SMART")?.type === "push");
check("pushed ping shows as the response value", mons.find((m) => m.name === "Disk SMART")?.responseMs === 38);

const page = { publicGroupList: [{ monitorList: [{ id: 7, name: "Disk SMART" }] }] };
const beats = { heartbeatList: { 7: [{ status: 1, time: "2026-10-13 03:00:00", msg: "old 30C" }, { status: 1, time: "2026-10-13 03:05:00", msg: "sda 38.5 C, sdb 41 C", ping: 38 }] } };
applyHeartbeats(mons, page, beats);
const d = mons.find((m) => m.name === "Disk SMART");
check("latest message is shown", d.message === "sda 38.5 C, sdb 41 C", d.message);
check("first number in the message becomes a chartable value", d.value === 38.5, String(d.value));
check("time of the push is read as UTC", d.lastBeat === Date.UTC(2026, 9, 13, 3, 5, 0), String(d.lastBeat));
check("monitors not on the status page are left alone", mons.find((m) => m.name === "Web").message === null);
check("decimal comma is understood", (() => { const m = parseKumaMetrics(metrics); applyHeartbeats(m, page, { heartbeatList: { 7: [{ time: "2026-10-13 03:00:00", msg: "temp 38,5" }] } }); return m[0].value === 38.5; })());
check("a push with no message gives no value", (() => { const m = parseKumaMetrics(metrics); applyHeartbeats(m, page, { heartbeatList: { 7: [{ time: "2026-10-13 03:00:00", msg: "" }] } }); return m[0].message === null && m[0].value === null; })());
check("status page name accepts a slug or a full link", statusPageSlug("home") === "home" && statusPageSlug("https://kuma.local:3001/status/home?x=1") === "home" && statusPageSlug("/status/home/") === "home");
check("odd status page names are refused", statusPageSlug("a b/../c") === null && statusPageSlug("") === null);

// End to end against a fake Uptime Kuma
const http = await import("node:http");
const srv = http.createServer((req, res) => {
  const body = req.url === "/metrics" ? metrics : req.url === "/api/status-page/home" ? JSON.stringify(page) : req.url === "/api/status-page/heartbeat/home" ? JSON.stringify(beats) : null;
  if (body === null) { res.writeHead(404); res.end("no"); return; }
  res.end(body);
}).listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const url = `http://127.0.0.1:${srv.address().port}`;
const mod = (await import(ROOT + "/packages/modules/uptime-kuma/dist/index.js")).default;
const run = async (statusPage) => { const inst = await mod.create({ url, apiKey: "k", verifyTls: false, statusPage }, { log: console }); return inst.poll(); };
let r = await run("home");
check("poll with a status page returns the message", r.monitors.find((m) => m.name === "Disk SMART").message === "sda 38.5 C, sdb 41 C" && r.statusPage?.ok === true);
{ const inst = await mod.create({ url, apiKey: "k", verifyTls: false, statusPage: "home" }, { log: console }); const m = inst.metrics(await inst.poll());
  check("the value is recorded as a chartable metric", m["push:Disk SMART"] === 38.5, JSON.stringify(m)); }
r = await run("missing");
check("a wrong status page name is reported without breaking the card", r.statusPage?.ok === false && /missing/.test(r.statusPage.error) && r.monitors.length === 2, r.statusPage?.error);
r = await run(undefined);
check("without a status page everything still works", r.statusPage === null && r.monitors.length === 2);
srv.close();
process.exit(ok ? 0 : 1);
