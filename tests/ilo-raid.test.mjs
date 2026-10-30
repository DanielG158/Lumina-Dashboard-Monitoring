// RAID volumes: an iLO that is rebuilding a volume is shown as such, with an alert; a healthy volume raises nothing.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
const http = await import("node:http");
const mod = (await import(ROOT + "/packages/modules/ilo4/dist/index.js")).default;
const { parseLogicalDrive } = await import(ROOT + "/packages/modules/ilo4/dist/index.js");
let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const M = (...ids) => ({ Members: ids.map((i) => ({ "@odata.id": i })) });

// the parser on the shapes iLO 4 / iLO 5 can return
const a = parseLogicalDrive({ Raid: "5", CapacityMiB: 5722112, Status: { Health: "Warning" }, Oem: { Hp: { LogicalDriveName: "Logical Drive 01", LogicalDriveStatusReasons: ["LogicalDriveNeedsAttention", "Rebuilding"], RebuildPercentage: 37 } } }, "x");
check("a volume whose status says rebuilding is flagged, with RAID level, size and percentage", a.rebuilding && a.raid === "RAID 5" && a.capacityGiB === 5588 && a.percent === 37 && a.state === "Degraded (rebuilding)", JSON.stringify(a));
const b = parseLogicalDrive({ Raid: "1", Status: { Health: "OK" }, CapacityMiB: 1024 }, "Logical drive 2");
check("a healthy volume is OK and not rebuilding", !b.rebuilding && b.state === "OK" && b.name === "Logical drive 2", JSON.stringify(b));
const c = parseLogicalDrive({ Raid: "5", Status: { Health: "Warning" } }, "x");
check("Warning with no other hint is shown as degraded, not as rebuilding", !c.rebuilding && c.state === "Degraded", JSON.stringify(c));
const dd = parseLogicalDrive({ Status: { Health: "Critical" }, Oem: { Hpe: { ParityInitializationCompletionPercentage: 50 } } }, "x");
check("initialising parity is not mistaken for a rebuild", !dd.rebuilding && dd.percent === null && dd.state === "Failed", JSON.stringify(dd));

// end to end
const S = "/redfish/v1/Systems/1/SmartStorage/";
const routes = {
  "/redfish/v1/Systems/1/": { PowerState: "On", Model: "ProLiant DL380 Gen9", Status: { Health: "Warning" } },
  [S]: { Status: { Health: "Warning" } },
  [S + "ArrayControllers/"]: M(S + "ArrayControllers/0/"),
  [S + "ArrayControllers/0/"]: { Model: "Smart Array P440ar", Status: { Health: "Warning" }, links: { LogicalDrives: { href: S + "ArrayControllers/0/LogicalDrives/" }, PhysicalDrives: { href: S + "ArrayControllers/0/DiskDrives/" } } },
  [S + "ArrayControllers/0/LogicalDrives/"]: M(S + "ArrayControllers/0/LogicalDrives/1/", S + "ArrayControllers/0/LogicalDrives/2/"),
  [S + "ArrayControllers/0/LogicalDrives/1/"]: { Raid: "5", CapacityMiB: 5722112, Status: { Health: "Warning", State: "Enabled" }, Oem: { Hp: { LogicalDriveName: "Data", LogicalDriveStatusReasons: ["Rebuilding"] } } },
  [S + "ArrayControllers/0/LogicalDrives/2/"]: { Raid: "1", CapacityMiB: 953344, Status: { Health: "OK" }, Oem: { Hp: { LogicalDriveName: "System" } } },
  [S + "ArrayControllers/0/DiskDrives/"]: M(S + "ArrayControllers/0/DiskDrives/0/"),
  [S + "ArrayControllers/0/DiskDrives/0/"]: { Location: "1I:3:4", Model: "ST1200MM0088", CapacityMiB: 1144641, Status: { Health: "OK" } },
};
const srv = http.createServer((req, res) => { const r = routes[req.url] ?? { Members: [] }; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(r)); }).listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const inst = await mod.create({ host: `http://127.0.0.1:${srv.address().port}`, username: "u", password: "p", verifyTls: false }, { log: { info() {}, warn() {}, error() {} } });
let d = await inst.poll();
for (let i = 0; i < 30 && !d.storage; i++) { await new Promise((r) => setTimeout(r, 300)); d = await inst.poll(); }
const lv = d.storage?.logical ?? [];
check("both volumes are read from the controller's LogicalDrives link", lv.length === 2 && lv[0].name === "Data" && lv[1].name === "System", JSON.stringify(lv));
check("the physical drives are still read next to them", d.storage?.drives.length === 1 && d.storage.drives[0].health === "OK");
const al = inst.alerts(d).conditions;
const r = al.find((x) => x.key === "logical:0");
check("the rebuilding volume raises a warning, not a critical alert", r?.severity === "warning" && /rebuilding/.test(r.title), JSON.stringify(r));
check("the healthy volume raises nothing", !al.some((x) => x.key === "logical:1"));
await inst.dispose?.();
srv.close();
process.exit(ok ? 0 : 1);
