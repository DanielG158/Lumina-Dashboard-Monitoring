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
// a second, separate device for the SNMPv3 test (a probe of a fake agent can upset it, and the first one must stay clean)
const agent2 = snmp.createAgent({ port: SPORT + 1, address: "127.0.0.1" }, () => undefined);
agent2.getAuthorizer().addUser({ name: "eap", level: snmp.SecurityLevel.authNoPriv, authProtocol: snmp.AuthProtocols.md5, authKey: "authpass1234" });
const mib2 = agent2.getMib();
mib2.registerProvider({ name: "sysName", type: snmp.MibProviderType.Scalar, oid: "1.3.6.1.2.1.1.5", scalarType: snmp.ObjectType.OctetString, maxAccess: snmp.MaxAccess["read-only"] });
mib2.setScalarValue("sysName", "EAP670");
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
const { startFakeOmada } = await import("./helpers/omada-fake.mjs");
const omada = await startFakeOmada();
const { startFakeRouter } = await import("./helpers/tplink-fake.mjs");
const router = await startFakeRouter({ mode: "aes" });
r = await api("POST", "/api/instances", { moduleId: "omada", instanceId: "Wi-Fi", config: { url: omada.url, username: "viewer", password: "secret" }, pollIntervalSec: 10 });
check("a TP-Link Omada controller is added", r.status === 201, JSON.stringify(r.data));
r = await api("POST", "/api/instances", { moduleId: "snmp", instanceId: "EAP670", config: { host: "127.0.0.1", port: SPORT + 1, version: "3", user: "eap", authProtocol: "sha", authKey: "authpass1234", privProtocol: "aes", privKey: "privpass1234" }, pollIntervalSec: 30 });
check("an SNMPv3 instance with the wrong settings is added", r.status === 201, JSON.stringify(r.data));
r = await api("POST", "/api/instances", { moduleId: "tplink-router", instanceId: "AX12", config: { url: router.url, username: "admin", password: router.password }, pollIntervalSec: 30 });
check("a TP-Link Archer router is added", r.status === 201, JSON.stringify(r.data));
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
let wifi = "";
const wifiShown = await until(async () => { await expandAll(); wifi = await page.locator("body").innerText(); return /Living room AP/.test(wifi) && /Garage AP/.test(wifi); }, 40000);
check("the Omada card lists the router, switch and access points", wifiShown && /ER605/.test(wifi) && /SG2008P/.test(wifi) && /Access point/.test(wifi) && /Router/.test(wifi), wifiShown ? "" : wifi.replace(/\s+/g, " ").slice(-500));
check("it shows the offline access point, the update and the Wi-Fi client count", /Garage AP[^\n]*offline/i.test(wifi) && /update/i.test(wifi) && /Wi-Fi clients\s*17/.test(wifi.replace(/\n/g, " ").replace(/\s+/g, " ")) || /17/.test(wifi));
const ax = (await page.locator("#inst-AX12").innerText()).replace(/\s+/g, " ");
check("the Archer router card shows the internet, clients, load and model", /Connected/.test(ax) && /Clients 4/.test(ax) && /2 Wi-Fi · 1 wired · 1 guest/.test(ax) && /CPU 12/.test(ax) && /Archer AX12/.test(ax), ax.slice(0, 260));
check("anonymous viewers do not see the router's addresses or its clients", !/203\.0\.113\.9/.test(ax) && !/phone|laptop|nas/.test(ax) && !/AA:BB/.test(ax));
check("anonymous viewers do not see device addresses", !/192\.168\.0\.2\d/.test(wifi));
check("anonymous viewers do not see device addresses (alerts)", !/192\.168\.0\.22/.test(wifi));
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

// ---- editing the checks as a form (admin)
{
  const actx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
  await actx.addCookies([{ name: "lumina_session", value: jar.cookie.split("=")[1], url: base }]);
  const ap = await actx.newPage();
  const aerrors = []; ap.on("pageerror", (e) => aerrors.push(e.message));
  await ap.goto(`${base}/#/network`);
  await ap.getByRole("button", { name: "Edit checks" }).click();
  await ap.waitForSelector('input[aria-label="Check name"]');
  await ap.waitForTimeout(800);
  const names = () => ap.locator('input[aria-label="Check name"]').evaluateAll((a) => a.map((x) => x.value));
  check("the checks appear as a form with one row each, not a block of text", JSON.stringify(await names()) === JSON.stringify(["Gateway tcp", "Web", "Dead"]) && (await ap.locator("textarea").count()) === 0, JSON.stringify(await names()));
  if (process.env.SHOT2) await ap.screenshot({ path: process.env.SHOT2, fullPage: true });
  check("each row shows whether it answers right now", (await ap.locator(".subpanel .dot.connected").count()) === 2 && (await ap.locator(".subpanel .dot.disconnected").count()) === 1);
  const lastRow = () => ap.locator(".subpanel").last();
  await ap.getByRole("button", { name: "+ Add a check" }).click();
  await lastRow().locator('input[aria-label="Check name"]').fill("Extra port");
  await lastRow().locator('select[aria-label="Check type"]').selectOption("tcp");
  await lastRow().locator('input[aria-label="Address"]').fill("127.0.0.1");
  await lastRow().locator('input[aria-label="Port"]').fill("12ab");
  check("a TCP check gets a port box that only takes digits", (await lastRow().locator('input[aria-label="Port"]').inputValue()) === "12");
  await lastRow().locator('input[aria-label="Port"]').fill(String(tcp.address().port));
  check("a valid new check enables Save", await ap.getByRole("button", { name: "Save checks" }).isEnabled());
  await ap.getByRole("button", { name: "+ Add a check" }).click();
  await lastRow().locator('input[aria-label="Check name"]').fill("Broken");
  await lastRow().locator('input[aria-label="Address"]').fill("not a host!");
  await ap.waitForTimeout(300);
  check("a bad address is flagged and blocks Save", /not a host name or IP address/.test(await ap.locator("body").innerText()) && !(await ap.getByRole("button", { name: "Save checks" }).isEnabled()));
  await ap.getByRole("button", { name: "Remove this check" }).last().click();
  await ap.waitForTimeout(300);
  check("removing the bad row clears the error", await ap.getByRole("button", { name: "Save checks" }).isEnabled());
  await ap.locator('select[aria-label="Add a common check"]').selectOption({ label: "Internet (Cloudflare 1.1.1.1)" });
  await ap.waitForTimeout(300);
  check("a common check can be added with one click", (await names()).includes("Internet"));
  await ap.getByRole("button", { name: "Save checks" }).click();
  await until(async () => /Extra port \| tcp \| 127\.0\.0\.1:\d+/.test(JSON.stringify((await api("GET", "/api/instances/LAN-Checks/config")).data)), 15000);
  const saved = (await api("GET", "/api/instances/LAN-Checks/config")).data.config.targets;
  check("saving stores the checks in the same one-line-per-check format", /Extra port \| tcp \| 127\.0\.0\.1:\d+/.test(saved) && /Internet \| ping \| 1\.1\.1\.1/.test(saved) && /Gateway tcp \| tcp \| 127\.0\.0\.1:\d+/.test(saved), saved.replace(/\n/g, " ; "));
  check("the new checks start running", await until(async () => ((await api("GET", "/api/instances")).data.find((i) => i.instanceId === "LAN-Checks")?.data?.targets ?? []).some((t) => t.name === "Extra port" && t.ok), 40000));
  // the Add dialog uses the same form
  await ap.goto(`${base}/#/instances`);
  await ap.getByRole("button", { name: "+ Add module" }).click();
  await ap.locator("select").first().selectOption({ label: "Network checks" });
  await ap.waitForTimeout(500);
  check("adding a Network checks instance shows the form too", (await ap.locator('input[aria-label="Check name"]').count()) >= 1 && (await ap.locator(".add textarea").count()) === 0);
  await ap.keyboard.press("Escape");
  await ap.waitForTimeout(300);
  // the SNMP settings test, on an instance that cannot connect
  await ap.goto(`${base}/#/instances`);
  await ap.waitForSelector("button.card-title");
  { const closed = ap.locator('button.card-title[aria-expanded="false"]'); while ((await closed.count()) > 0) await closed.first().click(); }
  await ap.waitForTimeout(1200);
  if (process.env.DEBUG_UI) console.log("EAP card:", (await ap.locator("#inst-EAP670").innerText()).replace(/\s+/g, " ").slice(0, 1200), "| open:", await ap.locator("#inst-EAP670 button.card-title").getAttribute("aria-expanded"));
  const eapBtn = ap.locator("#inst-EAP670").getByRole("button", { name: "Test the SNMP settings" });
  await eapBtn.waitFor({ timeout: 20000 }).catch(() => undefined);
  check("an SNMP instance that cannot connect offers a settings test to admins", (await eapBtn.count()) === 1, (await ap.locator("#inst-EAP670").innerText().catch(() => "no card")).replace(/\s+/g, " ").slice(0, 200));
  await eapBtn.click();
  const found = await until(async () => /Set the instance to exactly that/.test(await ap.locator("#inst-EAP670").innerText()), 60000);
  const eapText = (await ap.locator("#inst-EAP670").innerText()).replace(/\s+/g, " ");
  check("the test shows each combination and names the one that works", found && /authentication md5, no encryption/.test(eapText) && /answered/.test(eapText), eapText.slice(0, 400));
  check("anonymous viewers do not get the test button", (await page.locator("#inst-EAP670").getByRole("button", { name: "Test the SNMP settings" }).count()) === 0);

  // editing happens in a popup over the page, and the name can be changed
  await ap.setViewportSize({ width: 1400, height: 520 });
  await ap.goto(`${base}/#/instances`);
  await ap.waitForSelector("button.card-title");
  for (const b of await ap.locator('button.card-title[aria-expanded="false"]').all()) await b.click().catch(() => undefined);
  await ap.waitForTimeout(3000); // let every card finish loading its charts, so the page height is stable
  await ap.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await ap.waitForTimeout(600);
  const y0 = await ap.evaluate(() => window.scrollY);
  const h0 = await ap.evaluate(() => document.documentElement.scrollHeight);
  const editBtns = ap.getByRole("button", { name: "Edit", exact: true });
  // (a DOM click, so the test does not scroll the button into view itself)
  await editBtns.last().evaluate((el) => el.click());
  await ap.waitForSelector(".overlay .modal-sheet");
  await ap.waitForTimeout(500);
  const y1 = await ap.evaluate(() => window.scrollY);
  const h1 = await ap.evaluate(() => document.documentElement.scrollHeight);
  check("opening Edit does not throw the page back to the top", y0 > 100 && Math.abs(y1 - y0) <= 30, `${y0} -> ${y1} (page height ${h0} -> ${h1})`);
  check("the edit form is a popup over the page", (await ap.locator(".overlay .modal-sheet input").count()) > 3);
  const nameBox = ap.locator('.modal-sheet label:has-text("Instance name") input');
  check("the instance name can be edited", (await nameBox.isEditable()) === true);
  await ap.keyboard.press("Escape");
  await ap.waitForTimeout(300);
  check("Escape closes the popup and the page stays where it was", (await ap.locator(".overlay .modal-sheet").count()) === 0 && Math.abs((await ap.evaluate(() => window.scrollY)) - y0) <= 2);
  await ap.locator("#inst-Wi-Fi").getByRole("button", { name: "Edit", exact: true }).evaluate((el) => el.click());
  await ap.waitForSelector(".overlay .modal-sheet");
  await ap.locator('.modal-sheet label:has-text("Instance name") input').fill("Edge Wi-Fi");
  await ap.locator(".modal-sheet").getByRole("button", { name: /^(Save|Update|Save changes)/ }).first().click();
  check("renaming from the popup moves the instance to the new name", await until(async () => (await api("GET", "/api/instances")).data.some((i) => i.instanceId === "Edge Wi-Fi") && !(await api("GET", "/api/instances")).data.some((i) => i.instanceId === "Wi-Fi"), 20000));
  await api("PUT", "/api/instances/Edge%20Wi-Fi/name", { name: "Wi-Fi" }); // put it back for the rest of the test
  check("no browser errors in the admin pages", aerrors.length === 0, aerrors.join(" | "));
  await actx.close();
}

// ---- history chart of the SNMP card uses readable units (history is recorded once a minute, so wait for the first point)
check("the SNMP instance has recorded history", await until(async () => ((await api("GET", "/api/instances/Firewall/metric-keys")).data ?? []).includes("traffic:in") && ((await api("GET", "/api/instances/Firewall/metrics?keys=traffic:in&range=1h")).data?.series?.["traffic:in"] ?? []).length >= 2, 150000));
await page.goto(`${base}/#/instances`);
await page.waitForSelector("button.card-title");
await expandAll();
await page.waitForTimeout(800);
const snmpCard = page.locator("section, article, .card").filter({ has: page.locator("text=Firewall") }).last();
await page.locator("xpath=//button[contains(@class,'card-title')][contains(.,'Firewall')]/ancestor::*[.//button[contains(@class,'section-head')]][1]//button[contains(@class,'section-head')][contains(.,'History')]").first().click();
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
check("the Overview has a Wi-Fi and network tile with the online count", /WI-FI AND NETWORK/i.test(ov) && /4\/6/.test((ov.match(/WI-FI AND NETWORK[^\n]*\n[^\n]*/i) ?? [""])[0]), (ov.match(/WI-FI AND NETWORK[^\n]*\n?[^\n]*/i) ?? [""])[0]);
check("the Overview has a Network checks tile", /NETWORK CHECKS/i.test(ov) && /\d+\/\d+/.test((ov.match(/NETWORK CHECKS[^\n]*\n[^\n]*/i) ?? [""])[0]), (ov.match(/NETWORK CHECKS[^\n]*\n?[^\n]*/i) ?? [""])[0]);
for (const [w, h] of [[1920, 1080], [1366, 768]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`${base}/#/tv`); await page.waitForTimeout(2500);
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollHeight - innerHeight, kpis: document.querySelectorAll(".kpi").length }));
  check(`TV mode ${w}x${h} still fits on one screen with the extra tile`, m.scroll <= 1, JSON.stringify(m));
}
check("no browser errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
clearInterval(bump); child.kill(); tcp.close(); web.close();
omada.close(); router.close();
process.exit(ok ? 0 : 1);
