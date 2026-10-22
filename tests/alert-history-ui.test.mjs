// The Alerts page History: filters, search, paging, and that it is readable without signing in.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(ROOT + "/")("playwright-core");

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { openDb } = await import(ROOT + "/packages/core/dist/db.js");
const dir = mkdtempSync(join(tmpdir(), "lumina-hist-"));
const dbPath = join(dir, "t.db");
const store = openDb(dbPath);
// 150 events: alternating instances and severities, every 7th resolved.
const ids = [];
for (let i = 0; i < 150; i++) {
  const id = store.events.insert({ instanceId: i % 2 ? "Prox-1" : "Prox-4", key: `k${i}`, severity: ["critical", "warning", "info"][i % 3], title: i === 10 ? "100% full /var_log" : `Problem number ${i}`, detail: i === 11 ? "drive 1I:3:4 failed" : null });
  ids.push(id);
  if (i % 7 === 0) store.events.resolve(id);
}
const S = (f) => store.events.search({ limit: 50, ...f });
let r = S({});
check("the first page has 50 rows, newest first, and says there are more", r.events.length === 50 && r.hasMore && r.total === 150 && r.events[0].id === ids[149], `${r.events.length}/${r.total}`);
const p2 = S({ before: r.events[49].id });
const p3 = S({ before: p2.events[49].id });
check("paging walks through every event exactly once", p2.events.length === 50 && p3.events.length === 50 && !p3.hasMore && new Set([...r.events, ...p2.events, ...p3.events].map((e) => e.id)).size === 150);
check("filter by instance", S({ instance: "Prox-1" }).total === 75 && S({ instance: "Prox-1" }).events.every((e) => e.instanceId === "Prox-1"));
check("filter by severity", S({ severity: "critical" }).total === 50);
check("filters combine", S({ instance: "Prox-1", severity: "info", state: "firing" }).events.every((e) => e.instanceId === "Prox-1" && e.severity === "info" && e.state === "firing"));
check("filter by state", S({ state: "resolved" }).total === 22 && S({ state: "firing" }).total === 128, `${S({ state: "resolved" }).total}`);
check("search finds text in the title", S({ q: "number 149" }).total === 1);
check("search finds text in the details", S({ q: "1I:3:4" }).total === 1);
check("search treats % and _ literally", S({ q: "100%" }).total === 1 && S({ q: "var_log" }).total === 1 && S({ q: "%" }).total === 1 && S({ q: "_" }).total === 1, `${S({ q: "%" }).total}`);
check("search does not break on quotes", S({ q: "' OR 1=1 --" }).total === 0);
check("the period filter drops older events", S({ since: Math.floor(Date.now() / 1000) + 3600 }).total === 0);
check("the instance list for the filter box is complete", JSON.stringify(store.events.instances()) === JSON.stringify(["Prox-1", "Prox-4"]));

// over HTTP, without signing in
store.close?.();
const PORT = 3989;
const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: String(PORT), LUMINA_DB: dbPath, LUMINA_UI_DIR: ROOT + "/packages/ui/dist", LOG_LEVEL: "error" }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ } await sleep(300); }
// A fresh install would show the first-run screen; create the admin so the page is the dashboard.
await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "boss", password: "correct horse battery", setupCode: readFileSync(join(dir, "setup-code"), "utf8").trim() }) });
let h = await (await fetch(`${base}/api/alerts/history?limit=10&severity=warning`)).json();
check("anyone who may view alerts can read the history", h.events?.length === 10 && h.total === 50 && h.hasMore === true && h.instances.length === 2, JSON.stringify(h).slice(0, 100));
check("bad parameters are refused, not ignored", (await fetch(`${base}/api/alerts/history?limit=100000`)).status === 400 && (await fetch(`${base}/api/alerts/history?severity=bogus`)).status === 400);
h = await (await fetch(`${base}/api/alerts/history?q=${encodeURIComponent("%' OR '1'='1")}`)).json();
check("a hostile search string returns nothing and breaks nothing", h.total === 0);

// the page itself
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${base}/#/alerts`);
await page.waitForSelector('input[aria-label="Search alert history"]');
await page.waitForTimeout(1500);
const rowsShown = () => page.locator("section:has(h2:has-text('History')) tbody tr").count();
check("the History panel shows the first 50 of 150 and offers more", (await rowsShown()) === 50 && /showing 50 of 150|150/.test(await page.locator("body").innerText()) , String(await rowsShown()));
await page.getByRole("button", { name: "Show 50 more" }).click();
await page.waitForTimeout(800);
check("'Show 50 more' adds the next page", (await rowsShown()) === 100);
await page.selectOption('select[aria-label="Period"]', "all");
await page.getByRole("button", { name: "Show 50 more" }).click(); await page.waitForTimeout(600);
await page.getByRole("button", { name: "Show 50 more" }).click().catch(() => undefined); await page.waitForTimeout(600);
check("all 150 can be reached and the button goes away", (await rowsShown()) === 150 && (await page.getByRole("button", { name: "Show 50 more" }).count()) === 0, String(await rowsShown()));
await page.fill('input[aria-label="Search alert history"]', "1I:3:4");
await page.waitForTimeout(1200);
check("searching narrows the list to the matching alert and shows its details", (await rowsShown()) === 1 && /drive 1I:3:4 failed/.test(await page.locator("body").innerText()));
await page.fill('input[aria-label="Search alert history"]', "");
await page.selectOption('select[aria-label="Instance"]', "Prox-1");
await page.selectOption('select[aria-label="Severity"]', "critical");
await page.waitForTimeout(1200);
const t = await page.locator("section:has(h2:has-text('History')) tbody").innerText();
check("instance and severity filters combine", (await rowsShown()) > 0 && (await rowsShown()) < 50 && !/Prox-4/.test(t), String(await rowsShown()));
await page.getByRole("button", { name: "Show everything" }).click();
await page.waitForTimeout(1200);
check("'Show everything' clears the filters", (await rowsShown()) === 50);
const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
check("Export CSV downloads a file", /^lumina-alerts-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()), download.suggestedFilename());
check("no browser errors", errors.length === 0, errors.join(" | "));
await browser.close();
child.kill();
process.exit(ok ? 0 : 1);
