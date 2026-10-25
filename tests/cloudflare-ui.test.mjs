// The Cloudflare card in a real browser: hostnames, traffic, DNS records (admin form), dynamic DNS, Access logins, and what anonymous viewers see.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { startFakeCloudflare } from "./helpers/cloudflare-fake.mjs";
const { chromium } = createRequire(ROOT + "/")("playwright-core");

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(400); } return false; };

const dir = mkdtempSync(join(tmpdir(), "lumina-cfui-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/k.pem`, "-out", `${dir}/c.pem`, "-days", "9", "-subj", "/CN=localhost"], { stdio: "ignore" });
const web = createServer({ key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) }, (_q, r) => { r.writeHead(200); r.end(); });
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const fake = await startFakeCloudflare();

const PORT = 3987;
const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: String(PORT), LUMINA_DATA: dir, LUMINA_TLS: "off", LUMINA_UI_DIR: ROOT + "/packages/ui/dist", LOG_LEVEL: "error", LUMINA_CLOUDFLARE_API: fake.base, LUMINA_CLOUDFLARE_CHECK_PORT: String(web.address().port) }, stdio: "ignore" });
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
const r = await api("POST", "/api/instances", { moduleId: "cloudflare", instanceId: "Cloudflare", config: { apiToken: "good-token", accountId: "acc", zoneId: "zone", extraHostnames: "localhost", dynamicDns: "home.example.test" } });
check("a Cloudflare instance with the new settings is added", r.status === 201, JSON.stringify(r.data).slice(0, 150));
await until(async () => { const i = (await api("GET", "/api/instances")).data?.find((x) => x.moduleId === "cloudflare"); return i?.data?.hostnames?.length && !i.data.hostnames.some((h) => h.pending); }, 20000);

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const errors = [];
const open = async (cookie) => {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  if (cookie) await ctx.addCookies([{ name: "lumina_session", value: cookie.split("=")[1], url: base }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${base}/#/instances`);
  await page.waitForSelector("button.card-title");
  const closed = page.locator('button.card-title[aria-expanded="false"]');
  while ((await closed.count()) > 0) await closed.first().click();
  await page.waitForTimeout(1500);
  return { ctx, page };
};

// ---- anonymous viewer ----
let { ctx, page } = await open(null);
let txt = await page.locator("body").innerText();
check("anyone sees the hostnames, traffic and Access count", /Public hostnames/.test(txt) && /localhost/.test(txt) && /HTTP 200/.test(txt) && /Traffic, last 3 days/.test(txt) && /11 refused in the last hour/.test(txt), txt.slice(0, 100));
check("the certificate's days left are shown", /\b(8|9) days\b/.test(txt));
check("an anonymous viewer sees no record contents, e-mails or IPs and no admin forms", !/203\.0\.113\.9/.test(txt) && !/bad\.test/.test(txt) && !/198\.51\.100\.99/.test(txt) && (await page.locator('input[placeholder="name.example.com"]').count()) === 0);
await ctx.close();

// ---- admin ----
({ ctx, page } = await open(jar.cookie));
txt = await page.locator("body").innerText();
check("an admin sees the DNS records with their contents and the dynamic DNS state", /DNS records/.test(txt) && /198\.51\.100\.99/.test(txt) && /Dynamic DNS/.test(txt) && /public IP 198\.51\.100\.99/.test(txt) && /me@example\.test/.test(txt));
await page.locator('input[placeholder="name.example.com"]').fill("ui.example.test");
await page.locator('input[placeholder="203.0.113.10"]').fill("203.0.113.77");
await page.getByRole("button", { name: "Add record" }).click();
check("a DNS record can be added from the card", await until(async () => fake.state.records.some((r) => r.name === "ui.example.test" && r.content === "203.0.113.77"), 8000));
check("the new record appears in the table", await until(async () => /ui\.example\.test/.test(await page.locator("body").innerText()), 70000));
const before = fake.state.records.find((r) => r.name === "blog.example.test").proxied;
await page.locator("tr", { hasText: "blog.example.test" }).getByRole("button", { name: /Proxy/ }).first().click();
check("the proxy switch changes the record", await until(async () => fake.state.records.find((r) => r.name === "blog.example.test").proxied === !before, 8000));
const scroll = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
check("the card does not spill sideways", scroll <= 1, String(scroll));
await ctx.close();
check("no browser errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
child.kill(); web.close(); fake.close();
process.exit(ok ? 0 : 1);
