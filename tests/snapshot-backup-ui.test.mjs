import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import https from "node:https";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(ROOT + "/")("playwright-core");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, x = "") => { results.push([n, ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(250); } return false; };

// ---------- fake Proxmox (HTTPS, records every write) ----------
const dir = mkdtempSync(join(tmpdir(), "lumina-snap-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=fakepve"], { stdio: "ignore" });
const writes = [];
const guests = [
  { type: "qemu", id: "qemu/101", vmid: 101, name: "web", node: "pve", status: "running", cpu: 0.02, mem: 1e9, maxmem: 2e9, maxdisk: 2e10, uptime: 5000, template: 0 },
  { type: "lxc", id: "lxc/102", vmid: 102, name: "db", node: "pve", status: "stopped", cpu: 0, mem: 0, maxmem: 1e9, maxdisk: 8e9, uptime: 0, template: 0 },
  { type: "qemu", id: "qemu/103", vmid: 103, name: "tmpl", node: "pve", status: "stopped", cpu: 0, mem: 0, maxmem: 1e9, maxdisk: 8e9, uptime: 0, template: 1 },
];
const storages = [
  { type: "storage", id: "storage/pve/backup-dir", storage: "backup-dir", node: "pve", plugintype: "dir", content: "backup,iso", status: "available", disk: 87e9, maxdisk: 100e9, shared: 0 },
  { type: "storage", id: "storage/pve/local-zfs", storage: "local-zfs", node: "pve", plugintype: "zfspool", content: "images,rootdir", status: "available", disk: 10e9, maxdisk: 100e9, shared: 0 },
];
const fake = https.createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (q, s) => {
  let body = ""; q.on("data", (c) => (body += c));
  q.on("end", () => {
    const send = (code, obj, msg) => { s.statusCode = code; if (msg) s.statusMessage = msg; s.setHeader("content-type", "application/json"); s.end(JSON.stringify(obj)); };
    if (!/^PVEAPIToken=.+=.+$/.test(q.headers.authorization ?? "")) return send(401, {});
    const p = q.url.replace("/api2/json", "");
    if (q.method === "GET") {
      if (p === "/nodes") return send(200, { data: [{ node: "pve", status: "online", cpu: 0.1, mem: 1e9, maxmem: 8e9, disk: 1e9, maxdisk: 1e10, uptime: 100 }] });
      if (p === "/cluster/resources") return send(200, { data: [...guests, ...storages] });
      return send(403, {}, "Forbidden");
    }
    const j = body ? JSON.parse(body) : {};
    writes.push({ method: q.method, path: p, body: j, ctype: q.headers["content-type"] });
    if (/snapshot$/.test(p) && j.snapname === "dup") return send(500, { errors: { snapname: "snapshot 'dup' already exists" } }, "snapshot 'dup' already exists");
    return send(200, { data: `UPID:pve:00001234:${p.split("/").pop()}` });
  });
}).listen(0, "127.0.0.1");
await new Promise((r) => fake.on("listening", r));
const fakeUrl = `https://127.0.0.1:${fake.address().port}`;

// ---------- Lumina under test ----------
const PORT = 3997, data = join(dir, "data");
const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: String(PORT), LUMINA_DATA: data, LUMINA_TLS: "off", LUMINA_UI_DIR: ROOT + "/packages/ui/dist", LOG_LEVEL: "warn" }, stdio: "ignore" });
const base = `http://127.0.0.1:${PORT}`;
await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 20000);
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
let r = await api("POST", "/api/instances", { j: admin, body: { moduleId: "proxmox", instanceId: "FakePVE", config: { host: fakeUrl, tokenId: "root@pam!t", tokenSecret: "secret-secret", verifyTls: false }, pollIntervalSec: 5 } });
check("fake Proxmox added", r.status === 201);
check("fake Proxmox polled with guests and storages", await until(async () => { const i = (await api("GET", "/api/instances", { j: anon })).data.find((x) => x.instanceId === "FakePVE"); return i?.data?.guests?.length === 3 && i.data.storage.length === 2; }));

// ---------- API behaviour ----------
const act = (j, a, body) => api("POST", `/api/instances/FakePVE/actions/${a}`, { j, body });
const T = { node: "pve", type: "qemu", vmid: 101 };
r = await act(anon, "snapshot", T);
check("anonymous cannot snapshot", r.status === 401);
r = await act(op, "snapshot", { ...T, name: "before-update", description: "pre upgrade" });
check("operator can snapshot, name echoed back", r.status === 200 && r.data.result.snapshot === "before-update" && /UPID/.test(r.data.result.task), JSON.stringify(r.data.result));
let w = writes.at(-1);
check("Proxmox got POST /nodes/pve/qemu/101/snapshot with JSON body {snapname, description}", w.method === "POST" && w.path === "/nodes/pve/qemu/101/snapshot" && w.body.snapname === "before-update" && w.body.description === "pre upgrade" && /json/.test(w.ctype), JSON.stringify(w));
r = await act(op, "snapshot", { ...T, type: "lxc", vmid: 102 });
w = writes.at(-1);
check("blank name gets an automatic lumina-… name (containers use /lxc/)", /^lumina-\d{8}-\d{6}$/.test(r.data.result.snapshot) && w.path === "/nodes/pve/lxc/102/snapshot", r.data.result?.snapshot);
r = await act(op, "snapshot", { ...T, name: "1bad name!" });
check("invalid snapshot name rejected before reaching Proxmox", r.status === 400 && writes.length === 2);
r = await act(op, "snapshot", { ...T, name: "dup" });
check("Proxmox's own error text is shown to the user", r.status >= 400 && /already exists/.test(JSON.stringify(r.data)), JSON.stringify(r.data).slice(0, 140));
r = await act(op, "backup", { ...T, storage: "backup-dir" });
w = writes.at(-1);
check("backup posts to /nodes/pve/vzdump with vmid, storage, mode snapshot, zstd", r.status === 200 && w.path === "/nodes/pve/vzdump" && w.body.vmid === "101" && w.body.storage === "backup-dir" && w.body.mode === "snapshot" && w.body.compress === "zstd", JSON.stringify(w.body));
r = await act(op, "backup", { ...T, storage: "../etc" });
check("path-like storage name is rejected", r.status === 400);
r = await act(op, "backup", { ...T, storage: "backup-dir", mode: "nuke" });
check("unknown backup mode is rejected", r.status === 400);
r = await api("GET", "/api/audit", { j: admin });
check("audit log records both actions with who did it", r.data.filter((e) => /action/.test(e.action) && /snapshot|backup/.test(e.target)).length >= 3 && r.data.some((e) => e.user === "helper"));

// ---------- real browser ----------
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const open = async (jarObj) => {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  if (jarObj?.cookie) await ctx.addCookies([{ name: "lumina_session", value: jarObj.cookie.split("=")[1], url: base }]);
  const page = await ctx.newPage();
  await page.goto(`${base}/#/instances`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.locator(".card-title", { hasText: "FakePVE" }).click();
  await page.waitForTimeout(800);
  return { ctx, page };
};

let { ctx, page } = await open(null);
check("anonymous visitors see no Snapshot/Backup buttons", (await page.getByRole("button", { name: "Snapshot", exact: true }).count()) === 0 && (await page.getByRole("button", { name: "Backup", exact: true }).count()) === 0);
await ctx.close();

({ ctx, page } = await open(op));
const rowOf = (name) => page.locator("tr", { hasText: name }).first();
check("operator sees both buttons on a VM row", (await rowOf("web").getByRole("button", { name: "Snapshot" }).count()) === 1 && (await rowOf("web").getByRole("button", { name: "Backup" }).count()) === 1);
check("template rows have no Snapshot/Backup buttons", (await rowOf("tmpl").getByRole("button", { name: "Snapshot" }).count()) === 0);

const before = writes.length;
await rowOf("web").getByRole("button", { name: "Snapshot" }).click();
await page.locator(".dialog input").first().fill("ui-test");
await page.getByRole("button", { name: "Take snapshot" }).click();
await page.waitForSelector(".toast");
const toast1 = await page.locator(".toast").innerText();
check("UI snapshot sends the request and shows a confirmation", writes.length === before + 1 && writes.at(-1).body.snapname === "ui-test" && /ui-test/.test(toast1), toast1);

await rowOf("web").getByRole("button", { name: "Backup" }).click();
const options = await page.locator(".dialog select option").allInnerTexts();
check("backup dialog lists only backup-capable storage with usage and free space", options.length === 3 || (options.length >= 1 && options[0].includes("backup-dir") && /87% used/.test(options[0]) && /12 GB free/.test(options[0]) && !options.some((o) => o.includes("local-zfs"))), options.join(" | "));
await page.locator(".dialog select").nth(1).selectOption("stop");
const warn = await page.locator(".dialog .error").innerText().catch(() => "");
check("choosing a disruptive mode warns that the guest will be interrupted", /interrupt/i.test(warn), warn);
await page.locator(".dialog select").nth(1).selectOption("snapshot");
const before2 = writes.length;
await page.getByRole("button", { name: "Start backup" }).click();
await page.waitForSelector(".toast");
check("UI backup sends the request to the chosen storage", writes.length === before2 + 1 && writes.at(-1).path.endsWith("/vzdump") && writes.at(-1).body.storage === "backup-dir", JSON.stringify(writes.at(-1)?.body));

await rowOf("web").getByRole("button", { name: "Snapshot" }).click();
await page.locator(".dialog input").first().fill("dup");
await page.getByRole("button", { name: "Take snapshot" }).click();
await page.waitForTimeout(1200);
const errText = await page.locator(".dialog .error").innerText().catch(() => "");
check("a Proxmox error stays visible in the dialog instead of vanishing", /already exists/.test(errText), errText.slice(0, 120));
await ctx.close();

await browser.close(); child.kill("SIGTERM"); fake.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log("FAILED:", failed.map(([n]) => n).join(" | "));
process.exit(failed.length ? 1 : 0);
