// A linked Lumina made with a full-detail token shows each of the other Lumina's devices with its own card, read-only and with no history requests.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(ROOT + "/")("playwright-core");

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 40000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(400); } return false; };

const nis = net.createServer((s) => s.on("data", () => {
  for (const l of ["MODEL    : Fake UPS\n", "UPSNAME  : office-ups\n", "STATUS   : ONLINE\n", "LOADPCT  : 020.0 Percent\n", "BCHARGE  : 100.0 Percent\n", "TIMELEFT : 30.0 Minutes\n", "NOMPOWER : 700 Watts\n", "END APC  : 2026-01-01\n"]) {
    const b = Buffer.from(l); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); s.write(Buffer.concat([h, b]));
  }
  s.end(Buffer.alloc(2));
}));
await new Promise((r) => nis.listen(0, "127.0.0.1", r));

function start(port) {
  const dir = mkdtempSync(join(tmpdir(), "lumina-rd-"));
  const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: String(port), LUMINA_DATA: dir, LUMINA_TLS: "off", LOG_LEVEL: "error" }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const jar = { cookie: "" };
  const api = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(jar.cookie ? { cookie: jar.cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get("set-cookie"); if (sc && !sc.startsWith("lumina_session=;")) jar.cookie = sc.split(";")[0];
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  };
  return { child, dir, base, api, jar };
}
const office = start(3979), home = start(3978);
for (const s of [office, home]) {
  await until(async () => { try { return (await fetch(`${s.base}/health`)).ok; } catch { return false; } }, 20000);
  await s.api("POST", "/api/auth/setup", { username: "boss", password: "correct horse battery", setupCode: readFileSync(join(s.dir, "setup-code"), "utf8").trim() });
}
await office.api("POST", "/api/instances", { moduleId: "apcupsd", instanceId: "Office-UPS", config: { host: "127.0.0.1", port: nis.address().port }, pollIntervalSec: 5 });
await office.api("POST", "/api/instances", { moduleId: "netcheck", instanceId: "Checks", config: { targets: "Local | tcp | 127.0.0.1:1" }, pollIntervalSec: 10 });
const token = (await office.api("POST", "/api/tokens", { name: "Home", detail: true })).data.token;
await home.api("POST", "/api/instances", { moduleId: "lumina", instanceId: "Lumina Office", config: { url: office.base, label: "Office", token }, pollIntervalSec: 10 });
check("home has the full detail of the office", await until(async () => (await home.api("GET", "/api/instances")).data.find((i) => i.instanceId === "Lumina Office")?.data?.remote?.length === 2));

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const errors = [], requests = [];
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await ctx.addCookies([{ name: "lumina_session", value: home.jar.cookie.split("=")[1], url: home.base }]);
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on("request", (r) => requests.push(r.url()));
await page.goto(`${home.base}/#/instances`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

await page.locator("section.inst", { hasText: "Lumina Office" }).first().locator(".card-title").first().click();
await page.waitForTimeout(1500);
const titles = await page.locator(".remote-devices .card-title").allInnerTexts();
check("each device of the office has its own card inside the office card", titles.length === 2 && titles.some((t) => /Office: Office-UPS/.test(t)) && titles.some((t) => /Office: Checks/.test(t)), JSON.stringify(titles));
const tools = await page.locator(".remote-devices .card-tools").first().innerText();
check("those cards are read-only: no refresh, pause, move, edit or remove", !/Pause|Resume|Edit|Remove|⟳|▲|▼/.test(tools), tools);

await page.locator(".remote-devices section.inst", { hasText: "Office-UPS" }).locator(".card-title").first().click();
await page.waitForTimeout(1200);
const ups = await page.locator(".remote-devices section.inst", { hasText: "Office-UPS" }).innerText();
check("the UPS card opens with the UPS's own details", /Fake UPS|Battery|Load|Runtime/i.test(ups), ups.slice(0, 160).replace(/\n/g, " | "));
await page.locator(".remote-devices section.inst", { hasText: "Checks" }).locator(".card-title").first().click();
await page.waitForTimeout(1200);
const checks = await page.locator(".remote-devices section.inst", { hasText: "Checks" }).innerText();
check("the network-check card shows the address that anonymous viewers would not see", /127\.0\.0\.1:1/.test(checks), checks.slice(0, 200).replace(/\n/g, " | "));
check("no history is asked for from home for the office's devices", !requests.some((u) => /\/api\/instances\/Office[^/]*\/metrics|\/api\/instances\/[^/]*Office[^/]*\/metrics/.test(decodeURIComponent(u)) && /Office-UPS|Checks/.test(decodeURIComponent(u))), requests.filter((u) => /metrics/.test(u)).map((u) => decodeURIComponent(u).slice(0, 90)).join(" | "));
check("no browser errors", errors.length === 0, errors.join(" | ").slice(0, 300));

// the card of a summary-only token stays as it was
const plain = (await office.api("POST", "/api/tokens", { name: "Plain" })).data.token;
await home.api("PUT", "/api/instances/Lumina%20Office", { config: { url: office.base, label: "Office", token: plain } });
check("with a normal token the card falls back to the summary table", await until(async () => (await home.api("GET", "/api/instances")).data.find((i) => i.instanceId === "Lumina Office")?.data?.detailed === false));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);
const body = await page.locator("section.inst", { hasText: "Lumina Office" }).first().innerText();
check("and says how to get the detail", (await page.locator(".remote-devices").count()) === 0 && /Full detail/.test(body), body.slice(0, 200).replace(/\n/g, " | "));
await browser.close(); office.child.kill(); home.child.kill(); nis.close();
process.exit(ok ? 0 : 1);
