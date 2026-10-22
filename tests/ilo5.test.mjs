// A fake iLO 5 (Gen10) that answers the way HPE's iLO 5 Redfish does, to check the module reads it.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
const http = await import("node:http");
const mod = (await import(ROOT + "/packages/modules/ilo4/dist/index.js")).default;
const { healthComponents } = await import(ROOT + "/packages/modules/ilo4/dist/index.js");
let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const M = (...ids) => ({ Members: ids.map((i) => ({ "@odata.id": i })) });
const routes = {
  "/redfish/v1/Systems/1/": {
    PowerState: "On", Model: "ProLiant DL380 Gen10", SKU: "826565-B21", BiosVersion: "U30 v2.76 (02/09/2023)",
    Status: { Health: "Warning", HealthRollup: "Warning" },
    ProcessorSummary: { Count: 2, Model: "Intel Xeon Gold 6138", Status: { HealthRollup: "OK" } },
    MemorySummary: { TotalSystemMemoryGiB: 256, Status: { HealthRollup: "Warning" } },
    Oem: { Hpe: { PostState: "FinishedPost", PowerRegulatorMode: "Dynamic", AggregateHealthStatus: {
      AgentlessManagementService: "Unavailable", FanRedundancy: "Redundant", PowerSupplyRedundancy: "NotRedundant",
      Fans: { Status: { Health: "OK" } }, Memory: { Status: { Health: "Warning" } }, Storage: { Status: { Health: "OK" } }, Temperatures: { Status: { Health: "OK" } } } } },
  },
  "/redfish/v1/Chassis/1/Power/": { PowerControl: [{ PowerConsumedWatts: 288 }], PowerSupplies: [{ Name: "HpeServerPowerSupply", Status: { Health: "OK", State: "Enabled" }, Oem: { Hpe: { BayNumber: 1 } } }] },
  "/redfish/v1/Chassis/1/Thermal/": { Temperatures: [{ Name: "01-Inlet Ambient", ReadingCelsius: 26, UpperThresholdCritical: 42 }], Fans: [{ Name: "Fan 1", Reading: 32, ReadingUnits: "Percent", Status: { Health: "OK", State: "Enabled" } }] },
  "/redfish/v1/Chassis/1/": { Oem: { Hpe: {} } },
  "/redfish/v1/UpdateService/FirmwareInventory/": M("/redfish/v1/UpdateService/FirmwareInventory/1/"),
  "/redfish/v1/UpdateService/FirmwareInventory/1/": { Name: "iLO 5", Version: "2.81 Jul 07 2023" },
  "/redfish/v1/Managers/1/": { FirmwareVersion: "iLO 5 v2.81", Status: { Health: "OK" }, Oem: { Hpe: { License: { LicenseString: "iLO Advanced", LicenseType: "Perpetual" } } } },
  "/redfish/v1/Managers/1/EthernetInterfaces/": M("/redfish/v1/Managers/1/EthernetInterfaces/1/"),
  "/redfish/v1/Managers/1/EthernetInterfaces/1/": { MacAddress: "aa", SpeedMbps: 1000 },
  "/redfish/v1/Systems/1/SmartStorage/": { Status: { Health: "OK" } },
  "/redfish/v1/Systems/1/SmartStorage/ArrayControllers/": M("/redfish/v1/Systems/1/SmartStorage/ArrayControllers/0/"),
  "/redfish/v1/Systems/1/SmartStorage/ArrayControllers/0/": { Model: "HPE Smart Array P408i-a SR Gen10", Status: { Health: "OK" }, Links: { PhysicalDrives: { "@odata.id": "/redfish/v1/Systems/1/SmartStorage/ArrayControllers/0/DiskDrives/" } } },
  "/redfish/v1/Systems/1/SmartStorage/ArrayControllers/0/DiskDrives/": M("/redfish/v1/Systems/1/SmartStorage/ArrayControllers/0/DiskDrives/0/"),
  "/redfish/v1/Systems/1/SmartStorage/ArrayControllers/0/DiskDrives/0/": { Location: "1I:1:1", Model: "EG001200JWJNQ", CapacityMiB: 1144641, MediaType: "HDD", InterfaceType: "SAS", Status: { Health: "OK" }, CurrentTemperatureCelsius: 34 },
  "/redfish/v1/Systems/1/BaseNetworkAdapters/": M("/redfish/v1/Systems/1/BaseNetworkAdapters/1/"),
  "/redfish/v1/Systems/1/BaseNetworkAdapters/1/": { Name: "HPE Ethernet 1Gb 4-port 331i", PhysicalPorts: [{ Name: "Port 1", MacAddress: "bb", SpeedMbps: 1000, Status: { Health: "OK", State: "Enabled" } }] },
  "/redfish/v1/Systems/1/Processors/": M("/redfish/v1/Systems/1/Processors/1/"),
  "/redfish/v1/Systems/1/Processors/1/": { Id: "1", Socket: "Proc 1", Model: "Intel Xeon Gold 6138", TotalCores: 20, TotalThreads: 40, Status: { Health: "OK" } },
  "/redfish/v1/Systems/1/Memory/": M("/redfish/v1/Systems/1/Memory/1/", "/redfish/v1/Systems/1/Memory/2/"),
  "/redfish/v1/Systems/1/Memory/1/": { DeviceLocator: "PROC 1 DIMM 1", CapacityMiB: 32768, MemoryDeviceType: "DDR4", OperatingSpeedMhz: 2666, RankCount: 2, ErrorCorrection: "MultiBitECC", Status: { State: "Enabled", Health: "OK" }, Oem: { Hpe: { DIMMStatus: "GoodInUse" } } },
  "/redfish/v1/Systems/1/Memory/2/": { DeviceLocator: "PROC 1 DIMM 2", Status: { State: "Absent" }, Oem: { Hpe: { DIMMStatus: "NotPresent" } } },
  "/redfish/v1/Systems/1/LogServices/IML/Entries/": M(), "/redfish/v1/Managers/1/LogServices/IEL/Entries/": M(),
};
const srv = http.createServer((req, res) => { const b = routes[req.url]; if (!b) { res.writeHead(404); res.end("{}"); return; } res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); }).listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const inst = await mod.create({ host: `http://127.0.0.1:${srv.address().port}`, username: "u", password: "p", verifyTls: false }, { log: { info() {}, warn() {}, error() {} } });
let d = await inst.poll();
for (let i = 0; i < 30 && !(d.storage && d.memory.dimms && d.firmware); i++) { await new Promise((r) => setTimeout(r, 300)); d = await inst.poll(); }
check("overall health and power are read", d.health === "Warning" && d.power.nowW === 288 && d.postState === "FinishedPost");
check("processor and memory health use iLO 5's spelling (HealthRollup)", d.cpu.health === "OK" && d.memory.health === "Warning", `${d.cpu.health}/${d.memory.health}`);
check("the iLO's own breakdown names what is wrong", d.healthParts.some((x) => x.name === "Memory" && x.health === "Warning") && d.healthParts.some((x) => x.name === "Power Supply Redundancy"), JSON.stringify(d.healthParts));
check("drives are found through the standard @odata.id link", d.storage?.drives.length === 1 && d.storage.drives[0].capacityGB === 1200 && d.storage.drives[0].tempC === 34, JSON.stringify(d.storage?.drives));
check("memory modules use iLO 5 names; empty slots are left out", d.memory.dimms?.length === 1 && d.memory.dimms[0].sizeGB === 32 && d.memory.dimms[0].mhz === 2666 && d.memory.dimms[0].type === "DDR4", JSON.stringify(d.memory.dimms));
check("firmware list comes from the update service", d.firmware?.some((f) => f.version.startsWith("2.81")), JSON.stringify(d.firmware));
check("network adapters are found under BaseNetworkAdapters", d.network?.[0]?.name?.includes("331i") && d.network[0].ports.length === 1);
check("iLO 5 license is read from Oem.Hpe", d.ilo?.license === "iLO Advanced");
check("PSU bay number is read from Oem.Hpe", d.supplies[0].name === "Bay 1", d.supplies[0].name);
const alerts = inst.alerts(d).conditions;
const sh = alerts.find((a) => a.key === "server-health");
check("a Warning is a warning alert, not critical, and says why", sh?.severity === "warning" && /Memory: Warning/.test(sh.detail), JSON.stringify(sh));
check("healthComponents tolerates missing data", healthComponents({}).length === 0);
await inst.dispose?.();
srv.close();
process.exit(ok ? 0 : 1);
