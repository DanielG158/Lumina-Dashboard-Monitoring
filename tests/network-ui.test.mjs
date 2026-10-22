// The Network checks and SNMP cards, the Overview tile and TV-mode fit, in a real browser.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(ROOT + "/")("playwright-core");
const snmp = createRequire(ROOT + "/packages/modules/snmp/")("net-snmp");

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(400); } return false; };

const tcp = net.createServer((s) => s.end()); await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
const web = http.createServer((q, s) => {
  if (q.url.startsWith("/__down")) { const n = Number(new URL(q.url, "http://x").searchParams.get("bytes")); s.writeHead(200, { "content-length": n }); s.end(Buffer.alloc(n, 1)); return; }
  if (q.url === "/__up") { q.resume(); q.on("end", () => s.end("ok")); return; }
  s.end("ok");
}); await new Promise((r) => web.listen(0, "127.0.0.1", r));
const SPORT = 16188;
const agent = snmp.createAgent({ port: SPORT, address: "127.0.0.1" }, () => undefined);
agent.getAuthorizer().addCommunity("lab");
const mib = agent.getMib();
const col = (n, name, type) => ({ number: n, name, type, maxAccess: snmp.MaxAccess["read-only"] });
mib.registerProvider({ name: "ifEntry", type: snmp.MibProviderType.Table, oid: "1.3.6.1.2.1.2.2.1", maxAccess: snmp.MaxAccess["not-accessible"], tableColumns: [col(1, "ifIndex", snmp.ObjectType.Integer), col(2, "ifDescr", snmp.ObjectType.OctetString), col(3, "ifType", snmp.ObjectType.Integer), col(5, "ifSpeed", snmp.ObjectType.Gauge), col(8, "ifOperStatus", snmp.ObjectType.Integer), col(10, "ifInOctets", snmp.ObjectType.Counter), col(14, "ifInErrors", snmp.ObjectType.Counter), col(16, "ifOutOctets", snmp.ObjectType.Counter), col(20, "ifOutErrors", snmp.ObjectType.Counter)], tableIndex: [{ columnName: "ifIndex" }] });
mib.registerProvider({ name: "ifXEntry", type: snmp.MibProviderType.Table, oid: "1.3.6.1.2.1.31.1.1.1", maxAccess: snmp.MaxAccess["not-accessible"], tableColumns: [col(99, "ifIndex", snmp.ObjectType.Integer), col(1, "ifName", snmp.ObjectType.OctetString), col(6, "ifHCInOctets", snmp.ObjectType.Counter64), col(10, "ifHCOutOctets", snmp.ObjectType.Counter64), col(15, "ifHighSpeed", snmp.ObjectType.Gauge), col(18, "ifAlias", snmp.ObjectType.OctetString)], tableIndex: [{ columnName: "ifIndex" }] });
const be = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
mib.addTableRow("ifEntry", [1, "igb0", 6, 0, 1, 0, 0, 0, 0]); mib.addTableRow("ifXEntry", [1, "igb0", be(0), be(0), 1000, "WAN"]);
mib.addTableRow("ifEntry", [2, "igb1", 6, 0, 2, 0, 0, 0, 0]); mib.addTableRow("ifXEntry", [2, "igb1", be(0), be(0), 1000, "LAN"]);
let bytes = 0;
const bump = setInterval(() => { bytes += 2_000_000; try { mib.deleteTableRow("ifXEntry", [1]); mib.addTableRow("ifXEntry", [1, "igb0", be(bytes * 5), be(bytes), 1000, "WAN"]); } catch { /* ignore */ } }, 1000);

const dir = mkdtempSync(join(tmpdir(), "lumina-netui-"));
const PORT = 3990;
const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: String(PORT), LUMINA_DATA: dir, LUMINA_TLS: "off", LUMINA_UI_DIR: ROOT + "/packages/ui/dist", LOG_LEVEL: "error" }, stdio: ["ignore", "ignore", "inherit"] });
const base = `http://127.0.0.1:${PORT}`;
await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 20000);
const jar = { cookie: "" };
const api = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(jar.cookie ? { cookie: jar.cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie"); if (sc && !sc.startsWith("lumina_session=;")) jar.cookie = sc.split(";")[0];
  let d = null; try { d = await res.json(); } catch { /* empty */ }
  return { status: res.status, data: d };
};
await api("POST", "/api/auth/setup", { username: "boss", password: "correct horse battery", setupCode: readFileSync(join(dir, "setup-code"), "utf8").trim() });
let r = await api("POST", "/api/instances", { moduleId: "netcheck", instanceId: "LAN-Checks", config: { targets: `Gateway tcp | tcp | 127.0.0.1:${tcp.address().port}\nWeb | http | http://127.0.0.1:${web.address().port}/\nDead | tcp | 127.0.0.1:9`, packets: 2, speedTest: true, speedTestEveryHours: 6, speedTestMB: 3, speedTestDownloadUrl: `http://127.0.0.1:${web.address().port}/__down`, speedTestUploadUrl: `http://127.0.0.1:${web.address().port}/__up` }, pollIntervalSec: 10 });
check("a Network checks instance is added through the API", r.status === 201, JSON.stringify(r.data));
r = await api("POST", "/api/instances", { moduleId: "netcheck", instanceId: "Bad", config: { targets: "nonsense" } });
check("a bad check list is refused with the reason", r.status === 400 && /line 1/.test(JSON.stringify(r.data)), JSON.stringify(r.data).slice(0, 120));
r = await api("POST", "/api/instances", { moduleId: "snmp", instanceId: "Firewall", config: { host: "127.0.0.1", port: SPORT, community: "lab", watch: "igb0, igb1" }, pollIntervalSec: 5 });
check("an SNMP instance is added", r.status === 201, JSON.stringify(r.data));
await until(async () => { const l = (await api("GET", "/api/instances")).data; const f = l.find((i) => i.instanceId === "Firewall"); return l.find((i) => i.instanceId === "LAN-Checks")?.data?.targets?.length === 3 && f?.data?.interfaces?.some((i) => i.inBps > 0); }, 40000);

r = await api("POST", "/api/instances/LAN-Checks/actions/speedtest", {});
check("an operator can run a speed test from the API", r.status === 200, JSON.stringify(r.data).slice(0, 120));
await until(async () => ((await api("GET", "/api/speedtests?instance=LAN-Checks")).data ?? []).length >= 1, 30000);
const st = (await api("GET", "/api/speedtests?instance=LAN-Checks")).data;
check("the result is stored and listed", st.length >= 1 && st[0].downMbps > 0 && st[0].upMbps > 0, JSON.stringify(st[0]));
check("anyone can read the speed test history", (await fetch(`${base}/api/speedtests`)).status === 200);

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`${base}/#/instances`);
const expandAll = async () => { const closed = page.locator('button.card-title[aria-expanded="false"]'); while ((await closed.count()) > 0) await closed.first().click(); };
await page.waitForSelector("button.card-title");
await expandAll();
await page.waitForTimeout(2000);
if (process.env.DEBUG_UI) console.log("expanded:", await page.locator("button.card-title").evaluateAll((a) => a.map((x) => x.getAttribute("aria-expanded"))));
const txt1 = await page.locator("body").innerText();
check("the Network checks card lists each check with its state", /Gateway tcp/.test(txt1) && /Web/.test(txt1) && /Dead/.test(txt1) && /Connection refused/.test(txt1));
check("the summary counts are shown", /Checks up\s*2\/3/.test(txt1), (txt1.match(/Checks up[^\n]*\n?[^\n]*/) ?? [""])[0]);
let txt2 = "";
const snmpShown = await until(async () => { await expandAll(); txt2 = await page.locator("body").innerText(); return /igb0/.test(txt2) && /Mbit\/s/.test(txt2); }, 45000);
check("the SNMP card shows the interfaces with traffic", snmpShown, snmpShown ? "" : txt2.replace(/\s+/g, " ").slice(-700));
await page.getByRole("button", { name: "MB/s" }).first().click();
await page.waitForTimeout(600);
const inBytes = await page.locator("body").innerText();
check("switching to MB/s shows traffic in megabytes per second", /\d+(\.\d+)? MB\/s/.test(inBytes) && !/Mbit\/s/.test(inBytes.split("Interface")[1] ?? ""), (inBytes.match(/Traffic in[^\n]*\n[^\n]*/) ?? [""])[0]);
check("the unit is remembered in the browser", (await page.evaluate(() => localStorage.getItem("lumina:speedUnit"))) === "bytes");
await page.getByRole("button", { name: "Mbit/s" }).first().click();
await page.waitForTimeout(500);
check("and back to Mbit/s", /Mbit\/s/.test(await page.locator("body").innerText()));
check("anonymous viewers do not see the interface labels (WAN, LAN)", !/\bWAN\b/.test(txt2) && !/\bLAN\b(?!-)/.test(txt2.replace(/LAN-Checks/g, "")));
check("a watched link that is down is flagged", /igb1/.test(txt2) && /watched/.test(txt2), snmpShown ? "" : txt2.replace(/\s+/g, " ").slice(0, 200));
await page.screenshot({ path: process.env.SHOT ?? join(dir, "net.png"), fullPage: true });
// ---- the Network page
await page.getByRole("button", { name: "Network" }).first().click();
await page.waitForSelector("text=Internet speed");
await page.waitForTimeout(1500);
const nt = await page.locator("body").innerText();
check("the Network page shows the speed test with its result", /Internet speed/.test(nt) && /Download/.test(nt) && /(Mbit|MB)\/s/.test(nt) && /Run speed test now|Everything/.test(nt));
check("the speed chart and the results table are drawn", (await page.locator('svg[aria-label="Internet speed over time"]').count()) === 1 && (await page.locator("section:has(h2:has-text('Internet speed')) tbody tr").count()) >= 1);
check("latency and packet loss are listed per check", /Latency and packet loss/.test(nt) && /Gateway tcp/.test(nt) && /Dead/.test(nt));
check("the router links are listed too", /Links/.test(nt) && /igb0/.test(nt));
check("anonymous visitors cannot run tests or change settings here", (await page.getByRole("button", { name: "Run speed test now" }).count()) === 0 && (await page.getByRole("button", { name: "Speed test settings" }).count()) === 0);
await page.locator('.page-title button:has-text("MB/s")').click();
await page.waitForTimeout(500);
check("the unit switch on the page changes the speeds to MB/s", /MB\/s/.test(await page.locator("section:has(h2:has-text('Internet speed'))").innerText()));
await page.locator('.page-title button:has-text("Mbit/s")').click();

// ---- history chart of the SNMP card uses readable units (history is recorded once a minute, so wait for the first point)
check("the SNMP instance has recorded history", await until(async () => ((await api("GET", "/api/instances/Firewall/metric-keys")).data ?? []).includes("traffic:in") && ((await api("GET", "/api/instances/Firewall/metrics?keys=traffic:in&range=1h")).data?.series?.["traffic:in"] ?? []).length >= 2, 150000));
await page.goto(`${base}/#/instances`);
await page.waitForSelector("button.card-title");
await expandAll();
await page.waitForTimeout(800);
const snmpCard = page.locator("section, article, .card").filter({ has: page.locator("text=Firewall") }).last();
await page.locator('button:has-text("History")').last().click();
await page.waitForTimeout(800);
if (process.env.DEBUG_UI) console.log("chips:", await page.locator("button.chip").allInnerTexts(), "heads:", await page.locator("button.section-head").allInnerTexts());
await page.getByRole("button", { name: "Traffic in (all links)" }).click({ timeout: 8000 });
await page.waitForTimeout(1200);
const axis = await page.locator('svg[aria-label="History chart"] text.axis').evaluateAll((a) => a.map((x) => x.textContent ?? ""));
check("the traffic history chart shows speeds with units, not raw numbers", axis.some((t) => /(bit|kbit|Mbit|Gbit)\/s/.test(t)) && !axis.some((t) => /^-/.test(t.trim())), axis.join(" | "));
await page.locator('button:has-text("MB/s")').last().click();
await page.waitForTimeout(500);
const axis2 = await page.locator('svg[aria-label="History chart"] text.axis').evaluateAll((a) => a.map((x) => x.textContent ?? ""));
check("and it follows the MB/s switch", axis2.some((t) => /(B|kB|MB|GB)\/s/.test(t)), axis2.join(" | "));
await page.locator('button:has-text("Mbit/s")').last().click();
await page.getByRole("button", { name: "Alerts" }).first().click();
await page.waitForTimeout(1200);
check("alerts name the dead check and the down link", await until(async () => { await page.getByRole("button", { name: "Alerts" }).first().click(); const t = await page.locator("body").innerText(); return /Dead is not responding/.test(t) && /Link igb1 is down/.test(t); }, 40000));
await page.getByRole("button", { name: "Overview" }).first().click();
await page.waitForTimeout(1500);
const ov = await page.locator("body").innerText();
check("the Overview has a Network checks tile", /NETWORK CHECKS/i.test(ov) && /2\/3/.test(ov), (ov.match(/NETWORK CHECKS[^\n]*\n?[^\n]*/i) ?? [""])[0]);
for (const [w, h] of [[1920, 1080], [1366, 768]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`${base}/#/tv`); await page.waitForTimeout(2500);
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollHeight - innerHeight, kpis: document.querySelectorAll(".kpi").length }));
  check(`TV mode ${w}x${h} still fits on one screen with the extra tile`, m.scroll <= 1, JSON.stringify(m));
}
check("no browser errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
clearInterval(bump); child.kill(); tcp.close(); web.close();
process.exit(ok ? 0 : 1);
