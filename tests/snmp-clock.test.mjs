// SNMPv3 after a device restart: the device's clock no longer matches the session's, so a fresh session must be started once, and only for that error.
import { fileURLToPath as __f } from "node:url";
import { createRequire } from "node:module";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
const snmp = createRequire(ROOT + "/packages/modules/snmp/")("net-snmp");
const { openSession, isStaleClock } = await import(ROOT + "/packages/modules/snmp/dist/index.js");

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const STALE = "Message with engineBoots '1' and engineTime '32026' is outside the time window of engineBoots '1' and engineTime '102931'";
const cfg = (version) => ({ host: "192.0.2.1", port: 161, version, community: "public", user: "u", authProtocol: "sha", authKey: "authkey1234", privProtocol: "aes", privKey: "privkey1234" });

const made = [];
let plan = () => null;
const fake = () => {
  const n = made.length;
  const s = { n, closed: false, on() {}, close() { s.closed = true; }, get(_o, cb) { const e = plan(n); e ? cb(new Error(e)) : cb(null, [{ value: "answer" }]); }, tableColumns(_o, _c, _m, cb) { const e = plan(n); e ? cb(new Error(e)) : cb(null, { 1: {} }); } };
  made.push(s);
  return s;
};
const v3 = snmp.createV3Session, v2 = snmp.createSession;
snmp.createV3Session = fake; snmp.createSession = fake;
const reset = (p) => { made.length = 0; plan = p; };

check("the stale-clock message is recognised, ordinary errors are not", isStaleClock(new Error(STALE)) && isStaleClock(new Error("usmNotInTimeWindow")) && !isStaleClock(new Error("Request timed out")) && !isStaleClock(new Error("Unknown user name")));

reset((n) => (n === 0 ? STALE : null));
let dev = openSession(cfg("3"));
let r = await dev.get(["1.3.6.1.2.1.1.1.0"]);
check("a stale clock starts a new session and the question is asked again", r[0].value === "answer" && made.length === 2 && made[0].closed && !made[1].closed);
r = await dev.get(["1.3.6.1.2.1.1.1.0"]);
check("the new session is kept for the next questions", made.length === 2 && r[0].value === "answer");
const t = await dev.table("1.3.6.1.2.1.2.2.1", [1]);
check("tables recover the same way", !!t);

reset((n) => (n === 0 ? STALE : null));
dev = openSession(cfg("3"));
await dev.table("1.3.6.1.2.1.2.2.1", [1]);
check("a table read after a restart gets a new session too", made.length === 2);

reset(() => STALE);
dev = openSession(cfg("3"));
let e = null; try { await dev.get(["1.3"]); } catch (x) { e = x.message; }
check("when a new session does not help the error is reported, after one retry only", /time window/.test(e ?? "") && made.length === 2, `${made.length} sessions`);

reset(() => "Request timed out");
dev = openSession(cfg("3"));
e = null; try { await dev.get(["1.3"]); } catch (x) { e = x.message; }
check("a plain timeout does not start new sessions", /timed out/.test(e ?? "") && made.length === 1);

reset(() => STALE);
dev = openSession(cfg("2c"));
e = null; try { await dev.get(["1.3"]); } catch (x) { e = x.message; }
check("version 2c has no clock, so it is never retried", made.length === 1);

dev.close();
check("close closes the session in use", made[0].closed === true);
snmp.createV3Session = v3; snmp.createSession = v2;
process.exit(ok ? 0 : 1);
