import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import https from "node:https";
import http from "node:http";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const { chromium } = createRequire(ROOT + "/")("playwright-core");
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
  rows.push({ instanceId: "PVEX", key: "storage:backup-dir@pve", ts: t, value: 20 + 3 * d + noise(t) });
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
const PORT = 3995;
const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: String(PORT), LUMINA_DATA: data, LUMINA_TLS: "off", LUMINA_UI_DIR: ROOT + "/packages/ui/dist", LOG_LEVEL: "warn" }, stdio: "ignore" });
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


// ================= UI =================
await api("PUT", "/api/energy/settings", { j: admin, body: baseEnergy() });
await api("POST", "/api/instances", { j: admin, body: { moduleId: "proxmox", instanceId: "PVEX", config: { host: `https://127.0.0.1:${pve.address().port}`, tokenId: "root@pam!t", tokenSecret: "secret-secret", verifyTls: false, backupMaxAgeDays: 8, backupExclude: "106" }, pollIntervalSec: 5 } });
await api("POST", "/api/instances", { j: admin, body: { moduleId: "apcupsd", instanceId: "UPS", config: { host: "127.0.0.1", port: nis.address().port }, pollIntervalSec: 2 } });
await until(async () => { const l = (await api("GET", "/api/instances", { j: anon })).data; return l.find((i) => i.instanceId === "PVEX")?.data?.guests?.length === 6 && l.find((i) => i.instanceId === "UPS")?.status === "connected"; });
await sleep(8000);

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const errors = [];
const open = async (jarObj, hash, w = 1500, h = 900) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  if (jarObj?.cookie) await ctx.addCookies([{ name: "lumina_session", value: jarObj.cookie.split("=")[1], url: base }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${base}/#/${hash}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  return { ctx, page };
};
const text = (page) => page.evaluate(() => document.body.innerText);

// ---- Overview ----
let { ctx, page } = await open(admin, "overview");
let t = await text(page);
check("Overview shows an Energy tile with kWh and your currency", /ENERGY THIS CYCLE/i.test(t) && /Rp /.test(t), (t.match(/ENERGY THIS CYCLE[\s\S]{0,80}/i) || [""])[0].replace(/\n/g, " "));
check("Overview shows a Backups tile (fresh / tracked)", /BACKUPS FRESH/i.test(t) && /\d+\/\d+/.test((t.match(/BACKUPS FRESH[\s\S]{0,40}/i) || [""])[0]), (t.match(/BACKUPS FRESH[\s\S]{0,60}/i) || [""])[0].replace(/\n/g, " "));
check("Overview storage row shows the forecast for the growing volume", /full in ~\d+ days?/.test(t), (t.match(/full in ~\d+ days?/) || ["none"])[0]);
const nav = await page.locator(".nav button").allInnerTexts();
check("navigation has Energy and Maintenance tabs", nav.some((x) => /Energy/.test(x)) && nav.some((x) => /Maintenance/.test(x)), nav.join(" | "));
await ctx.close();

// ---- Energy page ----
({ ctx, page } = await open(admin, "energy"));
t = await text(page);
check("Energy page: usage, cost, projection and data-quality tiles", /ENERGY USED/i.test(t) && /PROJECTED FOR THE CYCLE/i.test(t) && /DATA QUALITY/i.test(t));
check("Energy page: shows where the power goes (server vs everything else)", /Where the power goes/.test(t) && /Everything else on the UPS/.test(t));
check("Energy page: explains how it is measured", /How this is measured/.test(t) && /estimate/i.test(t));
check("Energy page: bars drawn for the billing cycle", (await page.locator(".chart svg rect.ebar").count()) >= 5, String(await page.locator(".chart svg rect.ebar").count()));
await page.getByRole("button", { name: "Yesterday" }).click(); await page.waitForTimeout(1200);
t = await text(page);
check("Yesterday: 2.40 kWh and a flat Rp 3,986 cost (Indonesian number format)", /2\.40/.test(t) && /Rp 3\.986/.test(t), (t.match(/ENERGY USED[\s\S]{0,60}/i) || [""])[0].replace(/\n/g, " "));
check("Yesterday: 24 hourly bars", (await page.locator(".chart svg rect.ebar").count()) === 24);
await page.getByRole("button", { name: "Rp", exact: true }).click(); await page.waitForTimeout(300);
await page.locator(".chart svg rect.ebar").nth(5).hover({ force: true });
check("hovering a bar in cost mode shows the amount", /Rp /.test(await page.locator(".chart-readout").innerText()), await page.locator(".chart-readout").innerText());

await page.getByRole("button", { name: "Prices and settings" }).click(); await page.waitForTimeout(800);
check("price editor opens with your Rp 1,661 flat price", (await page.locator('input[type="number"]').first().inputValue()) === "1661");
await page.getByRole("button", { name: "By time of day" }).click();
await page.getByRole("button", { name: "+ Add a time-of-day rule" }).click();
await page.waitForTimeout(300);
await page.locator('input[placeholder="Name, e.g. Night"]').fill("Night");
const rulePrice = page.locator(".subpanel input[type=number]").first();
await rulePrice.fill("1000");
const defaultPrice = page.locator('label:has-text("Price when no rule below applies") input');
await defaultPrice.fill("2000");
await page.getByRole("button", { name: "What would this cost? (preview)" }).click();
await page.waitForSelector("text=these settings give");
const previewText = await page.locator(".subpanel", { hasText: "these settings give" }).innerText();
check("preview prices yesterday with the time-of-day rule (Rp 4.000) and says nothing is saved", /Rp 4\.000/.test(previewText) && /Nothing is saved/.test(previewText), previewText.replace(/\n/g, " ").slice(0, 160));
check("...and the saved tariff is untouched", (await api("GET", "/api/energy/settings", { j: admin })).data.settings.tariff.type === "flat");
await page.getByRole("button", { name: "Save", exact: true }).click();
await page.waitForSelector(".toast");
const saved = (await api("GET", "/api/energy/settings", { j: admin })).data.settings;
check("saving stores the new tariff", saved.tariff.type === "tou" && saved.tariff.tou.defaultPrice === 2000 && saved.tariff.tou.rules[0].price === 1000 && saved.tariff.tou.rules[0].name === "Night");

// invalid input is reported, not swallowed
await page.locator('label:has-text("Billing cycle starts on day") input').fill("40");
await page.getByRole("button", { name: "Save", exact: true }).click();
await page.waitForFunction(() => /billingDay|28/.test(document.querySelector(".toast")?.innerText ?? ""), null, { timeout: 6000 }).catch(() => undefined);
check("an invalid value (billing day 40) is refused with a message", /less than or equal to 28|billingDay/i.test(await page.locator(".toast").innerText()), (await page.locator(".toast").innerText()).slice(0, 100));
await page.locator('label:has-text("Billing cycle starts on day") input').fill("1");

// calibrate against a meter: Lumina saw 7.2 kWh over 3 days (3 x 2.4); meter says 7.92 -> 1.1
const d = (n) => { const x = new Date(Date.now() - n * 86400000); return new Date(x.getTime() + 7 * 3600000).toISOString().slice(0, 10); };
const calBox = page.locator(".subpanel", { hasText: "Calibrate against your meter" });
await calBox.locator('input[type="date"]').nth(0).fill(d(3));
await calBox.locator('input[type="number"]').nth(0).fill("1000");
await calBox.locator('input[type="date"]').nth(1).fill(d(0));
await calBox.locator('input[type="number"]').nth(1).fill("1007.92");
await calBox.getByRole("button", { name: "Compare" }).click();
await page.waitForSelector("text=Suggested factor");
const calText = await calBox.innerText();
check("calibration helper compares Lumina with the meter and suggests a factor", /Suggested factor: ×\d\.\d{3}/.test(calText), (calText.match(/Lumina measured[\s\S]{0,200}/) || [""])[0].replace(/\n/g, " "));
await calBox.getByRole("button", { name: /Apply this factor/ }).click();
const calField = await page.locator('label:has-text("Calibration factor") input').inputValue();
check("applying it fills the calibration factor", Number(calField) > 1 && Number(calField) < 1.5, calField);
await ctx.close();

// ---- Maintenance page: operator ----
({ ctx, page } = await open(op, "maintenance"));
t = await text(page);
check("operator sees the start-maintenance form but cannot add schedules", /Start maintenance now/.test(t) && (await page.getByRole("button", { name: "+ Add" }).count()) === 0);
await page.getByRole("button", { name: "30 min" }).click();
await page.getByPlaceholder("Name (optional), e.g. Moving the rack").fill("UI test window");
await page.getByRole("button", { name: "Start maintenance", exact: true }).click();
await page.waitForSelector("text=Running now");
check("starting maintenance shows it as running, with an End now button", /UI test window/.test(await text(page)) && (await page.getByRole("button", { name: "End now" }).count()) === 1);
check("the Maintenance tab shows an 'on' badge", (await page.locator(".nav button", { hasText: "Maintenance" }).innerText()).includes("on"));
await page.goto(`${base}/#/overview`); await page.waitForTimeout(1500);
t = await text(page);
check("the Overview says maintenance is in progress and notifications are muted", /UI test window/.test(t) && /notifications muted/i.test(t));
await page.goto(`${base}/#/maintenance`); await page.waitForTimeout(800);
await page.getByRole("button", { name: "End now" }).click();
await page.waitForTimeout(1200);
check("End now stops it", (await page.getByText("Running now").count()) === 0);
await ctx.close();

// ---- Maintenance page: admin schedules ----
({ ctx, page } = await open(admin, "maintenance"));
await page.locator("section", { hasText: "Scheduled windows" }).getByRole("button", { name: "+ Add" }).click();
await page.getByPlaceholder("Name, e.g. Nightly backups").fill("Weekly backup quiet time");
await page.locator('select').filter({ hasText: "Every week" }).selectOption("weekly");
await page.getByRole("button", { name: "Save", exact: true }).click();
await page.waitForSelector("text=Weekly backup quiet time");
check("admin can add a repeating window and it is listed", /every week/.test(await text(page)));
const w = (await api("GET", "/api/maintenance", { j: admin })).data.windows.find((x) => x.name === "Weekly backup quiet time");
check("the repeat setting reached the server", w && w.repeat === "weekly" && w.scope[0] === "*");

await page.locator("section", { hasText: "Scheduled actions" }).getByRole("button", { name: "+ Add" }).click();
await page.waitForSelector("text=Instance");
await page.locator("form select").first().selectOption("PVEX");
await page.waitForTimeout(500);
await page.getByPlaceholder("automatic").fill("ui-schedule");
await page.locator('form input[maxlength="80"]').last().fill("UI snapshot job");
await page.getByRole("button", { name: "Schedule", exact: true }).click();
await page.waitForSelector("text=UI snapshot job");
const sch = (await api("GET", "/api/schedules", { j: admin })).data.find((x) => x.name === "UI snapshot job");
check("admin can schedule a snapshot of a guest from the page", sch && sch.actionId === "snapshot" && sch.input.name === "ui-schedule" && sch.nextRun > now0, JSON.stringify(sch && sch.input));
await page.getByRole("button", { name: "Pause" }).last().click();
await page.waitForTimeout(800);
check("a schedule can be paused from the page", (await api("GET", "/api/schedules", { j: admin })).data.find((x) => x.name === "UI snapshot job").enabled === false);
await ctx.close();

// ---- Instances: backup age + forecast ----
({ ctx, page } = await open(admin, "instances", 1700, 900));
await page.locator(".card-title", { hasText: "PVEX" }).click();
await page.waitForTimeout(1200);
const row = (name) => page.locator("tr", { hasText: name }).first().innerText();
const rWeb = await row("web"), rDb = await row("db"), rApp = await row("app"), rMisc = await row("misc"), rOld = await row("old");
check("backup column: 'web' is 3 days old, with the number of backups kept", /3 d ago/.test(rWeb) && /2/.test(rWeb), rWeb.replace(/\s+/g, " "));
check("backup column: 'db' is 20 days old and flagged", /20 d ago/.test(rDb));
check("backup column: 'app' is in a job but has none", /none found/.test(rApp));
check("backup column: 'misc' is not in a job; 'old' is excluded", /not in a job/.test(rMisc) && /excluded/.test(rOld));
const stor = await page.locator("tr", { hasText: "backup-dir" }).first().innerText();
check("storage table has a forecast column", /full in ~\d+ day/.test(stor), stor.replace(/\s+/g, " "));
await ctx.close();

// ---- anonymous ----
({ ctx, page } = await open(null, "energy"));
t = await text(page);
check("anonymous visitors can read the energy page but not change prices", /ENERGY USED/i.test(t) && (await page.getByRole("button", { name: "Prices and settings" }).count()) === 0);
await page.goto(`${base}/#/maintenance`); await page.waitForTimeout(1200);
check("anonymous visitors cannot start maintenance", /Sign in as an operator or admin/.test(await text(page)));
await ctx.close();

// ---- the wall display still fits with the extra tiles ----
for (const [w2, h2] of [[1920, 1080], [1366, 768]]) {
  ({ ctx, page } = await open(admin, "tv", w2, h2));
  await page.waitForTimeout(4500);
  const m = await page.evaluate(() => ({ over: [...document.querySelectorAll(".pbody")].filter((p) => p.scrollHeight > p.clientHeight + 1).length, scroll: document.documentElement.scrollHeight - innerHeight, kpis: document.querySelectorAll(".kpi").length, font: parseFloat(getComputedStyle(document.querySelector(".tv")).fontSize) }));
  check(`TV mode ${w2}x${h2}: all ${m.kpis} tiles fit, nothing scrolls or is cut off`, m.over === 0 && m.scroll <= 1 && m.kpis >= 8, JSON.stringify(m));
  await ctx.close();
}
check("no browser errors on any page", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
child.kill("SIGTERM"); await new Promise((res) => child.on("exit", res));
for (const srv of [nis, hook, ilo, pve]) srv.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log("FAILED:\n - " + failed.map(([n]) => n).join("\n - "));
process.exit(failed.length ? 1 : 0);
