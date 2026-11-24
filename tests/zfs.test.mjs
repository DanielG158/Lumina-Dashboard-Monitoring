// ZFS pools on a Proxmox host: healthy, degraded with a resilver running, faulted, and disks with errors.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mod = (await import(ROOT + "/packages/modules/proxmox/dist/index.js")).default;
const { parseZfsPool, zfsActivity, zfsAlerts, zfsDeviceName } = await import(ROOT + "/packages/modules/proxmox/dist/index.js");
const { redactState } = await import(ROOT + "/packages/core/dist/redact.js");
let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };

// shapes as a real Proxmox returns them
const leaf = (name, state = "ONLINE", e = {}) => ({ leaf: 1, name: `/dev/disk/by-id/${name}-part1`, state, read: 0, write: 0, cksum: 0, msg: "", ...e });
const healthyEntry = { name: "tank", health: "ONLINE", size: 2087354105856, alloc: 1028736036864, free: 1058618068992, frag: 38, dedup: 1 };
const healthyDetail = { name: "tank", state: "ONLINE", errors: "No known data errors", scan: "scrub repaired 0B in 03:40:34 with 0 errors on Sun Nov  8 04:04:35 2026", leaf: 0,
  children: [{ name: "tank", state: "ONLINE", leaf: 0, read: 0, write: 0, cksum: 0, msg: "", children: [{ name: "mirror-0", state: "ONLINE", leaf: 0, read: 0, write: 0, cksum: 0, msg: "", children: [leaf("scsi-350000399c8081f51"), leaf("scsi-3500003999879d15d")] }] }, { name: "cache", leaf: 0, msg: "", children: [leaf("ata-WDC_WDS120G2G0A_193032801857")] }] };
const resilverScan = "resilver in progress since Sun Nov 15 10:00:00 2026\n\t1.20T scanned at 310M/s, 512G issued at 120M/s, 1.87T total\n\t128G resilvered, 27.35% done, 03:21:10 to go";
const degradedDetail = { name: "tank", state: "DEGRADED", errors: "No known data errors", scan: resilverScan, status: "One or more devices is currently being resilvered.  The pool will continue to function, possibly in a degraded state.", action: "Wait for the resilver to complete.",
  children: [{ name: "tank", state: "DEGRADED", leaf: 0, children: [{ name: "mirror-0", state: "DEGRADED", leaf: 0, children: [leaf("scsi-350000399c8081f51"), { name: "replacing-1", state: "DEGRADED", leaf: 0, children: [leaf("scsi-OLDDISK", "FAULTED", { read: 12, write: 3, msg: "too many errors" }), leaf("scsi-NEWDISK")] }] }] }] };

check("a disk's long path is shortened to its id", zfsDeviceName("/dev/disk/by-id/ata-WDC_WDS120G2G0A-00JH30_193032801857-part1") === "ata-WDC_WDS120G2G0A-00JH30_193032801857" && zfsDeviceName("/dev/sdb1") === "sdb1");
check("a finished scrub is not an activity", zfsActivity(healthyDetail.scan) === null);
const act = zfsActivity(resilverScan);
check("a running resilver gives its percentage and time left", act.kind === "resilver" && act.percent === 27.35 && act.eta === "03:21:10", JSON.stringify(act));
check("a running scrub too, and 'no estimated completion time' is not shown as a time", zfsActivity("scrub in progress since x\n\t10G scanned, 0.50% done, no estimated completion time").eta === null && zfsActivity("scrub in progress since x\n 1% done").kind === "scrub");

const h = parseZfsPool("pve", healthyEntry, healthyDetail);
check("a healthy pool: size, use, layout and no problems", h.health === "ONLINE" && h.size === 2087354105856 && h.frag === 38 && h.problems.length === 0 && h.devices.filter((d) => d.kind === "disk").length === 3 && h.devices.some((d) => d.name === "mirror-0" && d.kind === "group") && h.devices.some((d) => d.name === "cache" && d.kind === "group"), JSON.stringify(h.devices.map((d) => `${d.kind}:${d.name}`)));
check("a healthy pool raises nothing", zfsAlerts([h]).length === 0);

const d = parseZfsPool("pve", { ...healthyEntry, health: "DEGRADED" }, degradedDetail);
check("a degraded pool names the faulted disk with its error counts", d.health === "DEGRADED" && d.problems.some((p) => /scsi-OLDDISK is FAULTED \(too many errors\), 12 read, 3 write errors/.test(p)), JSON.stringify(d.problems));
let al = zfsAlerts([d]);
check("while it resilvers the alert is a warning with the progress in the title", al.length === 1 && al[0].severity === "warning" && /degraded and resilvering, 27.35% done, 03:21:10 to go/.test(al[0].title) && /scsi-OLDDISK/.test(al[0].detail), JSON.stringify(al[0]));
al = zfsAlerts([parseZfsPool("pve", { ...healthyEntry, health: "DEGRADED" }, { ...degradedDetail, scan: healthyDetail.scan, status: undefined, action: undefined })]);
check("degraded with nothing rebuilding is critical and says to replace the disk", al[0].severity === "critical" && /is DEGRADED/.test(al[0].title) && /replace the failed disk/.test(al[0].detail));
al = zfsAlerts([parseZfsPool("pve", { ...healthyEntry, health: "FAULTED" }, { ...healthyDetail, state: "FAULTED" })]);
check("a faulted pool is critical", al[0].severity === "critical" && /is FAULTED/.test(al[0].title));
al = zfsAlerts([parseZfsPool("pve", healthyEntry, { ...healthyDetail, children: [{ name: "tank", state: "ONLINE", children: [leaf("ata-A", "ONLINE", { cksum: 4 })] }] })]);
check("an online pool whose disk has checksum errors is a warning", al.length === 1 && al[0].severity === "warning" && /disks with errors/.test(al[0].title) && /ata-A has 4 checksum errors/.test(al[0].detail), JSON.stringify(al));
al = zfsAlerts([parseZfsPool("pve", healthyEntry, { ...healthyDetail, errors: "3 data errors, use '-v' for a list" })]);
check("data errors are critical", al.some((a) => a.key === "zfs-data:pve:tank" && a.severity === "critical"));
check("a spare that is waiting (AVAIL) is not a problem", parseZfsPool("pve", healthyEntry, { ...healthyDetail, children: [...healthyDetail.children, { name: "spares", leaf: 0, children: [leaf("ata-SPARE", "AVAIL")] }] }).problems.length === 0);
const bare = parseZfsPool("pve", healthyEntry, null);
check("when the detail cannot be read the list entry is still shown", bare.health === "ONLINE" && bare.devices.length === 0 && zfsAlerts([bare]).length === 0);

// end to end, against a fake Proxmox
const dir = mkdtempSync(join(tmpdir(), "lumina-zfs-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=fake"], { stdio: "ignore" });
let zfsMode = "ok";
const srv = https.createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (q, s) => {
  const send = (code, obj) => { s.statusCode = code; s.setHeader("content-type", "application/json"); s.end(JSON.stringify(obj)); };
  const p = q.url.replace("/api2/json", "");
  if (p === "/nodes") return send(200, { data: [{ node: "pve", status: "online", cpu: 0.1, mem: 1e9, maxmem: 8e9, disk: 1e9, maxdisk: 1e10, uptime: 100 }, ...(zfsMode === "offline-node" ? [{ node: "pve2", status: "offline" }] : [])] });
  if (p === "/cluster/resources") return send(200, { data: [] });
  if (p === "/nodes/pve/disks/zfs") return zfsMode === "broken" ? send(500, {}) : send(200, { data: zfsMode === "none" ? [] : [{ ...healthyEntry, health: zfsMode === "degraded" || zfsMode === "detail-fails" ? "DEGRADED" : "ONLINE" }] });
  if (p === "/nodes/pve/disks/zfs/tank") return zfsMode === "detail-fails" ? send(500, {}) : send(200, { data: zfsMode === "degraded" ? degradedDetail : healthyDetail });
  send(200, { data: [] });
}).listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const make = () => mod.create({ host: `https://127.0.0.1:${srv.address().port}`, tokenId: "u@pam!t", tokenSecret: "s", verifyTls: false, backupMaxAgeDays: 0 }, { log: { info() {}, warn() {}, error() {} } });
let inst = await make();
let data = await inst.poll();
check("the pools are read from the host", data.zfs?.length === 1 && data.zfs[0].name === "tank" && data.zfs[0].node === "pve" && data.zfs[0].devices.length > 0 && data.zfsPartial === false, JSON.stringify(data.zfs?.map((z) => z.name)));
check("a healthy pool raises no alert and no 'data unavailable' warning", (Array.isArray(inst.alerts(data)) ? inst.alerts(data) : inst.alerts(data).conditions).filter((a) => /^zfs/.test(a.key)).length === 0 && data.warnings.length === 0, JSON.stringify(data.warnings));
const anon = redactState({ instanceId: "x", moduleId: "proxmox", status: "connected", enabled: true, data, error: null }).data.zfs[0];
check("anonymous viewers see the layout but not the disk ids", anon.devices.some((v) => v.name === "mirror-0") && !JSON.stringify(anon).includes("scsi-") && !JSON.stringify(anon).includes("ata-WDC"));
await inst.dispose?.();

zfsMode = "degraded"; inst = await make(); data = await inst.poll();
const raised = inst.alerts(data); const list = Array.isArray(raised) ? raised : raised.conditions;
check("a degraded, resilvering pool raises the alert through the module", list.some((a) => a.key === "zfs:pve:tank" && /resilvering, 27.35% done/.test(a.title)), JSON.stringify(list.filter((a) => /^zfs/.test(a.key))));
zfsMode = "broken";
await inst.dispose?.();

inst = await make(); data = await inst.poll();
const r2 = inst.alerts(data);
check("when the host cannot be asked, nothing is known and existing ZFS alerts are left alone", data.zfs === null && data.zfsPartial === true && !Array.isArray(r2) && r2.unknown.includes("zfs:") && data.warnings.length === 0, JSON.stringify({ zfs: data.zfs, partial: data.zfsPartial }));
await inst.dispose?.();
// a node that is offline cannot be asked: its pool alerts must be left alone, not closed as fixed
zfsMode = "offline-node"; inst = await make(); data = await inst.poll();
const r3 = inst.alerts(data);
check("an offline node makes the ZFS answer partial, so its alerts are not closed", data.zfsPartial === true && !Array.isArray(r3) && r3.unknown.includes("zfs:") && r3.unknown.includes("zfs-data:"), JSON.stringify({ partial: data.zfsPartial }));
await inst.dispose?.();

// a pool whose detail cannot be read keeps what was known; with nothing known the node counts as not asked
zfsMode = "degraded"; inst = await make(); data = await inst.poll();
check("(setup) the degraded pool with its resilver is known", data.zfs?.[0]?.activity?.kind === "resilver");
zfsMode = "detail-fails";
await new Promise((r) => setTimeout(r, 0));
const cacheBust = await make();
const first = await cacheBust.poll();
check("with no earlier detail, a failed detail read leaves the node 'not known' instead of a pool without its resilver or errors", first.zfs === null && first.zfsPartial === true, JSON.stringify({ zfs: first.zfs, partial: first.zfsPartial }));
await cacheBust.dispose?.();
await inst.dispose?.();
zfsMode = "none"; inst = await make(); data = await inst.poll();
check("a host without ZFS simply has no pools", Array.isArray(data.zfs) && data.zfs.length === 0 && data.zfsPartial === false);
await inst.dispose?.();
srv.close();
process.exit(ok ? 0 : 1);
