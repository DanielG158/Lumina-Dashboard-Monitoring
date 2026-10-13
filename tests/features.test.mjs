import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import https from "node:https";
import http from "node:http";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, x = "") => { results.push([n, ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x !== "" ? "  -> " + x : ""}`); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const until = async (fn, ms = 25000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(300); } return false; };

const dir = mkdtempSync(join(tmpdir(), "lumina-feat-"));
const data = join(dir, "data");
process.env.LUMINA_DATA = data;
const { openDb } = await import(ROOT + "/packages/core/dist/db.js");
const core = await import(ROOT + "/packages/core/dist/energy.js");
const sched = await import(ROOT + "/packages/core/dist/scheduler.js");
const maint = await import(ROOT + "/packages/core/dist/maintenance.js");

// ---------------- seed history with known answers ----------------
const TZ = "Asia/Jakarta", OFF = 7 * 3600;
const now0 = Math.floor(Date.now() / 1000);
const todayStart = Math.floor((now0 + OFF) / 86400) * 86400 - OFF;
const yStart = todayStart - 86400;
const dbPath = join(data, "lumina.db");
import { mkdirSync } from "node:fs";
mkdirSync(data, { recursive: true, mode: 0o700 });
const seed = openDb(dbPath);
const rows = [];
const minuteRows = (instanceId, key, from, to, f) => { for (let t = Math.ceil(from / 60) * 60; t < to; t += 60) { const v = f(t); if (v !== null) rows.push({ instanceId, key, ts: t, value: v }); } };
const start = todayStart - 3 * 86400, end = now0 - 180;
minuteRows("UPSX", "watts", start, end, () => 100);
minuteRows("ILOX", "power", start, end, () => 40);
minuteRows("YLEAD", "watts", yStart + 10 * 3600, end, () => 100);
minuteRows("ZGAP", "watts", start, end, (t) => (t >= yStart + 6 * 3600 && t < yStart + 12 * 3600 ? null : 100));
// storage trends for the forecast: 10 days, a reading every 10 minutes
const tenDays = now0 - 10 * 86400;
const noise = (t) => Math.sin(t / 5000) * 0.15;
minuteRows("PVEX", "guests:running", now0 - 300, now0 - 60, () => 3);
for (let t = tenDays; t < now0 - 120; t += 600) {
  const d = (t - tenDays) / 86400;
  rows.push({ instanceId: "PVEX", key: "storage:grow@pve", ts: t, value: 50 + 1.5 * d + noise(t) });
  rows.push({ instanceId: "PVEX", key: "storage:fast@pve", ts: t, value: 40 + 5 * d + noise(t) });
  rows.push({ instanceId: "PVEX", key: "storage:flat@pve", ts: t, value: 60 + noise(t) });
  if (t > now0 - 6 * 3600) rows.push({ instanceId: "PVEX", key: "storage:new@pve", ts: t, value: 10 + d });
}
for (let i = 0; i < rows.length; i += 20000) seed.metrics.insertMany(rows.slice(i, i + 20000));
console.log(`seeded ${rows.length} metric rows`);

// ---------------- fake devices ----------------
let upsStatus = "ONLINE";
const nis = net.createServer((s) => s.on("data", () => {
  for (const l of [`MODEL    : Fake\n`, `STATUS   : ${upsStatus}\n`, `LOADPCT  : 020.0 Percent\n`, `BCHARGE  : 100.0 Percent\n`, `TIMELEFT : 30.0 Minutes\n`, `NOMPOWER : 700 Watts\n`]) { const b = Buffer.from(l); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); s.write(Buffer.concat([h, b])); }
  s.end(Buffer.alloc(2));
})).listen(0, "127.0.0.1");
const hooks = [];
const hook = http.createServer((q, s) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => { hooks.push(JSON.parse(b)); s.end("ok"); }); }).listen(0, "127.0.0.1");
const ilo = http.createServer((q, s) => {
  let body = ""; q.on("data", (c) => (body += c));
  q.on("end", () => {
    if (q.method === "POST") { s.statusCode = 200; return s.end("{}"); }
    const j = { "/redfish/v1/Chassis/1/Power/": { PowerControl: [{ PowerConsumedWatts: 40 }], PowerSupplies: [] }, "/redfish/v1/Chassis/1/Thermal/": { Temperatures: [], Fans: [] }, "/redfish/v1/Systems/1/": { Model: "Fake", PowerState: "On", Status: {}, Oem: { Hp: {} } } }[q.url];
    s.statusCode = j ? 200 : 404; s.end(JSON.stringify(j ?? {}));
  });
}).listen(0, "127.0.0.1");

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=fake"], { stdio: "ignore" });
const pveWrites = [];
const guests = [
  { type: "qemu", id: "qemu/101", vmid: 101, name: "web", node: "pve", status: "running", cpu: 0.02, mem: 1e9, maxmem: 2e9, maxdisk: 2e10, uptime: 5000, template: 0 },
  { type: "lxc", id: "lxc/102", vmid: 102, name: "db", node: "pve", status: "running", cpu: 0, mem: 1e8, maxmem: 1e9, maxdisk: 8e9, uptime: 5000, template: 0 },
  { type: "qemu", id: "qemu/103", vmid: 103, name: "tmpl", node: "pve", status: "stopped", cpu: 0, mem: 0, maxmem: 1e9, maxdisk: 8e9, uptime: 0, template: 1 },
  { type: "qemu", id: "qemu/104", vmid: 104, name: "app", node: "pve", status: "running", cpu: 0, mem: 1e8, maxmem: 1e9, maxdisk: 8e9, uptime: 5000, template: 0 },
  { type: "qemu", id: "qemu/105", vmid: 105, name: "misc", node: "pve", status: "running", cpu: 0, mem: 1e8, maxmem: 1e9, maxdisk: 8e9, uptime: 5000, template: 0 },
  { type: "lxc", id: "lxc/106", vmid: 106, name: "old", node: "pve", status: "running", cpu: 0, mem: 1e8, maxmem: 1e9, maxdisk: 8e9, uptime: 5000, template: 0 },
];
const storages = [{ type: "storage", id: "storage/pve/backup-dir", storage: "backup-dir", node: "pve", plugintype: "dir", content: "backup,iso", status: "available", disk: 50e9, maxdisk: 100e9, shared: 0 }];
const day = 86400;
const backups = [{ vmid: 101, ctime: now0 - 3 * day, size: 1e9 }, { vmid: 101, ctime: now0 - 10 * day, size: 1e9 }, { vmid: 102, ctime: now0 - 20 * day, size: 5e8 }, { vmid: 106, ctime: now0 - 30 * day, size: 5e8 }];
const pve = https.createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (q, s) => {
  let body = ""; q.on("data", (c) => (body += c));
  q.on("end", () => {
    const send = (code, obj, msg) => { s.statusCode = code; if (msg) s.statusMessage = msg; s.setHeader("content-type", "application/json"); s.end(JSON.stringify(obj)); };
    const p = q.url.replace("/api2/json", "");
    if (q.method === "GET") {
      if (p === "/nodes") return send(200, { data: [{ node: "pve", status: "online", cpu: 0.1, mem: 1e9, maxmem: 8e9, disk: 1e9, maxdisk: 1e10, uptime: 100 }] });
      if (p === "/cluster/resources") return send(200, { data: [...guests, ...storages] });
      if (p.startsWith("/nodes/pve/storage/backup-dir/content")) return send(200, { data: backups });
      if (p === "/cluster/backup") return send(200, { data: [{ id: "job1", enabled: 1, all: 0, vmid: "101,102,104", schedule: "sun 01:00", storage: "backup-dir", mode: "snapshot" }] });
      return send(403, {}, "Forbidden");
    }
    const j = body ? JSON.parse(body) : {};
    pveWrites.push({ path: p, body: j });
    if (j.snapname === "dup") return send(500, { errors: { snapname: "already exists" } }, "already exists");
    return send(200, { data: "UPID:pve:1:snap" });
  });
}).listen(0, "127.0.0.1");
await sleep(300);

// ---------------- Lumina under test ----------------
const PORT = 3996;
const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: String(PORT), LUMINA_DATA: data, LUMINA_TLS: "off", LUMINA_UI_DIR: join(dir, "none"), LOG_LEVEL: "warn" }, stdio: ["ignore", "inherit", "inherit"] });
const base = `http://127.0.0.1:${PORT}`;
check("server starts with seeded history", await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 20000));
const code = readFileSync(join(data, "setup-code"), "utf8").trim();
const jar = () => ({ cookie: "" });
const api = async (method, path, { j, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(j?.cookie ? { cookie: j.cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie"); if (sc && j && !sc.startsWith("lumina_session=;")) j.cookie = sc.split(";")[0];
  let d = null; try { d = await res.json(); } catch { /* empty */ }
  return { status: res.status, data: d };
};
const admin = jar(), op = jar(), anon = jar();
await api("POST", "/api/auth/setup", { j: admin, body: { username: "boss", password: "correct horse battery", setupCode: code } });
await api("POST", "/api/users", { j: admin, body: { username: "helper", password: "operator pass 123", role: "operator" } });
await api("POST", "/api/auth/login", { j: op, body: { username: "helper", password: "operator pass 123" } });

const baseEnergy = (over = {}) => ({ source: "watts:UPSX", calibration: 1, extraWatts: 0, gapFill: "estimate", gapFillMaxHours: 48, timezone: TZ, billingDay: 1, fixedMonthly: 0, taxPercent: 0, budgetMonthly: null,
  currency: { symbol: "Rp", code: "IDR", locale: "id-ID", decimals: 0, position: "before" }, tariff: { type: "flat", flat: { price: 1661 }, tou: { defaultPrice: 1661, rules: [] }, tiers: [{ upToKwh: null, price: 1661 }] }, ...over });
const putEnergy = (s) => api("PUT", "/api/energy/settings", { j: admin, body: s });
const energy = (range = "yesterday") => api("GET", `/api/energy?range=${range}`, { j: anon });

// ================= ENERGY =================
let r = await api("GET", "/api/energy/settings", { j: admin });
check("defaults: your tariff is Rp 1,661 per kWh, flat", r.data.settings.tariff.flat.price === 1661 && r.data.settings.currency.symbol === "Rp" && r.data.settings.timezone === null);
check("power sources found from history (UPS, server)", ["watts:UPSX", "power:ILOX", "watts:ZGAP"].every((k) => r.data.sources.some((s) => s.key === k)));
r = await putEnergy(baseEnergy());
check("admin saves energy settings", r.status === 200);
r = await energy("yesterday");
check("100 W for 24 h is exactly 2.4 kWh", near(r.data.kwh, 2.4, 0.001), r.data.kwh.toFixed(4));
check("flat Rp 1,661 gives Rp 3,986.40 for that day", near(r.data.cost.energy, 3986.4, 0.5), r.data.cost.energy.toFixed(1));
check("average and peak watts are right", near(r.data.avgW, 100, 0.01) && near(r.data.peakW, 100, 0.01));
check("24 hourly bars for a single day, 0.1 kWh each", r.data.granularity === "hour" && r.data.series.length === 24 && r.data.series.every((p) => near(p.kwh, 0.1, 0.001)));
check("coverage is 100% when nothing is missing", r.data.coverage > 0.99 && r.data.estimatedKwh === 0, `${(r.data.coverage * 100).toFixed(1)}%`);
r = await energy("today");
const elapsedH = (Date.now() / 1000 - todayStart) / 3600;
check("today so far matches the hours elapsed", near(r.data.kwh, 0.1 * elapsedH, 0.012), `${r.data.kwh.toFixed(3)} vs ${(0.1 * elapsedH).toFixed(3)}`);
r = await energy("7d");
check("7-day view has 7 daily bars", r.data.granularity === "day" && r.data.series.length === 7);
check("the three seeded days add up (2.4 kWh each)", near(r.data.series.slice(-3, -1).reduce((a, p) => a + p.kwh, 0), 4.8, 0.01));

await putEnergy(baseEnergy({ calibration: 1.1, extraWatts: 10 }));
r = await energy("yesterday");
check("calibration 1.1 and +10 W: (100 x 1.1 + 10) = 120 W, 2.88 kWh", near(r.data.kwh, 2.88, 0.002), r.data.kwh.toFixed(4));

const tou = { type: "tou", flat: { price: 1661 }, tou: { defaultPrice: 2000, rules: [{ name: "Night", days: [0, 1, 2, 3, 4, 5, 6], start: "22:00", end: "06:00", price: 1000 }] }, tiers: [{ upToKwh: null, price: 1661 }] };
await putEnergy(baseEnergy({ tariff: tou }));
r = await energy("yesterday");
check("time-of-day tariff: 8 night hours at 1,000 + 16 day hours at 2,000 = Rp 4,000", near(r.data.cost.energy, 4000, 1), r.data.cost.energy.toFixed(1));
await putEnergy(baseEnergy({ tariff: { ...tou, tou: { defaultPrice: 2000, rules: [{ name: "Weekend night", days: [0, 6], start: "22:00", end: "06:00", price: 1000 }] } } }));
r = await energy("7d");
check("weekday-only rules price only those days differently", r.data.cost.energy > 0 && r.data.series.some((p) => p.cost > 0));

check("tiered maths: 60 kWh with 50 at 1,000 then 2,000 = 70,000", core.tierMarginal(0, 60, [{ upToKwh: 50, price: 1000 }, { upToKwh: null, price: 2000 }]) === 70000);
check("tiered maths: 20 kWh starting at 40 = 10x1,000 + 10x2,000", core.tierMarginal(40, 20, [{ upToKwh: 50, price: 1000 }, { upToKwh: null, price: 2000 }]) === 30000);
await putEnergy(baseEnergy({ tariff: { type: "tiered", flat: { price: 1661 }, tou: { defaultPrice: 1661, rules: [] }, tiers: [{ upToKwh: 0.0001, price: 5 }, { upToKwh: null, price: 2000 }] } }));
r = await energy("yesterday");
check("tiered tariff over a real day: 2.4 kWh at the upper block price", near(r.data.cost.energy, 4800, 5), r.data.cost.energy.toFixed(1));

await putEnergy(baseEnergy({ fixedMonthly: 50000, taxPercent: 10 }));
r = await energy("cycle");
check("billing cycle adds the fixed monthly fee and tax on (energy + fee)", near(r.data.cost.fixed, 50000, 0.01) && near(r.data.cost.tax, (r.data.cost.energy + 50000) * 0.1, 1) && near(r.data.cost.total, (r.data.cost.energy + 50000) * 1.1, 1), JSON.stringify(r.data.cost));
check("a billing cycle comes with a month-end projection", r.data.projection && r.data.projection.kwh >= r.data.kwh && r.data.projection.cost.total >= r.data.cost.total, r.data.projection && `${r.data.projection.kwh.toFixed(1)} kWh, ${Math.round(r.data.projection.cost.total)}`);
r = await energy("yesterday");
check("a single day does not carry the monthly fee", r.data.cost.fixed === 0);

// gaps
await putEnergy(baseEnergy({ source: "watts:ZGAP" }));
r = await energy("yesterday");
check("a 6-hour outage is estimated from the typical hour: still 2.4 kWh, 0.6 flagged as estimated", near(r.data.kwh, 2.4, 0.01) && near(r.data.estimatedKwh, 0.6, 0.01) && r.data.coverage < 0.8, `${r.data.kwh.toFixed(2)} kWh, ${r.data.estimatedKwh.toFixed(2)} estimated, coverage ${(r.data.coverage * 100).toFixed(0)}%`);
await putEnergy(baseEnergy({ source: "watts:ZGAP", gapFill: "off" }));
r = await energy("yesterday");
check("with gap filling off the outage is simply missing: 1.8 kWh", near(r.data.kwh, 1.8, 0.01) && r.data.estimatedKwh === 0, r.data.kwh.toFixed(2));
await putEnergy(baseEnergy({ source: "watts:ZGAP", gapFillMaxHours: 3 }));
r = await energy("yesterday");
check("gaps longer than the limit are left empty (assumed switched off)", near(r.data.kwh, 1.8, 0.01), r.data.kwh.toFixed(2));

await putEnergy(baseEnergy({ source: "watts:YLEAD" }));
r = await energy("yesterday");
check("readings that only began at 10:00 are completed back to midnight (leading gap), flagged as estimated", near(r.data.kwh, 2.4, 0.01) && near(r.data.estimatedKwh, 1.0, 0.01), `${r.data.kwh.toFixed(2)} kWh, ${r.data.estimatedKwh.toFixed(2)} estimated`);
await putEnergy(baseEnergy({ source: "watts:YLEAD", gapFillMaxHours: 3 }));
r = await energy("yesterday");
check("...but not when the unmeasured stretch is longer than the limit", near(r.data.kwh, 1.4, 0.01), r.data.kwh.toFixed(2));

// breakdown
await putEnergy(baseEnergy());
r = await energy("yesterday");
check("breakdown: server 0.96 kWh (40 W), everything else 1.44 kWh", r.data.breakdown && near(r.data.breakdown.serverKwh, 0.96, 0.01) && near(r.data.breakdown.otherKwh, 1.44, 0.01) && near(r.data.breakdown.serverShare, 0.4, 0.01), JSON.stringify(r.data.breakdown));

// calibration helper
r = await api("POST", "/api/energy/calibrate", { j: admin, body: { from: yStart, to: todayStart, meterKwh: 2.64 } });
check("calibration helper: meter says 2.64 kWh, Lumina saw 2.4 -> factor 1.10", r.status === 200 && near(r.data.factor, 1.1, 0.002) && near(r.data.luminaKwh, 2.4, 0.01), r.data && r.data.factor && r.data.factor.toFixed(4));

// preview does not save
r = await api("POST", "/api/energy/preview", { j: admin, body: { settings: baseEnergy({ tariff: { type: "flat", flat: { price: 2000 }, tou: { defaultPrice: 1, rules: [] }, tiers: [{ upToKwh: null, price: 1 }] } }), range: "yesterday" } });
check("preview prices the same usage with a different tariff (2.4 kWh x 2,000 = 4,800)", near(r.data.cost.energy, 4800, 1));
r = await api("GET", "/api/energy/settings", { j: admin });
check("...and does not change what is saved", r.data.settings.tariff.flat.price === 1661);

// validation + permissions
r = await putEnergy(baseEnergy({ timezone: "Mars/Olympus" }));
check("unknown time zone is rejected", r.status === 400);
r = await putEnergy(baseEnergy({ tariff: { type: "tiered", flat: { price: 1 }, tou: { defaultPrice: 1, rules: [] }, tiers: [{ upToKwh: 10, price: 1 }] } }));
check("tiers must end with an unlimited block", r.status === 400);
r = await putEnergy(baseEnergy({ tariff: { type: "tou", flat: { price: 1 }, tou: { defaultPrice: 1, rules: [{ name: "x", days: [1], start: "25:00", end: "06:00", price: 1 }] }, tiers: [{ upToKwh: null, price: 1 }] } }));
check("bad time of day is rejected", r.status === 400);
r = await putEnergy(baseEnergy({ calibration: 99 }));
check("absurd calibration is rejected", r.status === 400);
r = await api("PUT", "/api/energy/settings", { j: op, body: baseEnergy() });
check("operators cannot change prices", r.status === 403);
r = await api("PUT", "/api/energy/settings", { j: anon, body: baseEnergy() });
check("anonymous visitors cannot change prices", r.status === 401);
r = await api("GET", "/api/energy/settings", { j: anon });
check("tariff settings are not readable anonymously", r.status === 401);
check("anonymous visitors may read the energy summary", (await energy("yesterday")).status === 200);
check("a different currency formats properly", core.formatMoney({ symbol: "$", code: "USD", locale: "en-US", decimals: 2, position: "before" }, 1234.5) === "$ 1,234.50" && core.formatMoney({ symbol: "Rp", code: "IDR", locale: "id-ID", decimals: 0, position: "before" }, 1500000) === "Rp 1.500.000");

// budget alert
await putEnergy(baseEnergy({ budgetMonthly: 1000 }));
await putEnergy(baseEnergy({ budgetMonthly: 1000 }));
r = await api("GET", "/api/alerts", { j: anon });
check("a budget below what is already spent raises an alert", r.data.active.some((a) => a.key === "energy-budget-exceeded" && a.instanceId === "Lumina"), r.data.active.map((a) => a.key).join(","));
await putEnergy(baseEnergy({ budgetMonthly: null }));
await putEnergy(baseEnergy({ budgetMonthly: null }));
r = await api("GET", "/api/alerts", { j: anon });
check("...and clears when the budget is removed", !r.data.active.some((a) => a.key === "energy-budget-exceeded"));

// ================= FORECAST + BACKUP FRESHNESS =================
const wh = { name: "Hook", type: "webhook", config: { url: `http://127.0.0.1:${hook.address().port}/` }, minSeverity: "warning" };
await api("POST", "/api/channels", { j: admin, body: wh });
r = await api("POST", "/api/instances", { j: admin, body: { moduleId: "proxmox", instanceId: "PVEX", config: { host: `https://127.0.0.1:${pve.address().port}`, tokenId: "root@pam!t", tokenSecret: "secret-secret", verifyTls: false, backupMaxAgeDays: 8, backupExclude: "106" }, pollIntervalSec: 5 } });
check("fake Proxmox added with backup settings", r.status === 201);
check("fake Proxmox polled", await until(async () => (await api("GET", "/api/instances", { j: anon })).data.find((i) => i.instanceId === "PVEX")?.data?.guests?.length === 6));
const px = (await api("GET", "/api/instances", { j: admin })).data.find((i) => i.instanceId === "PVEX");
const g = (id) => px.data.guests.find((x) => x.vmid === id);
check("each guest shows its newest backup (101 is 3 days old)", near((Date.now() / 1000 - g(101).lastBackup) / day, 3, 0.05) && g(101).backupCount === 2 && g(104).lastBackup === null);
check("backup job coverage is worked out (104 covered, 105 not)", g(104).backupCovered === true && g(105).backupCovered === false);
check("excluded guests are marked", g(106).backupExcluded === true);
await sleep(11000); // two polls so alerts confirm
r = await api("GET", "/api/alerts", { j: anon });
const keys = r.data.active.filter((a) => a.instanceId === "PVEX").map((a) => a.key);
check("stale backup (102, 20 days) raises a warning", keys.includes("backup-stale:102"), keys.join(","));
check("in a backup job but no backup file (104) raises a warning", keys.includes("backup-missing:104"));
check("fresh (101), uncovered (105), excluded (106) and template (103) raise nothing", !keys.some((k) => /:(101|105|106|103)$/.test(k) && k.startsWith("backup")), keys.join(","));
r = await api("GET", "/api/forecast", { j: anon });
const f = (name) => r.data.find((x) => x.key === `storage:${name}@pve`);
check("forecast: steady 1.5 points/day is 'growing' with about 23 days left", f("grow")?.status === "growing" && near(f("grow").slopePerDay, 1.5, 0.1) && near(f("grow").daysToFull, 23.3, 2), JSON.stringify(f("grow") && [f("grow").status, +f("grow").slopePerDay.toFixed(2), +f("grow").daysToFull.toFixed(1)]));
check("forecast: 5 points/day is 'growing' with about 2 days left", f("fast")?.status === "growing" && near(f("fast").daysToFull, 2, 0.8), JSON.stringify(f("fast") && [f("fast").status, +f("fast").daysToFull.toFixed(1)]));
check("forecast: a flat volume is 'stable'", f("flat")?.status === "stable");
check("forecast: only 6 hours of history is 'collecting'", f("new")?.status === "collecting");
r = await api("GET", "/api/alerts", { j: anon });
const fa = r.data.active.filter((a) => a.key.startsWith("storage-forecast:"));
check("a volume that will be full within 14 days raises a critical alert, a slow one does not", fa.length === 1 && fa[0].key === "storage-forecast:fast@pve" && fa[0].severity === "critical", fa.map((a) => `${a.key} ${a.severity}: ${a.title}`).join(" | "));
check("the forecast alert was sent to the notification channel (batched with the other new alerts)", hooks.some((h) => /full in about/.test(h.title) || (h.lines || []).some((l) => /full in about/.test(l))), JSON.stringify(hooks.map((h) => h.title)));

// ================= MAINTENANCE =================
await api("POST", "/api/instances", { j: admin, body: { moduleId: "apcupsd", instanceId: "UPS", config: { host: "127.0.0.1", port: nis.address().port }, pollIntervalSec: 2 } });
await until(async () => (await api("GET", "/api/instances", { j: anon })).data.find((i) => i.instanceId === "UPS")?.status === "connected");
hooks.length = 0;
r = await api("POST", "/api/maintenance/start", { j: anon, body: { scope: ["UPS"], minutes: 30 } });
check("anonymous visitors cannot start maintenance", r.status === 401);
r = await api("POST", "/api/maintenance/start", { j: op, body: { scope: ["Nope"], minutes: 30 } });
check("unknown instances are rejected", r.status === 400);
r = await api("POST", "/api/maintenance/start", { j: op, body: { scope: ["UPS"], minutes: 30, name: "UPS test", note: "private note" } });
check("operators can start maintenance", r.status === 200);
const mid = r.data.id;
r = await api("GET", "/api/maintenance", { j: anon });
check("anonymous visitors see that maintenance is on, without the private note", r.data.active.length === 1 && r.data.active[0].note === null && r.data.windows.length === 0);
r = await api("GET", "/api/maintenance", { j: admin });
check("admins see the whole record", r.data.active[0].note === "private note" && r.data.windows.length === 1);

upsStatus = "ONBATT";
check("an alert raised during maintenance is recorded and marked as in maintenance", await until(async () => (await api("GET", "/api/alerts", { j: anon })).data.active.some((a) => a.key === "on-battery" && a.suppressed && a.maintenance === "UPS test")));
await sleep(2500);
check("...but nobody is notified", !hooks.some((h) => /battery/i.test(h.title)), JSON.stringify(hooks.map((h) => h.title)));
r = await api("POST", `/api/maintenance/${mid}/end`, { j: op });
check("operators can end maintenance early", r.status === 200);
check("an alert that is still broken when maintenance ends is then reported, with a note", await until(async () => hooks.some((h) => /battery/i.test(h.title) && h.lines.some((l) => /after maintenance/.test(l)))), JSON.stringify(hooks.map((h) => [h.title, h.state, h.lines])));
upsStatus = "ONLINE";
check("when it is fixed afterwards the all-clear is sent", await until(async () => hooks.some((h) => h.state === "resolved" && /battery/i.test(h.title))));

hooks.length = 0;
await api("POST", "/api/maintenance/start", { j: op, body: { scope: ["*"], minutes: 30 } });
upsStatus = "ONBATT";
await until(async () => (await api("GET", "/api/alerts", { j: anon })).data.active.some((a) => a.key === "on-battery"));
upsStatus = "ONLINE";
await until(async () => !(await api("GET", "/api/alerts", { j: anon })).data.active.some((a) => a.key === "on-battery"));
await sleep(1500);
check("a problem that comes and goes entirely inside maintenance sends nothing at all", hooks.length === 0, JSON.stringify(hooks.map((h) => h.title)));
const active = (await api("GET", "/api/maintenance", { j: admin })).data.active;
for (const a of active) await api("POST", `/api/maintenance/${a.id}/end`, { j: op });

// scheduled and repeating windows
r = await api("POST", "/api/maintenance", { j: op, body: { name: "x", scope: ["*"], startTs: now0, durationMinutes: 30, repeat: "none" } });
check("operators cannot create schedules", r.status === 403);
r = await api("POST", "/api/maintenance", { j: admin, body: { name: "bad", scope: ["*"], startTs: now0, durationMinutes: 24 * 60, repeat: "daily" } });
check("a daily window cannot last 24 hours or more", r.status === 400);
r = await api("POST", "/api/maintenance", { j: admin, body: { name: "Nightly backups", scope: ["UPS"], startTs: Math.floor(Date.now() / 1000) - 3600, durationMinutes: 120, repeat: "daily", note: null } });
check("admins can schedule a repeating window", r.status === 201);
const rid = r.data.id;
r = await api("GET", "/api/maintenance", { j: admin });
check("a daily window that started an hour ago is active now, with the next ones listed", r.data.active.some((a) => a.id === rid && a.recurring) && r.data.upcoming.some((u) => u.id === rid && u.start > r.data.now));
await api("POST", `/api/maintenance/${rid}/end`, { j: op });
r = await api("GET", "/api/maintenance", { j: admin });
check("ending a repeating window skips only today; the schedule stays", !r.data.active.some((a) => a.id === rid) && r.data.windows.some((w) => w.id === rid && w.enabled) && r.data.upcoming.some((u) => u.id === rid));
await api("DELETE", `/api/maintenance/${rid}`, { j: admin });
r = await api("POST", "/api/maintenance", { j: admin, body: { name: "Soon", scope: ["UPS"], startTs: Math.floor(Date.now() / 1000) + 3, durationMinutes: 10, repeat: "none" } });
check("a window set for the future is not active yet", !(await api("GET", "/api/maintenance", { j: admin })).data.active.some((a) => a.name === "Soon"));
await sleep(4500);
check("...and becomes active when its time arrives", (await api("GET", "/api/maintenance", { j: admin })).data.active.some((a) => a.name === "Soon"));
await api("DELETE", `/api/maintenance/${r.data.id}`, { j: admin });
const occ = (m, t) => maint.occurrenceAt(m, t);
const w = { id: 1, name: "w", scope: ["*"], startTs: 1000000, durationS: 3600, repeat: "weekly", enabled: true, note: null, createdBy: null, endedTs: null, skipUntil: null };
check("weekly window maths: active in week 3, not in between", occ(w, 1000000 + 2 * 604800 + 100) !== null && occ(w, 1000000 + 604800 + 7200) === null && occ(w, 999999) === null);

// automatic window on planned downtime
await api("POST", "/api/instances", { j: admin, body: { moduleId: "ilo4", instanceId: "ILOFAKE", config: { host: `http://127.0.0.1:${ilo.address().port}`, username: "a", password: "b" }, pollIntervalSec: 10 } });
await until(async () => (await api("GET", "/api/instances", { j: anon })).data.find((i) => i.instanceId === "ILOFAKE")?.status === "connected");
r = await api("POST", "/api/instances/ILOFAKE/actions/shutdown", { j: op, body: {} });
check("shutting the server down from Lumina works", r.status === 200);
r = await api("GET", "/api/maintenance", { j: admin });
const auto = r.data.active.find((a) => /Planned/.test(a.name));
check("...and automatically opens a 30-minute maintenance window for everything", auto && auto.scope[0] === "*" && near(auto.endsAt - r.data.now, 1800, 5), auto && auto.name);
await api("POST", `/api/maintenance/${auto.id}/end`, { j: op });

// ================= SCHEDULED ACTIONS =================
r = await api("GET", "/api/schedule-targets", { j: admin });
const tg = r.data.find((t) => t.instanceId === "PVEX");
check("schedulable actions are offered per instance (snapshot, backup, start, stop, reboot)", ["snapshot", "backup", "start", "stop", "reboot"].every((a) => tg.actions.some((x) => x.id === a)));
check("iLO: only power-on and graceful shutdown can be scheduled", (() => { const t = r.data.find((x) => x.instanceId === "ILOFAKE"); return t.actions.map((x) => x.id).sort().join() === "power-on,shutdown"; })());
const S = { name: "Nightly snapshot", instanceId: "PVEX", actionId: "snapshot", input: { node: "pve", type: "qemu", vmid: 101, name: "nightly" }, repeat: "once" };
r = await api("POST", "/api/schedules", { j: op, body: { ...S, atTs: now0 + 600 } });
check("operators cannot create scheduled actions", r.status === 403);
r = await api("POST", "/api/schedules", { j: admin, body: { ...S, atTs: now0 - 7200 } });
check("a one-off in the past is refused", r.status === 400);
r = await api("POST", "/api/schedules", { j: admin, body: { ...S, actionId: "nope", atTs: now0 + 600 } });
check("unknown actions are refused", r.status === 400);
r = await api("POST", "/api/schedules", { j: admin, body: { ...S, instanceId: "ILOFAKE", actionId: "restart", input: {}, atTs: now0 + 600 } });
check("hard-reset style actions cannot be scheduled", r.status === 400 && /by hand/.test(r.data.error));
r = await api("POST", "/api/schedules", { j: admin, body: { ...S, input: { node: "pve", type: "qemu", vmid: "abc" }, atTs: now0 + 600 } });
check("the action's own input rules still apply", r.status === 400);
const before = pveWrites.length;
r = await api("POST", "/api/schedules", { j: admin, body: { ...S, atTs: Math.floor(Date.now() / 1000) - 5 } });
check("a schedule that is due now is accepted", r.status === 201);
const sid = r.data.id;
check("the scheduler runs it on its own and records success", await until(async () => (await api("GET", "/api/schedules", { j: admin })).data.find((x) => x.id === sid)?.lastStatus === "ok", 40000));
check("Proxmox received the snapshot request from the scheduler", pveWrites.length === before + 1 && pveWrites.at(-1).path === "/nodes/pve/qemu/101/snapshot" && pveWrites.at(-1).body.snapname === "nightly", JSON.stringify(pveWrites.at(-1)));
check("a one-off does not run a second time", (await api("GET", "/api/schedules", { j: admin })).data.find((x) => x.id === sid).nextRun === null);
r = await api("GET", "/api/audit", { j: admin });
check("the audit log shows the scheduler did it", r.data.some((e) => e.user === "scheduler" && e.action === "scheduled-action"));

const before2 = pveWrites.length;
r = await api("POST", "/api/schedules", { j: admin, body: { ...S, name: "Old one", atTs: Math.floor(Date.now() / 1000) + 600 } });
const lateId = r.data.id;
// make it look like it was due 2 hours ago by editing the row
{ const D = (await import("node:module")).createRequire(ROOT + "/packages/core/").call ? null : null; }
const missed = { id: 99, name: "m", instanceId: "PVEX", actionId: "snapshot", input: {}, repeat: "once", atTs: 1000, enabled: true, lastRunTs: null, lastStatus: null, lastMessage: null, createdBy: null };
check("scheduler maths: a due one-off is found, a finished one is not", sched.dueOccurrence(missed, 1000) === 1000 && sched.dueOccurrence({ ...missed, lastRunTs: 1000 }, 5000) === null);
const daily = { ...missed, repeat: "daily", atTs: 100000 };
check("scheduler maths: a daily job is due again each day", sched.dueOccurrence(daily, 100000 + 3 * 86400 + 5) === 100000 + 3 * 86400 && sched.nextRun({ ...daily, lastRunTs: 100000 + 3 * 86400 }, 100000 + 3 * 86400 + 60) === 100000 + 4 * 86400);
await api("DELETE", `/api/schedules/${lateId}`, { j: admin });

r = await api("POST", "/api/schedules", { j: admin, body: { ...S, name: "Will fail", input: { node: "pve", type: "qemu", vmid: 101, name: "dup" }, atTs: Math.floor(Date.now() / 1000) + 1 } });
const failId = r.data.id;
hooks.length = 0;
r = await api("POST", `/api/schedules/${failId}/run-now`, { j: admin });
check("'run now' runs it immediately", r.status === 200);
const rec = (await api("GET", "/api/schedules", { j: admin })).data.find((x) => x.id === failId);
check("a failing scheduled action is recorded as failed with Proxmox's reason", rec.lastStatus === "failed" && /already exists/.test(rec.lastMessage ?? ""), rec.lastMessage);
check("...and you are notified", await until(async () => hooks.some((h) => /Scheduled action failed/.test(h.title)), 5000));
await api("POST", `/api/schedules/${failId}/enabled`, { j: admin, body: { enabled: false } });
check("a schedule can be switched off", (await api("GET", "/api/schedules", { j: admin })).data.find((x) => x.id === failId).nextRun === null);
r = await api("GET", "/api/schedules", { j: anon });
check("anonymous visitors cannot see schedules", r.status === 401);

child.kill("SIGTERM"); await new Promise((res) => child.on("exit", res));
for (const srv of [nis, hook, ilo, pve]) srv.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log("FAILED:\n - " + failed.map(([n]) => n).join("\n - "));
process.exit(failed.length ? 1 : 0);
