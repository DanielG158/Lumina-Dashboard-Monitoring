// RAID volumes: an iLO that is rebuilding a volume is shown as such, with an alert; a healthy volume raises nothing.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
const http = await import("node:http");
const mod = (await import(ROOT + "/packages/modules/ilo4/dist/index.js")).default;
const { parseLogicalDrive, applyWebStatus } = await import(ROOT + "/packages/modules/ilo4/dist/index.js");
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

const named = parseLogicalDrive({ Raid: "5", Status: { Health: "OK" }, LogicalDriveNumber: 1, Oem: { Hp: { LogicalDriveName: "02DA72AFPDNLH0BRH47F1OEA1F" } } }, "x");
check("a volume labelled only with its id is shown as Logical Drive 01", named.name === "Logical Drive 01", named.name);
check("a name someone chose is kept", parseLogicalDrive({ Status: { Health: "OK" }, LogicalDriveNumber: 2, Oem: { Hp: { LogicalDriveName: "Databases" } } }, "x").name === "Databases");

// the iLO web page's own answer (shape as read from a real iLO 4)
const web = { log_drive_arrays: [{ logical_drives: [{ name: "Logical Drive 01", status: "OP_STATUS_DEGRADED", log_status: "LOG_REBUILDING", flt_tol: "RAID 5" }, { name: "Logical Drive 02", status: "OP_STATUS_OK", log_status: "LOG_OK", flt_tol: "RAID 1/RAID 1+0" }] }] };
const vols = [parseLogicalDrive({ Raid: "5", Status: { Health: "Warning" }, LogicalDriveNumber: 1, Oem: { Hp: { LogicalDriveName: "02DA72AFPDNLH0BRH47F1OEA1F" } } }, "x"), parseLogicalDrive({ Raid: "1", Status: { Health: "OK" }, LogicalDriveNumber: 2, Oem: { Hp: { LogicalDriveName: "System" } } }, "x")];
const merged = applyWebStatus(vols, web);
check("the web page's LOG_REBUILDING turns a Warning volume into 'rebuilding'", merged[0].rebuilding && merged[0].state === "Degraded (rebuilding)", merged[0].state);
check("a healthy volume is left alone", !merged[1].rebuilding && merged[1].state === "OK");
check("a ready-to-rebuild volume says so", applyWebStatus([vols[0]], { log_drive_arrays: [{ logical_drives: [{ name: "Logical Drive 01", log_status: "LOG_READY_FOR_REBUILD" }] }] })[0].state === "Degraded (ready to rebuild)");
check("no web answer keeps the Redfish status", applyWebStatus(vols, null)[0].state === "Degraded" && applyWebStatus(vols, {})[0].state === "Degraded");
check("a name that is all capitals, digits and a space is treated as an id", parseLogicalDrive({ LogicalDriveNumber: 1, Status: { Health: "OK" }, Oem: { Hp: { LogicalDriveName: "004C8594PEYHC0DRHB70EL 9C27" } } }, "x").name === "Logical Drive 01");

// end to end
const S = "/redfish/v1/Systems/1/SmartStorage/";
const routes = {
  "/redfish/v1/Systems/1/": { PowerState: "On", Model: "ProLiant DL380 Gen9", Status: { Health: "Warning" } },
  [S]: { Status: { Health: "Warning" } },
  [S + "ArrayControllers/"]: M(S + "ArrayControllers/0/"),
  [S + "ArrayControllers/0/"]: { Model: "Smart Array P440ar", Status: { Health: "Warning" }, links: { LogicalDrives: { href: S + "ArrayControllers/0/LogicalDrives/" }, PhysicalDrives: { href: S + "ArrayControllers/0/DiskDrives/" } } },
  [S + "ArrayControllers/0/LogicalDrives/"]: M(S + "ArrayControllers/0/LogicalDrives/1/", S + "ArrayControllers/0/LogicalDrives/2/"),
  [S + "ArrayControllers/0/LogicalDrives/1/"]: { Raid: "5", CapacityMiB: 5722112, Status: { Health: "Warning", State: "Enabled" }, LogicalDriveNumber: 1, Oem: { Hp: { LogicalDriveName: "02DA72AFPDNLH0BRH47F1OEA1F" } } },
  [S + "ArrayControllers/0/LogicalDrives/2/"]: { Raid: "1", CapacityMiB: 953344, Status: { Health: "OK" }, Oem: { Hp: { LogicalDriveName: "System" } } },
  [S + "ArrayControllers/0/DiskDrives/"]: M(S + "ArrayControllers/0/DiskDrives/0/"),
  [S + "ArrayControllers/0/DiskDrives/0/"]: { Location: "1I:3:4", Model: "ST1200MM0088", CapacityMiB: 1144641, Status: { Health: "OK" } },
};

function fake(withSessions) {
  const seen = { logins: 0, jsonCalls: 0, logouts: 0, badCookie: 0 };
  const srv = http.createServer((req, res) => {
    const send = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    if (req.url === "/redfish/v1/Sessions/" && req.method === "POST") {
      if (!withSessions) return send(404, {});
      seen.logins++;
      return send(201, {}, { "x-auth-token": "tok123", location: "https://192.0.2.1/redfish/v1/Sessions/abc/" });
    }
    if (req.url === "/redfish/v1/Sessions/abc/" && req.method === "DELETE") { if (req.headers["x-auth-token"] === "tok123") seen.logouts++; return send(200, {}); }
    if (req.url === "/json/health_drives") {
      seen.jsonCalls++;
      if (req.headers.cookie !== "sessionKey=tok123") { seen.badCookie++; return send(401, {}); }
      return send(200, web);
    }
    send(200, routes[req.url] ?? { Members: [] });
  }).listen(0, "127.0.0.1");
  return { srv, seen };
}
async function load(f) {
  await new Promise((r) => f.srv.once("listening", r));
  const inst = await mod.create({ host: `http://127.0.0.1:${f.srv.address().port}`, username: "u", password: "p", verifyTls: false }, { log: { info() {}, warn() {}, error() {} } });
  let d = await inst.poll();
  for (let i = 0; i < 30 && !d.storage; i++) { await new Promise((r) => setTimeout(r, 300)); d = await inst.poll(); }
  return { inst, d };
}

const a1 = fake(true);
const { inst, d } = await load(a1);
const lv = d.storage?.logical ?? [];
check("both volumes are read from the controller's LogicalDrives link", lv.length === 2 && lv[1].name === "System" && lv[0].name === "Logical Drive 01", JSON.stringify(lv.map((x) => x.name)));
check("the Data volume is shown as rebuilding, using the iLO web page", lv[0]?.rebuilding === true && lv[0].state === "Degraded (rebuilding)", JSON.stringify(lv[0]));
check("it logged in once and sent the session key as a cookie", a1.seen.logins === 1 && a1.seen.jsonCalls === 1 && a1.seen.badCookie === 0, JSON.stringify(a1.seen));
check("the physical drives are still read next to them", d.storage?.drives.length === 1 && d.storage.drives[0].health === "OK");
const al = inst.alerts(d).conditions;
const r = al.find((x) => x.key === "logical:0");
check("the rebuilding volume raises a warning, not a critical alert", r?.severity === "warning" && /rebuilding/.test(r.title), JSON.stringify(r));
check("the healthy volume raises nothing", !al.some((x) => x.key === "logical:1"));
await inst.dispose?.();
check("the session is closed again when the instance stops", a1.seen.logouts === 1, JSON.stringify(a1.seen));
a1.srv.close();

// the web page cannot be used: the status stays as Redfish gave it, and nothing breaks
const a2 = fake(false);
const second = await load(a2);
const lv2 = second.d.storage?.logical ?? [];
check("when no session can be opened the volume is shown as degraded", lv2[0]?.state === "Degraded" && lv2[0].rebuilding === false, JSON.stringify(lv2[0]));
check("and no alert says it is rebuilding, but the degraded one is still raised", second.inst.alerts(second.d).conditions.some((x) => x.key === "logical:0" && /degraded/.test(x.title)));
await second.inst.dispose?.();
a2.srv.close();
process.exit(ok ? 0 : 1);
