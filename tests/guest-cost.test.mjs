import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
const { openDb } = await import(ROOT + "/packages/core/dist/db.js");
const { computeEnergy, defaultEnergySettings, EnergySettingsSchema } = await import(ROOT + "/packages/core/dist/energy.js");
const store = openDb(":memory:");
const t0 = Date.UTC(2026, 8, 1, 0, 0) / 1000;
const rows = [], g = [];
for (let i = 0; i < 8; i++) {
  const ts = t0 + i * 1800;
  rows.push({ sourceKey: "power:ilo", ts, avg: 200, peak: 200, min: 200, samples: 30 });
  g.push({ instanceId: "pve", vmid: 101, ts, cores: 1 }, { instanceId: "pve", vmid: 102, ts, cores: 0 });
  if (i < 4) g.push({ instanceId: "pve", vmid: 103, ts, cores: 1 });
}
store.energy.upsert(rows); store.energy.upsertGuests(g);
const s = EnergySettingsSchema.parse({ timezone: "UTC", tariff: { type: "flat", flat: { price: 1000 } }, taxPercent: 10, gapFill: "off" });
const r = computeEnergy(store, s, "custom", null, Date.UTC(2026, 8, 2, 12) / 1000, { from: "2026-09-01", to: "2026-09-01" });
let ok = true; const check = (n, a, b) => { const p = Math.abs(a - b) < 1e-6; if (!p) ok = false; console.log(p ? "PASS" : "FAIL", n, a, b); };
const by = Object.fromEntries(r.guests.list.map((x) => [x.vmid, x]));
check("server kWh", r.guests.serverKwh, 0.8);
check("A kWh", by[101].kwh, 0.42); check("B kWh", by[102].kwh, 0.15); check("C kWh", by[103].kwh, 0.15);
check("host kWh", r.guests.hostKwh, 0.08);
check("A cost with 10% tax", by[101].cost, 0.42 * 1000 * 1.1);
check("C hours", by[103].hoursRunning, 2);
check("sum = server", r.guests.list.reduce((a, x) => a + x.kwh, 0) + r.guests.hostKwh, 0.8);
check("coverage", r.guests.coverage, 1);
const r2 = computeEnergy(store, s, "custom", null, Date.UTC(2026, 8, 2, 12) / 1000, { from: "2026-08-31", to: "2026-08-31" });
console.log(r2.guests === null || r2.kwh === 0 ? "PASS empty day has no guest split" : "FAIL empty day");
process.exit(ok ? 0 : 1);
