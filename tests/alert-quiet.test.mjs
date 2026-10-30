// Switching a check off closes its alerts without a "fixed" message for each, and touches nothing else.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
const { AlertEngine } = await import(ROOT + "/packages/core/dist/alerts.js");
let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };

let id = 0; const resolved = []; const sent = [];
const store = { events: { firing: () => [], insert: () => ++id, resolve: (i) => resolved.push(i), setNotified() {} } };
const engine = new AlertEngine(store, { emit() {} }, async (n) => { sent.push(n); }, () => ({ confirmPolls: 1, muted: [] }));
const c = (key, title) => ({ key, severity: "warning", title });
const stale = [c("backup-stale:101", "a has no recent backup"), c("backup-stale:102", "b has no recent backup"), c("backup-missing:103", "c has no backup"), c("drive:x", "Drive x is hot")];
await engine.evaluate("Dev-PVE", { conditions: stale, down: false, error: null });
await engine.evaluate("Prod-PVE", { conditions: [c("backup-stale:101", "a has no recent backup")], down: false, error: null });
check("everything is raised first", engine.active().length === 5 && sent.length === 2);

sent.length = 0;
engine.closeQuietly("Dev-PVE", ["backup-stale:", "backup-missing:"]);
check("the backup alerts of that server are gone", engine.forInstance("Dev-PVE").map((a) => a.key).join() === "drive:x", engine.forInstance("Dev-PVE").map((a) => a.key).join());
check("the other server keeps its own backup alert, even with the same key", engine.forInstance("Prod-PVE").length === 1);
check("nobody is told they were fixed", sent.length === 0);

await engine.evaluate("Dev-PVE", { conditions: [c("drive:x", "Drive x is hot")], down: false, error: null });
check("and the next check does not announce them either", sent.length === 0 && engine.active().length === 2);
process.exit(ok ? 0 : 1);
