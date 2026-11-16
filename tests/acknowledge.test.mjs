// "I know, I'm on it": an acknowledged alert is skipped by the daily reminder, stays listed, and is still announced as fixed.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
const { AlertEngine } = await import(ROOT + "/packages/core/dist/alerts.js");
const { persisting } = await import(ROOT + "/packages/core/dist/email.js");
let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };

let id = 0; const sent = []; const kv = {};
const store = {
  events: { firing: () => [], insert: () => ++id, resolve() {}, setNotified() {} },
  settings: { get: (k, d) => (k in kv ? kv[k] : d), set: (k, v) => { kv[k] = v; } },
};
const engine = new AlertEngine(store, { emit() {} }, async (n) => { sent.push(n); }, () => ({ confirmPolls: 1, muted: [] }));
const cond = (key) => ({ key, severity: "critical", title: `${key} is bad` });
await engine.evaluate("Prox-1", { conditions: [cond("a"), cond("b")], down: false, error: null });

const DAY = 86400_000;
const later = Date.now() + 2 * DAY;
check("both are due for a reminder a day or two later", persisting(engine.active(), "info", later).length === 2);

check("acknowledging an alert that is not there says so", engine.acknowledge("Prox-1", "nope", "dan", null) === false);
check("acknowledge for 4 hours", engine.acknowledge("Prox-1", "a", "dan", 4 * 3600) === true);
const a = engine.active().find((x) => x.key === "a");
check("it stays listed with who and until when", a && a.acknowledged?.by === "dan" && a.acknowledged.until > Date.now() / 1000);
check("the other one is untouched", engine.active().find((x) => x.key === "b").acknowledged === null);
check("the reminder skips only the acknowledged one", persisting(engine.active(), "info", later).map((x) => x.key).join() === "b");

check("an acknowledgement never changes the stored alert", engine.active().length === 2 && sent.length === 1);
check("undo brings the reminder back", engine.unacknowledge("Prox-1", "a") && persisting(engine.active(), "info", later).length === 2);

engine.acknowledge("Prox-1", "a", "dan", null);
check("'until fixed' has no end", engine.active().find((x) => x.key === "a").acknowledged.until === null);

// expiry
kv.acks = Object.fromEntries(Object.entries(kv.acks).map(([k, v]) => [k, { ...v, until: Math.floor(Date.now() / 1000) - 5 }]));
check("an expired acknowledgement stops counting", engine.active().find((x) => x.key === "a").acknowledged === null);
check("and is removed from storage", Object.keys(kv.acks).length === 0);

// fixed: still announced, and no leftover
engine.acknowledge("Prox-1", "a", "dan", null);
sent.length = 0;
await engine.evaluate("Prox-1", { conditions: [cond("b")], down: false, error: null });
check("fixing an acknowledged problem is still announced", sent.length === 1 && sent[0].resolved === true);
engine.active();
check("and the acknowledgement is cleaned away", Object.keys(kv.acks).length === 0);
process.exit(ok ? 0 : 1);
