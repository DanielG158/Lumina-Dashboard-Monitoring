// RAID volumes: an iLO that is rebuilding a volume is shown as such, with an alert; a healthy volume raises nothing.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
const http = await import("node:http");
const mod = (await import(ROOT + "/packages/modules/ilo4/dist/index.js")).default;
const { parseLogicalDrive, applyWebStatus, mergeWebDrives, bay, noteNewDrives } = await import(ROOT + "/packages/modules/ilo4/dist/index.js");
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

// each drive's state and role, from the web page's drive list (shape as read from a real iLO 4)
const P = (i, where, phys, type, extra = {}) => ({ name: `Physical Drive in ${where}`, status: phys === "PHYS_OK" ? "OP_STATUS_OK" : "OP_STATUS_DEGRADED", serial_no: `SER${i}`, model: "AL14SEB120N", capacity: "1200 GB", location: where, fw_version: "DM06", phys_status: phys, drive_type: type, phys_idx: i, drive_mediatype: "HDD", ...extra });
const phyPage = { phy_drive_arrays: [{ physical_drives: [P(0, "Port 1I Box 3 Bay 1", "PHYS_OK", "PHY_CONFIGURED"), P(1, "Port 1I Box 3 Bay 2", "PHYS_REBUILDING", "PHY_CONFIGURED"), P(2, "Port 1I Box 3 Bay 3", "PHYS_FAILED", "PHY_CONFIGURED"), P(3, "Port 1I Box 3 Bay 4", "PHYS_PREDICTIVE_FAILURE", "PHY_CONFIGURED"), P(4, "Port 2I Box 3 Bay 5", "PHYS_OK", "PHY_UNCONFIG"), P(5, "Port 2I Box 3 Bay 6", "PHYS_OK", "PHY_SPARE")] }] };
const logPage = { log_drive_arrays: [{ logical_drives: [{ name: "Logical Drive 01", status: "OP_STATUS_DEGRADED", log_status: "LOG_REBUILDING", physical_drives: [0, 1, 2] }, { name: "Logical Drive 02", status: "OP_STATUS_OK", log_status: "LOG_OK", physical_drives: [3] }] }] };
check("a bay is written the same way whichever page it came from", bay("Port 1I Box 3 Bay 4") === "1I:3:4" && bay("1I:3:4") === "1I:3:4");
const redfishDrives = [{ location: "1I:3:1", model: "AL14SEB120N", serial: "SER0", capacityGB: 1200, health: "OK", tempC: 30, reasons: [] }, { location: "1I:3:2", model: "AL14SEB120N", serial: "SER1", capacityGB: 1200, health: "OK", tempC: 31, reasons: [] }];
const two = [parseLogicalDrive({ Raid: "5", Status: { Health: "Warning" }, LogicalDriveNumber: 1, Oem: { Hp: { LogicalDriveName: "02DA72AFPDNLH0BRH47F1OEA1F" } } }, "x"), parseLogicalDrive({ Raid: "1", Status: { Health: "OK" }, LogicalDriveNumber: 2, Oem: { Hp: { LogicalDriveName: "02DA72AFPDNLH0BRH47F1OEA2A" } } }, "x")];
const m = mergeWebDrives({ logical: two, drives: redfishDrives }, logPage, phyPage);
const at = (loc) => m.drives.find((x) => x.location === loc);
check("every drive gets its own state", at("1I:3:1").state === "OK" && at("1I:3:2").state === "Rebuilding" && at("1I:3:3").state === "Failed" && at("1I:3:4").state === "Predicted to fail", m.drives.map((x) => `${x.location}=${x.state}`).join(" "));
check("and what it is used as: a volume, unassigned, or a spare", at("1I:3:1").volume === "Logical Drive 01" && at("1I:3:4").volume === "Logical Drive 02" && at("2I:3:5").role === "Unassigned" && at("2I:3:6").role === "Spare");
check("drives Redfish did not list are added from the web page, with size and serial", m.drives.length === 6 && at("1I:3:3").capacityGB === 1200 && at("1I:3:3").serial === "SER2");
check("readings Redfish did give are kept", at("1I:3:1").tempC === 30);
check("the volume names its drives and the one it is rebuilding onto", m.logical[0].members.join() === "1I:3:1,1I:3:2,1I:3:3" && m.logical[0].rebuildingOn.join() === "1I:3:2" && m.logical[0].rebuilding === true);
check("without the drive page nothing is changed", mergeWebDrives({ logical: two, drives: redfishDrives }, logPage, null).drives.length === 2);

const mem = { known: null, insertedAt: new Map() };
noteNewDrives(mem, ["A", "B"], 1000);
check("drives that are there when Lumina starts are not called new", mem.insertedAt.size === 0);
noteNewDrives(mem, ["A", "B", "C"], 2000);
check("a drive that appears later is new", mem.insertedAt.get("C") === 2000 && mem.insertedAt.size === 1);
noteNewDrives(mem, ["A", "B", "C"], 2000 + 86_400_001);
check("and stops being new after a day", mem.insertedAt.size === 0);
noteNewDrives(mem, ["A", "B", "C", "D"], 5000); noteNewDrives(mem, ["A", "B", "C"], 6000);
check("a new drive that is pulled again is forgotten", mem.insertedAt.size === 0);

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

// the drives the fake iLO's web page lists; a test can add one, as if a disk was pushed in
let extraDrive = false;
const fakeDrives = () => [P(0, "Port 1I Box 3 Bay 4", "PHYS_REBUILDING", "PHY_CONFIGURED", { serial_no: "W4015R2C", model: "ST1200MM0088" }), P(1, "Port 1I Box 3 Bay 3", "PHYS_FAILED", "PHY_CONFIGURED"), ...(extraDrive ? [P(2, "Port 2I Box 3 Bay 8", "PHYS_OK", "PHY_UNCONFIG", { serial_no: "NEW1" })] : [])];
function fake(mode) {
  const seen = { logins: 0, jsonCalls: 0, logouts: 0, badCookie: 0 };
  const srv = http.createServer((req, res) => {
    const send = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.url === "/json/login_session" && req.method === "POST") {
        let b = {}; try { b = JSON.parse(raw); } catch { /* empty */ }
        if (b.method === "logout") { if (req.headers.cookie === "sessionKey=webkey1") seen.logouts++; return send(200, {}); }
        if (mode !== "json") return send(404, {});
        seen.logins++;
        return send(200, { session_key: "webkey1" });
      }
      if (req.url === "/redfish/v1/Sessions/" && req.method === "POST") {
        if (mode !== "redfish") return send(404, {});
        seen.logins++;
        return send(201, {}, { "x-auth-token": "webkey1", location: "https://192.0.2.1/redfish/v1/Sessions/abc/" });
      }
      if (req.url === "/redfish/v1/Sessions/abc/" && req.method === "DELETE") { if (req.headers["x-auth-token"] === "webkey1") seen.logouts++; return send(200, {}); }
      if (req.url === "/json/health_drives" || req.url === "/json/health_phy_drives") {
        seen.jsonCalls++;
        if (req.headers.cookie !== "sessionKey=webkey1") { seen.badCookie++; return send(401, {}); }
        return send(200, req.url === "/json/health_drives" ? { log_drive_arrays: [{ logical_drives: [{ ...web.log_drive_arrays[0].logical_drives[0], physical_drives: [0, 1] }, web.log_drive_arrays[0].logical_drives[1]] }] } : { phy_drive_arrays: [{ physical_drives: fakeDrives() }] });
      }
      send(200, routes[req.url] ?? { Members: [] });
    });
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

for (const mode of ["json", "redfish"]) {
  const f = fake(mode);
  const { inst, d } = await load(f);
  const lv = d.storage?.logical ?? [];
  if (mode === "json") {
    check("both volumes are read from the controller's LogicalDrives link", lv.length === 2 && lv[1].name === "System" && lv[0].name === "Logical Drive 01", JSON.stringify(lv.map((x) => x.name)));
    check("the physical drives are still read, with the ones only the web page lists added", d.storage?.drives.length === 2 && d.storage.drives[0].health === "OK" && d.storage.drives[0].state === "Rebuilding" && d.storage.webDetail === true, JSON.stringify(d.storage?.drives.map((x) => [x.location, x.state])));
  }
  check(`[${mode} login] the Data volume is shown as rebuilding, using the iLO web page`, lv[0]?.rebuilding === true && lv[0].state === "Degraded (rebuilding)", JSON.stringify(lv[0]));
  check(`[${mode} login] it logged in once and sent the session key as a cookie`, f.seen.logins === 1 && f.seen.jsonCalls === 2 && f.seen.badCookie === 0, JSON.stringify(f.seen));
  if (mode === "json") {
    const al = inst.alerts(d).conditions;
    const r = al.find((x) => x.key === "logical:0");
    check("the rebuilding volume raises a warning, not a critical alert", r?.severity === "warning" && /rebuilding/.test(r.title), JSON.stringify(r));
    check("the healthy volume raises nothing", !al.some((x) => x.key === "logical:1"));
    check("the rebuild alert says which drive it is rebuilding onto", /Rebuilding onto the drive in bay 1I:3:4/.test(r?.detail ?? ""), r?.detail);
    const failed = al.find((x) => /^drive:/.test(x.key) && /has failed/.test(x.title));
    check("a failed drive is named with its bay, model, size, serial, its volume and what to do", failed?.severity === "critical" && /bay 1I:3:3/.test(failed.title) && /AL14SEB120N/.test(failed.detail) && /1200 GB/.test(failed.detail) && /serial SER1/.test(failed.detail) && /Logical Drive 01/.test(failed.detail) && /replace this drive/.test(failed.detail), JSON.stringify(failed));
    check("the drive being rebuilt onto is not also reported as broken", !al.some((x) => /^drive:/.test(x.key) && /1I:3:4/.test(x.title)));
    check("no drive is called new just because Lumina started", !al.some((x) => /^drive-new:/.test(x.key)));
    const t = await inst.actions.find((a) => a.id === "web-status-test").run();
    check("the diagnostic says it worked and lists the steps, without the password", t.worked === true && t.volumes[0].logStatus === "LOG_REBUILDING" && t.steps.length >= 2 && !JSON.stringify(t).includes('"p"') && !/password|webkey1/i.test(JSON.stringify(t)), JSON.stringify(t));
  }
  await inst.dispose?.();
  check(`[${mode} login] the session is closed again when the instance stops`, f.seen.logouts >= 1, JSON.stringify(f.seen));
  f.srv.close();
}

// the web page cannot be used: the status stays as Redfish gave it, and nothing breaks
const none = fake("none");
const second = await load(none);
const lv2 = second.d.storage?.logical ?? [];
check("when no session can be opened the volume is shown as degraded", lv2[0]?.state === "Degraded" && lv2[0].rebuilding === false, JSON.stringify(lv2[0]));
check("and the degraded alert is still raised", second.inst.alerts(second.d).conditions.some((x) => x.key === "logical:0" && /degraded/.test(x.title)));
const t2 = await second.inst.actions.find((a) => a.id === "web-status-test").run();
check("the diagnostic says why: both logins refused", t2.worked === false && t2.steps.some((l) => /web login: HTTP 404/.test(l)) && t2.steps.some((l) => /redfish login: HTTP 404/.test(l)), JSON.stringify(t2.steps));
await second.inst.dispose?.();
none.srv.close();
process.exit(ok ? 0 : 1);
