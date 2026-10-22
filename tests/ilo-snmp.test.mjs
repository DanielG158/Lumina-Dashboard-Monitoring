// The HPE iLO (SNMP) module against a fake iLO that serves the CPQ health tables.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import { createRequire } from "node:module";
import { startFakeHpe, GEN9_WITH_TROUBLE } from "./helpers/hpe-snmp-fake.mjs";

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const mod = (await import(ROOT + "/packages/modules/ilo-snmp/dist/index.js")).default;
const P = await import(ROOT + "/packages/modules/ilo-snmp/dist/index.js");
const { redactState } = await import(ROOT + "/packages/core/dist/redact.js");
const log = { info() {}, warn() {}, error() {} };

// ---- row parsing ----
check("conditions are read", P.cond(2) === "ok" && P.cond(3) === "degraded" && P.cond(4) === "failed" && P.cond(1) === "unknown");
const temps = P.parseTemps({ "1.1": { 3: 11, 4: 26, 5: 42, 6: 2 }, "1.2": { 3: 6, 4: -99, 5: 70, 6: 1 }, "1.3": { 3: 6, 4: 63, 5: 70, 6: 2 }, "1.4": { 3: 6, 4: 61, 5: 0, 6: 2 } });
check("temperatures: -99 means unreadable and is skipped, same-place sensors are numbered", temps.length === 3 && temps[0].name === "Ambient 1" && temps[1].name === "CPU 1" && temps[2].name === "CPU 2" && temps[2].limitC === null, JSON.stringify(temps.map((t) => t.name)));
check("fans: only fans that are present are listed", P.parseFans({ "1.1": { 3: 3, 4: 3, 9: 2, 12: 3000 }, "1.2": { 3: 3, 4: 2, 9: 1, 12: 0 } }).length === 1);
check("memory: a slot with size 0 is empty and left out; sizes are kilobytes", (() => { const d = P.parseDimms({ "1.1": { 3: 16777216, 11: 2, 12: Buffer.from("PROC 1 DIMM 1"), 13: 2133 }, "1.2": { 3: 0, 11: 1, 12: "x" } }); return d.length === 1 && d[0].sizeGB === 16 && d[0].slot === "PROC 1 DIMM 1" && d[0].ok; })());
check("drives: status words, size in GB, bad temperatures ignored", (() => { const d = P.parseDrives({ "1.1": { 3: "X", 5: 1, 6: 3, 37: 4, 45: 1048576, 64: "Bay 1", 69: 3, 70: 255, 74: 5 } })[0]; return d.status === "failed" && !d.statusOk && d.sizeGB === 1024 && d.tempC === null && d.media === "SSD"; })());

// ---- the whole module against a fake iLO ----
const PORT = 16201;
const fake = startFakeHpe(PORT, GEN9_WITH_TROUBLE);
const cfg = mod.configSchema.parse({ host: "127.0.0.1", port: PORT, community: "public" });
const inst = await mod.create(cfg, { log });
const d = await inst.poll();
check("it reads the server and the iLO", d.product === "ProLiant DL380 Gen9" && d.ilo.model === "iLO 4" && d.overall === "degraded", JSON.stringify({ p: d.product, o: d.overall }));
check("temperatures, fans, power supplies and processors are listed", d.temps.length === 4 && d.fans.length === 3 && d.supplies.length === 2 && d.cpus.length === 2, `${d.temps.length}/${d.fans.length}/${d.supplies.length}/${d.cpus.length}`);
check("memory modules (empty slot skipped), the controller and the drives are listed", d.dimms.length === 2 && d.controllers.length === 1 && d.logical.length === 1 && d.drives.length === 3, `${d.dimms.length}/${d.controllers.length}/${d.logical.length}/${d.drives.length}`);
check("power comes from the iLO's power meter", d.powerW === 231);
check("no section failed", d.warnings.length === 0, JSON.stringify(d.warnings));
const al = inst.alerts(d);
const keys = al.map((a) => a.key);
check("the overall state is a warning and names the parts that are not ok", al.some((a) => a.key === "server-health" && a.severity === "warning" && /Memory: degraded/.test(a.detail ?? "")), JSON.stringify(al.find((a) => a.key === "server-health")));
check("a sensor over its limit is critical; a normal one raises nothing", al.some((a) => a.key === "temp:CPU 2" && a.severity === "critical") && !keys.includes("temp:CPU 1") && !keys.includes("temp:Ambient 1"));
check("a failed fan is critical; working fans raise nothing", al.some((a) => a.key.startsWith("fan:") && a.severity === "critical" && /Fan 3/.test(a.title)) && keys.filter((k) => k.startsWith("fan:")).length === 1);
check("a failed drive is critical, a hot drive a warning", al.some((a) => a.key === "drive:1.2" && a.severity === "critical") && al.some((a) => a.key === "drive-temp:1.3" && a.severity === "warning"));
check("a degraded controller, a rebuilding logical drive and a worn memory module are reported", keys.some((k) => k.startsWith("controller:")) && al.some((a) => a.key === "logical:1.1" && /recovering/.test(a.title)) && keys.includes("dimm:PROC 1 DIMM 2"));
const m = inst.metrics(d);
check("history uses the same names as the Redfish iLO module: power, temp:max, temp:inlet", m.power === 231 && m["temp:max"] === 74 && m["temp:inlet"] === 26 && m["fan:rpm"] > 3000 && m["drive-temp:max"] === 56, JSON.stringify(m));
check("it is read-only apart from a settings test for admins", inst.actions.length === 1 && inst.actions[0].id === "probe" && inst.actions[0].minRole === "admin");
const red = redactState({ instanceId: "I", moduleId: "ilo-snmp", status: "connected", enabled: true, error: null, data: d });
check("anonymous viewers do not see the serial number or the iLO's name", red.data.serial === null && red.data.ilo.name === null && red.data.product === "ProLiant DL380 Gen9" && red.data.temps.length === 4);
await inst.dispose?.();
fake.close();

// ---- a device that is not an HPE server ----
const other = startFakeHpe(PORT + 1, { scalars: { sysName: "switch", sysDescr: "Some switch" } });
const o = await mod.create(mod.configSchema.parse({ host: "127.0.0.1", port: PORT + 1, community: "public" }), { log });
let e = null; try { await o.poll(); } catch (x) { e = x.message; }
check("a device without HPE's health data is told apart and the hint mentions Agentless Management", /none of HPE's server health data/.test(e ?? "") && /Agentless Management/.test(e ?? ""), e);
await o.dispose?.(); other.close();

// ---- a server whose iLO hides some tables ----
const partial = startFakeHpe(PORT + 2, { ...GEN9_WITH_TROUBLE, drives: undefined, logical: undefined });
const pi = await mod.create(mod.configSchema.parse({ host: "127.0.0.1", port: PORT + 2, community: "public" }), { log });
const pd = await pi.poll();
check("a missing table does not break the rest", pd.temps.length === 4 && pd.drives.length === 0 && pd.overall === "degraded");
await pi.dispose?.(); partial.close();

// nothing listening on the port: the message names the iLO setting to change
const closed = await new Promise((r) => { const d = createRequire(import.meta.url)("node:dgram").createSocket("udp4"); d.bind(0, "127.0.0.1", () => { const x = d.address().port; d.close(() => r(x)); }); });
const none = await mod.create(mod.configSchema.parse({ host: "127.0.0.1", port: closed, community: "public" }), { log });
let en = null; try { await none.poll(); } catch (x) { en = x.message; }
check("when the iLO does not listen the message says to enable SNMP Access in the iLO's Access Settings", /port closed/.test(en ?? "") && /router or firewall/.test(en ?? "") && /Access Settings/.test(en ?? "") && /SNMP Access/.test(en ?? ""), en);
await none.dispose?.();
check("settings are validated like the SNMP module's", !mod.configSchema.safeParse({ host: "x" }).success && mod.configSchema.safeParse({ host: "x", community: "public" }).success);
process.exit(ok ? 0 : 1);
