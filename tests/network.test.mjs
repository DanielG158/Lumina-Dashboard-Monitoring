// Network checks (ping, tcp, dns, http, speed test) and the SNMP module, against local fakes.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import net from "node:net";
import http from "node:http";
import { createRequire } from "node:module";

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = { info() {}, warn() {}, error() {} };

const nc = await import(ROOT + "/packages/modules/netcheck/dist/index.js");
const sn = await import(ROOT + "/packages/modules/snmp/dist/index.js");

// ---- target list parsing ---------------------------------------------------------------------------------------------
let p = nc.parseTargets("# comment\nGateway | ping | 192.168.1.1\nDNS | dns | example.com @192.168.1.1\nWeb | tcp | 10.0.0.5:8006\nSite | http | https://example.com/x\nV6 | tcp | [::1]:22\n\n");
check("a good list is read", p.errors.length === 0 && p.targets.length === 5, JSON.stringify(p.errors));
for (const [bad, why] of [["x | ping | -f", "an option-looking host"], ["x | ping | a b", "spaces"], ["x | ping | 1.1.1.1; rm -rf /", "shell characters"], ["x | tcp | host", "a missing port"], ["x | tcp | host:70000", "a port out of range"], ["x | smtp | host", "an unknown kind"], ["x | http | ftp://h", "a non-http address"], ["x | dns | example.com @notanip", "a bad resolver"], ["only two | ping", "two columns"], ["a | ping | 1.1.1.1\nA | ping | 1.1.1.2", "a repeated name"], ["", "an empty list"]]) {
  check(`rejected: ${why}`, nc.parseTargets(bad).errors.length > 0);
}
check("ping output is understood", (() => { const r = nc.parsePing("4 packets transmitted, 3 received, 25% packet loss, time 900ms\nrtt min/avg/max/mdev = 0.500/1.250/2.000/0.600 ms"); return r.sent === 4 && r.received === 3 && r.avg === 1.25 && r.mdev === 0.6; })());

check("silence, rejection and unreachable hosts are told apart", /dropping them/.test(nc.explainNoReply("4 packets transmitted, 0 received, 100% packet loss")) && /firewall/.test(nc.explainNoReply("From 10.0.0.1 icmp_seq=1 Packet filtered")) && /unreachable/i.test(nc.explainNoReply("From 10.0.0.9 icmp_seq=1 Destination Host Unreachable")));

// ---- netcheck against local services ---------------------------------------------------------------------------------
const tcp = net.createServer((s) => s.end()); await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
const web = http.createServer((q, s) => {
  if (q.url.startsWith("/__down")) { const n = Number(new URL(q.url, "http://x").searchParams.get("bytes")); s.writeHead(200, { "content-length": n }); s.end(Buffer.alloc(n, 1)); return; }
  if (q.url === "/__up") { q.resume(); q.on("end", () => s.end("ok")); return; }
  if (q.url === "/bad") { s.writeHead(503); s.end("no"); return; }
  s.end("hello");
});
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const wp = web.address().port;
const deadPort = await new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const x = s.address().port; s.close(() => r(x)); }); });
const lines = [`Local tcp | tcp | 127.0.0.1:${tcp.address().port}`, `Closed tcp | tcp | 127.0.0.1:${deadPort}`, `Web ok | http | http://127.0.0.1:${wp}/`, `Web 503 | http | http://127.0.0.1:${wp}/bad`, "Loopback | ping | 127.0.0.1", "Nowhere | ping | 192.0.2.1"].join("\n");
const cfg = { targets: lines, packets: 2, warnLatencyMs: 150, warnLossPct: 20, speedTest: true, speedTestEveryHours: 6, speedTestMB: 2, speedTestDownloadUrl: `http://127.0.0.1:${wp}/__down`, speedTestUploadUrl: `http://127.0.0.1:${wp}/__up` };
check("the configuration is accepted", nc.default.configSchema.safeParse(cfg).success);
check("a bad list is refused with a readable message", /line 1/.test(JSON.stringify(nc.default.configSchema.safeParse({ ...cfg, targets: "oops" }).error?.issues ?? [])));
const inst = await nc.default.create(nc.default.configSchema.parse(cfg), { log });
const d = await inst.poll();
const by = Object.fromEntries(d.targets.map((t) => [t.name, t]));
check("an open port is up with a latency", by["Local tcp"].ok && by["Local tcp"].ms !== null && by["Local tcp"].lossPct === 0);
check("a closed port is down and says why", !by["Closed tcp"].ok && /refused/i.test(by["Closed tcp"].error), by["Closed tcp"].error);
check("a web page that answers is up; a 503 is down", by["Web ok"].ok && !by["Web 503"].ok && /503/.test(by["Web 503"].error));
const icmpOk = by["Loopback"].ok;
check("ping to loopback works, or says plainly that pings are not allowed", icmpOk ? by["Loopback"].lossPct === 0 && by["Loopback"].ms !== null : d.icmpBlocked === true && /not allowed|not installed/.test(by["Loopback"].error), by["Loopback"].error ?? `${by["Loopback"].ms} ms`);
check("an address that never answers is down", !by["Nowhere"].ok);
const al = inst.alerts(d);
check("alerts are raised for the dead targets, not the live ones", al.some((a) => a.key === "check-down:Closed tcp" && a.severity === "critical") && al.some((a) => a.key === "check-down:Web 503") && !al.some((a) => a.key === "check-down:Local tcp"), al.map((a) => a.key).join(", "));
const m = inst.metrics(d);
check("latency and loss are recorded per target", typeof m["rtt:Local tcp"] === "number" && m["loss:Closed tcp"] === 100 && m["net:down"] >= 3, JSON.stringify(m).slice(0, 160));
const sp = await inst.actions.find((a) => a.id === "speedtest").run({}, {});
check("the speed test measures download and upload against the configured addresses", sp.downMbps > 0 && sp.upMbps > 0 && sp.error === null, JSON.stringify(sp));
const sc = { ...cfg, speedTest: false };
const inst2 = await nc.default.create(nc.default.configSchema.parse(sc), { log });
let refused = false; try { await inst2.actions[0].run({}, {}); } catch { refused = true; }
check("with speed tests switched off the action refuses", refused);
const slow = inst.alerts({ ...d, speed: { downMbps: 20, upMbps: 5, latencyMs: 10, at: 1, error: null }, warn: { ...d.warn, minDownMbps: 50 } });
check("a speed below your limit raises a warning", slow.some((a) => a.key === "speed-low" && a.severity === "warning"));
await inst.dispose?.(); await inst2.dispose?.();

// ---- a device that hides parts of its data (SNMP authorizationError) ----
const denied = () => Object.assign(new Error("AuthorizationError"), { status: 16 });
check("authorizationError is recognised", sn.isDenied(denied()) && sn.isDenied(new Error("AuthorizationError")) && !sn.isDenied(new Error("Request timed out")));
let calls = [];
const sys = await sn.getSystem(async (oids) => { calls.push(oids.length); if (oids.length > 1) throw denied(); if (oids[0].endsWith(".1.0")) throw denied(); return [{ value: "ok:" + oids[0] }]; }, ["1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.3.0", "1.3.6.1.2.1.1.5.0"]);
check("when the system group is partly hidden the rest is still read one by one", sys.length === 3 && sys[0] === undefined && sys[1].value.startsWith("ok:") && sys[2].value.startsWith("ok:"), JSON.stringify(calls));
let tries = [];
const t1 = await sn.readIfTable(async (oid, cols) => { tries.push(cols.length); if (cols.length > 6) throw denied(); return { 1: { 2: "eth0" } }; }, "1.3.6.1.2.1.2.2", "h", 161, "2c");
check("a device that only allows some interface columns gets a smaller request", t1[1][2] === "eth0" && tries.join() === "8,6", tries.join());
let msg = null; try { await sn.readIfTable(async () => { throw denied(); }, "1.3.6.1.2.1.2.2", "10.0.0.5", 161, "3"); } catch (e) { msg = e.message; }
check("a device that hides the whole interface list is explained, with what to allow and what to use instead", /accepted the SNMP login but refuses to show its interface list/.test(msg ?? "") && /SNMPv3 user/.test(msg ?? "") && /1\.3\.6\.1\.2\.1\.2/.test(msg ?? "") && /Network checks/.test(msg ?? ""), msg);
let other = null; try { await sn.readIfTable(async () => { throw new Error("Request timed out"); }, "x", "h", 161, "2c"); } catch (e) { other = e.message; }
check("other errors are passed through untouched", other === "Request timed out");

// ---- what anonymous viewers may see ----
const { redactState } = await import(ROOT + "/packages/core/dist/redact.js");
const red = redactState({ instanceId: "N", moduleId: "netcheck", status: "connected", enabled: true, error: null, data: d });
check("anonymous viewers see check names and results but not the addresses", red.data.targets.every((t) => t.target === "") && red.data.targets.length === d.targets.length);
const redS = redactState({ instanceId: "S", moduleId: "snmp", status: "connected", enabled: true, error: null, data: { sysName: "fw", sysDescr: "FreeBSD 14 on secret-host", interfaces: [{ name: "igb0", alias: "WAN to ISP account 1234" }] } });
check("anonymous viewers do not see device descriptions or interface labels", redS.data.sysDescr === null && redS.data.interfaces[0].alias === null && redS.data.interfaces[0].name === "igb0");

// ---- SNMP --------------------------------------------------------------------------------------------------------------
check("counter maths: normal, wrapped and reset", sn.rate(1000n, 3000n, 2, 64) === 8000 && Math.round(sn.rate(4294967000n, 500n, 1, 32)) === Math.round(((500 + 296) * 8)) && sn.rate(undefined, 10n, 1, 64) === null && sn.rate(10n, 11n, 0.1, 64) === null);
check("64-bit counters in buffers are read", sn.counter(Buffer.from([0, 0, 0, 0, 0, 0, 3, 232])) === 1000n && sn.counter(5) === 5n && sn.counter("x") === null);

const snmp = createRequire(ROOT + "/packages/modules/snmp/")("net-snmp");
const SPORT = 16177;
const agent = snmp.createAgent({ port: SPORT, address: "127.0.0.1" }, () => undefined);
agent.getAuthorizer().addCommunity("lab");
const mib = agent.getMib();
const col = (n, name, type) => ({ number: n, name, type, maxAccess: snmp.MaxAccess["read-only"] });
mib.registerProvider({ name: "ifEntry", type: snmp.MibProviderType.Table, oid: "1.3.6.1.2.1.2.2.1", maxAccess: snmp.MaxAccess["not-accessible"],
  tableColumns: [col(1, "ifIndex", snmp.ObjectType.Integer), col(2, "ifDescr", snmp.ObjectType.OctetString), col(3, "ifType", snmp.ObjectType.Integer), col(5, "ifSpeed", snmp.ObjectType.Gauge), col(8, "ifOperStatus", snmp.ObjectType.Integer), col(10, "ifInOctets", snmp.ObjectType.Counter), col(14, "ifInErrors", snmp.ObjectType.Counter), col(16, "ifOutOctets", snmp.ObjectType.Counter), col(20, "ifOutErrors", snmp.ObjectType.Counter)],
  tableIndex: [{ columnName: "ifIndex" }] });
mib.registerProvider({ name: "ifXEntry", type: snmp.MibProviderType.Table, oid: "1.3.6.1.2.1.31.1.1.1", maxAccess: snmp.MaxAccess["not-accessible"],
  tableColumns: [col(99, "ifIndex", snmp.ObjectType.Integer), col(1, "ifName", snmp.ObjectType.OctetString), col(6, "ifHCInOctets", snmp.ObjectType.Counter64), col(10, "ifHCOutOctets", snmp.ObjectType.Counter64), col(15, "ifHighSpeed", snmp.ObjectType.Gauge), col(18, "ifAlias", snmp.ObjectType.OctetString)],
  tableIndex: [{ columnName: "ifIndex" }] });
const be = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const rows = [[1, "igb0", 6, 0, 1, "WAN", 1000], [2, "igb1", 6, 0, 1, "LAN", 1000], [3, "igb2", 6, 0, 2, "", 1000], [4, "lo0", 24, 0, 1, "", 0]];
for (const [i, name, type, , oper, alias, speed] of rows) {
  mib.addTableRow("ifEntry", [i, name, type, 0, oper, 0, 0, 0, 0]);
  mib.addTableRow("ifXEntry", [i, name, be(0), be(0), speed, alias]);
}
mib.registerProvider({ name: "sysName", type: snmp.MibProviderType.Scalar, oid: "1.3.6.1.2.1.1.5", scalarType: snmp.ObjectType.OctetString, maxAccess: snmp.MaxAccess["read-only"] });
mib.setScalarValue("sysName", "fw-office");
mib.registerProvider({ name: "sysDescr", type: snmp.MibProviderType.Scalar, oid: "1.3.6.1.2.1.1.1", scalarType: snmp.ObjectType.OctetString, maxAccess: snmp.MaxAccess["read-only"] });
mib.setScalarValue("sysDescr", "FreeBSD fake firewall");
mib.registerProvider({ name: "sysUpTime", type: snmp.MibProviderType.Scalar, oid: "1.3.6.1.2.1.1.3", scalarType: snmp.ObjectType.TimeTicks, maxAccess: snmp.MaxAccess["read-only"] });
mib.setScalarValue("sysUpTime", 8640000);

const sc2 = sn.default.configSchema;
check("SNMP settings are validated", !sc2.safeParse({ host: "x" }).success && !sc2.safeParse({ host: "x", version: "3", user: "u", authKey: "short" }).success && sc2.safeParse({ host: "x", community: "lab" }).success);
const snp = await sn.default.create(sc2.parse({ host: "127.0.0.1", port: SPORT, community: "lab", watch: "igb0, igb2, nope" }), { log });
let a = await snp.poll();
check("device name, description and uptime are read", a.sysName === "fw-office" && /FreeBSD/.test(a.sysDescr) && a.uptimeS === 86400, JSON.stringify([a.sysName, a.sysDescr, a.uptimeS]));
check("interfaces are listed, loopback hidden, unused down ports counted", a.interfaces.map((i) => i.name).join() === "igb0,igb2,igb1" && a.interfaces.find((i) => i.name === "igb0").alias === "WAN" && a.interfaces.find((i) => i.name === "igb0").speedMbps === 1000 && a.hiddenDown === 0, a.interfaces.map((i) => i.name).join());
check("the first poll has no rates yet (needs two readings)", a.interfaces.every((i) => i.inBps === null));
mib.deleteTableRow("ifXEntry", [1]);
mib.addTableRow("ifXEntry", [1, "igb0", be(12_500_000), be(1_250_000), 1000, "WAN"]);   // 12.5 MB in, 1.25 MB out since the first poll
await sleep(1200);
a = await snp.poll();
const w = a.interfaces.find((i) => i.name === "igb0");
check("traffic rates are worked out from the counters", w.inBps > 5e6 && w.inBps < 1.1e8 && w.outBps > 0 && w.outBps < w.inBps, `${Math.round(w.inBps)} / ${Math.round(w.outBps)} bit/s`);
const al2 = snp.alerts(a);
check("a watched link that is down raises a critical alert", al2.some((x) => x.key === "if-down:igb2" && x.severity === "critical"));
check("a watched name the device does not have raises a warning", al2.some((x) => x.key === "if-missing:nope"));
check("an up link that is not watched raises nothing", !al2.some((x) => /igb1/.test(x.key)));
const mm = snp.metrics(a);
check("traffic is recorded per link and in total", typeof mm["if:igb0:in"] === "number" && mm["traffic:in"] > 0, JSON.stringify(mm).slice(0, 140));
await snp.dispose?.();
const bad = await sn.default.create(sc2.parse({ host: "127.0.0.1", port: SPORT, community: "wrong" }), { log });
let err = null; try { await bad.poll(); } catch (e) { err = e.message; }
check("a wrong community gives a readable error", /No answer|community|Check/i.test(err ?? ""), err);
await bad.dispose?.();
// "nothing listening" versus "ignored"
const closedPort = await new Promise((r) => { const d = createRequire(import.meta.url)("node:dgram").createSocket("udp4"); d.bind(0, "127.0.0.1", () => { const x = d.address().port; d.close(() => r(x)); }); });
check("a port with nothing behind it is recognised as closed", (await sn.probeUdpPort("127.0.0.1", closedPort)) === "closed");
check("a port that is answered by nobody in particular is not mistaken for closed", (await sn.probeUdpPort("127.0.0.1", SPORT)) === "silent");
const noSnmp = await sn.default.create(sc2.parse({ host: "127.0.0.1", port: closedPort, community: "lab" }), { log });
let err2 = null; try { await noSnmp.poll(); } catch (e) { err2 = e.message; }
check("the card says SNMP is not running when nothing listens", /Nothing is listening for SNMP/.test(err2 ?? ""), err2);
check("a wrong community is explained as such", /community is wrong/.test(err ?? ""), err);
await noSnmp.dispose?.();

// ---- the SNMP settings test (an EAP-style v3 device: md5, no encryption) ----
agent.getAuthorizer().addUser({ name: "eap", level: snmp.SecurityLevel.authNoPriv, authProtocol: snmp.AuthProtocols.md5, authKey: "authpass1234" });
const v3cfg = sc2.parse({ host: "127.0.0.1", port: SPORT, version: "3", user: "eap", authProtocol: "sha", authKey: "authpass1234", privProtocol: "aes", privKey: "privpass1234" });
const probeAction = (await sn.default.create(v3cfg, { log })).actions.find((a) => a.id === "probe");
check("the probe is an admin-only action", probeAction && probeAction.minRole === "admin");
const pr = await sn.probeSettings(v3cfg);
check("the test finds the combination the device accepts (md5, no encryption) although Lumina was set to sha + aes", pr.working === "authentication md5, no encryption" && /exactly that/.test(pr.hint), pr.working);
check("and says plainly what did not work", pr.results.length === 6 && pr.results.filter((x) => !x.ok).length === 5 && pr.results.every((x) => x.message.length > 0));
const des = pr.results.find((x) => /des/.test(x.setting) && /md5/.test(x.setting));
check("DES is either tried or explained (Node needs --openssl-legacy-provider for it)", des.ok || /DES encryption is not available/.test(des.message) || /no answer/.test(des.message), des.message);
const wrong = await sn.probeSettings({ ...v3cfg, authKey: "definitely-wrong-key" });
check("with wrong keys nothing is accepted and the hint says what to check", wrong.working === null && /user name, the authentication key/.test(wrong.hint), wrong.hint);
check("a version 2c probe tries the community as entered", (await sn.probeSettings(sc2.parse({ host: "127.0.0.1", port: SPORT, community: "lab" }))).working === "version 2c with this community");
check("the DES problem is explained for people", /Choose AES/.test(sn.explainCrypto("error:0308010C:digital envelope routines::unsupported")) && sn.explainCrypto("something else") === "something else");


tcp.close(); web.close();
process.exit(ok ? 0 : 1);
