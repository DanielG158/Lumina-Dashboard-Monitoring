// The TP-Link Omada module against a fake controller that behaves like the real one's web API (login with a cookie and a CSRF token).
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import { startFakeOmada } from "./helpers/omada-fake.mjs";

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const mod = (await import(ROOT + "/packages/modules/omada/dist/index.js")).default;
const { stateOf, parseDevice } = await import(ROOT + "/packages/modules/omada/dist/index.js");
const { redactState } = await import(ROOT + "/packages/core/dist/redact.js");
const log = { info() {}, warn() {}, error() {} };

const fake = await startFakeOmada();
const { url, state } = fake;
const dev = (o) => ({ mac: "AA-BB-CC-00-00-01", name: "Device", type: "ap", model: "EAP610", showModel: "EAP610 v2", status: 14, statusCategory: 1, ip: "192.168.0.20", uptimeLong: 90000, cpuUtil: 12, memUtil: 41, firmwareVersion: "1.2.3", needUpgrade: false, clientNum: 0, ...o });
const srv = { address: () => ({ port: new URL(url).port }), close: () => fake.close() };
const make = (extra = {}) => mod.create(mod.configSchema.parse({ url, username: "viewer", password: "secret", ...extra }), { log });

// ---- status codes ----
check("controller status numbers are understood", stateOf(14, 1).state === "connected" && stateOf(0, 0).online === false && stateOf(31, 3).state === "heartbeat-missed" && stateOf(20, 2).state === "pending" && stateOf(12, 1).state === "upgrading" && stateOf(99, undefined).state === "unknown");
check("a device record is read", (() => { const d = parseDevice(dev({ type: "gateway", clientNum: undefined })); return d.kind === "gateway" && d.cpu === 12 && d.uptimeS === 90000 && d.model === "EAP610 v2"; })());

// ---- polling ----
let inst = await make();
let d = await inst.poll();
check("it logs in and lists the devices of every site", d.sites.length === 2 && d.sites[0].devices.length === 5 && d.controller.version === "5.14.26.1", `${d.sites.map((s) => s.name + ":" + s.devices.length)}`);
check("devices are told apart by kind", d.sites[0].devices.filter((x) => x.kind === "ap").length === 3 && d.sites[0].devices.some((x) => x.kind === "gateway") && d.sites[0].devices.some((x) => x.kind === "switch"));
check("summary counts online, offline, Wi-Fi clients and updates", d.summary.total === 6 && d.summary.online === 4 && d.summary.offline === 2 && d.summary.clients === 17 && d.summary.upgrades === 1, JSON.stringify(d.summary));
const al = inst.alerts(d);
check("an offline access point raises a critical alert", al.some((a) => a.key === "device-down:AA-00-00-00-00-04" && a.severity === "critical" && /Garage AP is offline/.test(a.title)));
check("a device waiting to be adopted and a firmware update are informational", al.some((a) => a.key.startsWith("device-pending") && a.severity === "info") && al.some((a) => a.key.startsWith("device-fw") && a.severity === "info"));
check("a very busy CPU raises a warning, a normal one does not", al.some((a) => a.key === "device-cpu:AA-00-00-00-00-03") && !al.some((a) => a.key === "device-cpu:AA-00-00-00-00-01"));
const mt = inst.metrics(d);
check("history keeps device counts, clients and per-device load", mt["devices:online"] === 4 && mt["clients:total"] === 17 && mt["cpu:ER605"] === 8 && mt["clients:Living room AP"] === 12, JSON.stringify(mt).slice(0, 140));
check("an offline device has no load figures", !("cpu:Garage AP" in mt));

// ---- session handling ----
const before = state.logins;
await inst.poll();
check("the login is reused between polls", state.logins === before);
state.forgetSession(); // the controller drops the session (a restart, or the idle timeout)
d = await inst.poll().catch((e) => e);
check("when the session ends it logs in again by itself", !(d instanceof Error) && d.summary.total === 6 && state.logins === before + 1, d instanceof Error ? d.message : `logins ${before} -> ${state.logins}`);

// ---- one site, wrong site, wrong password, not a controller ----
inst = await make({ site: "office" });
d = await inst.poll();
check("one site can be chosen (any letter case)", d.sites.length === 1 && d.sites[0].name === "Office" && d.summary.total === 1);
inst = await make({ site: "Nowhere" });
let e = null; try { await inst.poll(); } catch (x) { e = x.message; }
check("an unknown site names the ones the account can see", /"Nowhere"/.test(e ?? "") && /Home, Office/.test(e ?? ""), e);
inst = await mod.create(mod.configSchema.parse({ url, username: "viewer", password: "wrong" }), { log });
e = null; try { await inst.poll(); } catch (x) { e = x.message; }
check("a wrong password is explained", /username or password/.test(e ?? ""), e);
inst = await mod.create(mod.configSchema.parse({ url: `http://127.0.0.1:${srv.address().port}/nope`, username: "viewer", password: "secret" }), { log });
e = null; try { await inst.poll(); } catch (x) { e = x.message; }
check("something that is not an Omada controller is said so", /did not answer like an Omada controller/.test(e ?? ""), e);

// ---- what anonymous viewers see ----
inst = await make();
d = await inst.poll();
const red = redactState({ instanceId: "O", moduleId: "omada", status: "connected", enabled: true, error: null, data: d });
check("anonymous viewers see names and states but no addresses or MACs", red.data.sites[0].devices.every((x) => x.ip === "" && x.mac === "") && red.data.controller.user === null && red.data.sites[0].devices[0].name.length > 0);
check("the password is never part of the data", !JSON.stringify(d).includes("secret"));
srv.close();
process.exit(ok ? 0 : 1);
