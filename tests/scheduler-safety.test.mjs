// A scheduled shutdown or restart is never run late after Lumina was restarting; a harmless one still is; both are announced.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
const { Scheduler } = await import(ROOT + "/packages/core/dist/scheduler.js");
let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };

function rig(actionDangerous) {
  const ran = [], told = [], recorded = [], audited = [];
  const row = (id, at) => ({ id, name: `job ${id}`, instanceId: "Prox-X", actionId: "shutdown", input: {}, repeat: "daily", atTs: at, enabled: true, lastRunTs: null });
  const store = { schedules: { list: () => rig.rows, recordRun: (id, at, status, msg) => recorded.push({ id, status, msg }) }, audit: { add: (...a) => audited.push(a[1]) } };
  const registry = { actionInfo: () => ({ id: "shutdown", label: "Shut down (graceful)", schedulable: true, dangerous: actionDangerous }), runAction: async () => { ran.push(1); return { sent: true }; } };
  const s = new Scheduler(store, registry, async (n) => { told.push(n); }, { warn() {}, info() {} });
  return { s, ran, told, recorded, audited, row };
}
const now = Math.floor(Date.now() / 1000);

let r = rig(true);
rig.rows = [r.row(1, now - 600)];
await r.s.tick(now);
check("a dangerous action that is 10 minutes late (Lumina was restarting) is not run", r.ran.length === 0 && r.recorded[0]?.status === "missed", JSON.stringify(r.recorded));
check("it is skipped on purpose, and a warning says so", r.told.some((n) => /Scheduled action skipped/.test(n.title) && n.severity === "warning") && r.audited.includes("scheduled-action-skipped"));

r = rig(true);
rig.rows = [r.row(2, now - 40)];
await r.s.tick(now);
check("one that is only seconds late (normal timing) still runs", r.ran.length === 1 && r.recorded[0]?.status === "ok");
check("and is announced as it starts", r.told.length === 1 && /Scheduled action starting/.test(r.told[0].title));

r = rig(false);
rig.rows = [r.row(3, now - 600)];
await r.s.tick(now);
check("a harmless action (a snapshot) that is 10 minutes late still runs, as before", r.ran.length === 1 && r.recorded[0]?.status === "ok" && r.told.length === 0);

r = rig(false);
rig.rows = [r.row(4, now - 3 * 3600)];
await r.s.tick(now);
check("and one that is hours late is skipped, as before", r.ran.length === 0 && r.recorded[0]?.status === "missed");
process.exit(ok ? 0 : 1);
