// Two Proxmox hosts (both with a VM 101) and two iLOs: the Overview shows each of them, the Instances page can be filtered, and the TV wall still fits.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import https from "node:https";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(ROOT + "/")("playwright-core");

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 40000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(400); } return false; };

const dir = mkdtempSync(join(tmpdir(), "lumina-multi-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=fake"], { stdio: "ignore" });
const tls = { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) };

// a Proxmox node: both have a VM 101
const pveFake = (node, cpu, running101) => {
  const state = { running101 };
  const guests = () => [
    { type: "qemu", id: "qemu/101", vmid: 101, name: `web-${node}`, node, status: state.running101 ? "running" : "stopped", cpu: 0.02, mem: 1e9, maxmem: 2e9, maxdisk: 2e10, uptime: 5000, template: 0 },
    { type: "lxc", id: "lxc/102", vmid: 102, name: `db-${node}`, node, status: "running", cpu: 0, mem: 1e8, maxmem: 1e9, maxdisk: 8e9, uptime: 5000, template: 0 },
  ];
  const storages = [{ type: "storage", id: `storage/${node}/local-zfs`, storage: "local-zfs", node, plugintype: "zfspool", content: "images", status: "available", disk: 40e9, maxdisk: 100e9, shared: 0 }];
  const server = https.createServer(tls, (q, s) => {
    q.resume();
    q.on("end", () => {
      const send = (code, obj) => { s.statusCode = code; s.setHeader("content-type", "application/json"); s.end(JSON.stringify(obj)); };
      const p = q.url.replace("/api2/json", "");
      if (p === "/nodes") return send(200, { data: [{ node, status: "online", cpu, mem: 2e9, maxmem: 8e9, disk: 1e9, maxdisk: 1e10, uptime: 100 }] });
      if (p === "/cluster/resources") return send(200, { data: [...guests(), ...storages] });
      if (p === "/cluster/backup") return send(200, { data: [] });
      send(404, {});
    });
  }).listen(0, "127.0.0.1");
  return { server, state, port: () => server.address().port };
};
const pveA = pveFake("pve-a", 0.1, true);
const pveB = pveFake("pve-b", 0.82, true);

const iloFake = (watts, health) => http.createServer((q, s) => {
  q.resume();
  q.on("end", () => {
    const j = { "/redfish/v1/Chassis/1/Power/": { PowerControl: [{ PowerConsumedWatts: watts }], PowerSupplies: [] }, "/redfish/v1/Chassis/1/Thermal/": { Temperatures: [{ Name: "01-Inlet Ambient", ReadingCelsius: 24, Status: { Health: "OK" }, UpperThresholdCritical: 42 }], Fans: [] }, "/redfish/v1/Systems/1/": { Model: "ProLiant", PowerState: "On", Status: { Health: health }, Oem: { Hp: {} } } }[q.url];
    s.statusCode = j ? 200 : 404; s.end(JSON.stringify(j ?? {}));
  });
}).listen(0, "127.0.0.1");
const iloA = iloFake(210, "OK");
const iloB = iloFake(180, "OK");

const PORT = 3986;
const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: String(PORT), LUMINA_DATA: dir, LUMINA_TLS: "off", LUMINA_UI_DIR: ROOT + "/packages/ui/dist", LOG_LEVEL: "error" }, stdio: "ignore" });
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
const px = (id, f) => api("POST", "/api/instances", { moduleId: "proxmox", instanceId: id, config: { host: `https://127.0.0.1:${f.port()}`, tokenId: "root@pam!t", tokenSecret: "secret-secret", verifyTls: false }, pollIntervalSec: 5 });
const il = (id, s) => api("POST", "/api/instances", { moduleId: "ilo4", instanceId: id, config: { host: `http://127.0.0.1:${s.address().port}`, username: "a", password: "b" }, pollIntervalSec: 10 });
await px("Host A", pveA); await px("Host B", pveB); await il("Rack iLO 1", iloA); await il("Rack iLO 2", iloB);
await api("POST", "/api/instances", { moduleId: "netcheck", instanceId: "Checks", config: { targets: "Local | tcp | 127.0.0.1:1" } });
const ready = await until(async () => { const l = (await api("GET", "/api/instances")).data ?? []; return ["Host A", "Host B"].every((n) => l.find((i) => i.instanceId === n)?.data?.guests?.length === 2) && ["Rack iLO 1", "Rack iLO 2"].every((n) => l.find((i) => i.instanceId === n)?.data); });
check("two Proxmox hosts and two iLOs are connected", ready);
// VM 101 on host B stops on its own: only that one may be shown as a crash
pveB.state.running101 = false;
await until(async () => ((await api("GET", "/api/alerts")).data?.active ?? (await api("GET", "/api/alerts")).data ?? []).some?.((a) => a.instanceId === "Host B" && a.key === "guest-stopped:101"), 30000);

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const errors = [];
const open = async (hash, w = 1500, h = 900, cookie = true) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  if (cookie) await ctx.addCookies([{ name: "lumina_session", value: jar.cookie.split("=")[1], url: base }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${base}/#/${hash}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  return { ctx, page };
};

// ---- Overview ----
let { ctx, page } = await open("overview");
let txt = await page.locator("body").innerText();
check("the power tile adds the servers up and says how many there are", /Server power · 2 servers/i.test(txt) && /\b390\s*W/.test(txt), (txt.match(/Server power[^\n]*\n[^\n]*/) ?? [""])[0]);
check("the load tile names the busiest host", /Host load · 2 nodes/i.test(txt) && /busiest pve-b 82%/.test(txt));
check("a Hosts panel lists every node with its CPU, RAM and guests", /Hosts/.test(txt) && /pve-a/.test(txt) && /pve-b/.test(txt) && (await page.locator(".hrow").count()) === 2);
check("a Servers panel lists every iLO", /Servers/.test(txt) && /Rack iLO 1/.test(txt) && /Rack iLO 2/.test(txt));
const chips = await page.locator(".gchip").evaluateAll((a) => a.map((x) => ({ t: x.innerText, bad: x.classList.contains("bad") })));
const stoppedChip = chips.filter((c) => /VM 101/.test(c.t));
check("a stopped guest says which host it is on", stoppedChip.some((c) => /pve-b/.test(c.t)), JSON.stringify(stoppedChip));
check("only the host that really lost the VM shows a crash, not the other one with the same VM number", stoppedChip.filter((c) => c.bad).length === stoppedChip.length && stoppedChip.every((c) => /pve-b/.test(c.t)));
check("storage rows name their host when there are several", /local-zfs · pve-a/.test(txt) && /local-zfs · pve-b/.test(txt));
await ctx.close();

// ---- wall display fits ----
for (const [w, h] of [[1920, 1080], [1366, 768]]) {
  ({ ctx, page } = await open("tv", w, h));
  const measure = () => page.evaluate(() => ({ over: [...document.querySelectorAll(".pbody")].filter((p) => p.scrollHeight > p.clientHeight + 1).length, overWho: [...document.querySelectorAll(".pbody")].filter((p) => p.scrollHeight > p.clientHeight + 1).map((p) => p.parentElement.querySelector("h3")?.innerText + ":" + p.scrollHeight + ">" + p.clientHeight), font: document.querySelector(".tv").style.fontSize, scroll: document.documentElement.scrollHeight - innerHeight, kpis: document.querySelectorAll(".kpi").length }));
  let m = await measure();
  for (let i = 0; i < 8 && m.over > 0; i++) { await page.waitForTimeout(2000); m = await measure(); }
  check(`TV mode ${w}x${h} still fits with two hosts and two servers`, m.over === 0 && m.scroll <= 1, JSON.stringify(m));
  await ctx.close();
}

// ---- Instances: find things ----
({ ctx, page } = await open("instances"));
check("a filter bar appears once there are four or more instances", (await page.locator(".filterbar").count()) === 1);
const cards = () => page.locator("section.inst").count();
check("all five cards are listed", (await cards()) === 5);
await page.getByRole("button", { name: /^Proxmox VE \d/ }).click();
check("choosing a kind keeps only that kind", (await cards()) === 2, String(await cards()));
await page.getByRole("button", { name: /^Show everything/ }).click();
await page.getByPlaceholder("Find an instance…").fill("iLO 2");
check("the search narrows by name", (await cards()) === 1 && /Rack iLO 2/.test(await page.locator("section.inst").first().innerText()));
await page.getByRole("button", { name: /^Show everything/ }).click();
await page.getByRole("button", { name: "Expand all" }).click();
await page.waitForTimeout(500);
check("Expand all opens every card", (await page.locator('button.card-title[aria-expanded="true"]').count()) === 5);
await page.getByRole("button", { name: "Collapse all" }).click();
await page.waitForTimeout(300);
check("Collapse all closes every card", (await page.locator('button.card-title[aria-expanded="true"]').count()) === 0);
await page.getByRole("button", { name: /^Needs attention/ }).click();
check("Needs attention keeps the ones with a problem", (await cards()) >= 1 && (await cards()) < 5, String(await cards()));
await ctx.close();

// ---- Add: a free name is suggested ----
({ ctx, page } = await open("instances"));
await page.getByRole("button", { name: "+ Add module" }).click();
await page.waitForSelector("form.add");
const sel = page.locator("form.add select").first();
const opts = await sel.locator("option").allInnerTexts();
await sel.selectOption({ label: opts.find((o) => /Proxmox/.test(o)) });
const suggested = await page.locator('form.add input[required]').first().inputValue();
check("adding a second Proxmox suggests a free name", /^Proxmox/.test(suggested) && !["Host A", "Host B"].includes(suggested), suggested);
await ctx.close();

check("no browser errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
child.kill(); pveA.server.close(); pveB.server.close(); iloA.close(); iloB.close();
process.exit(ok ? 0 : 1);
