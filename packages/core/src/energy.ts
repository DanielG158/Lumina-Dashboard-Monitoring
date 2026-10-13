import { z } from "zod";
import type { Store } from "./db.js";

/** Metric keys that carry watts: the UPS (whole rack) and iLO (the server alone). */
const ENERGY_KEYS = ["watts", "power"] as const;
const BUCKET = 1800;
const nowS = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------------------------------------------------
// Settings

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

export const EnergySettingsSchema = z
  .object({
    /** "auto" prefers the UPS (it sees the whole rack), otherwise the iLO. Or a specific source key such as "power:iLO4-Homelab". */
    source: z.string().max(120).default("auto"),
    /** Multiplies the measured watts, to correct a meter that reads high or low. */
    calibration: z.number().min(0.1).max(10).default(1),
    /** Added to every reading: equipment Lumina cannot see (a switch, a PC) or the UPS's own losses. */
    extraWatts: z.number().min(0).max(100000).default(0),
    /** Periods with no readings (Lumina or the device was offline). "estimate" fills them with the typical power for that hour of day, and reports them as estimated. */
    gapFill: z.enum(["estimate", "off"]).default("estimate"),
    /** Gaps longer than this many hours are left empty: the equipment was probably off. */
    gapFillMaxHours: z.number().min(1).max(720).default(48),
    /** null = use the viewer's browser time zone (the UI saves it the first time an admin opens the page). */
    timezone: z.string().max(60).nullable().default(null),
    billingDay: z.number().int().min(1).max(28).default(1),
    /** How the server's electricity is divided between its virtual machines and containers. */
    guestSplit: z
      .object({
        /** Part of each guest's share that is the same for every running guest (RAM, idle CPU); the rest follows how much CPU each one used. */
        baselinePct: z.number().min(0).max(100).default(50),
        /** Part of the server's power kept for the Proxmox host itself instead of the guests. */
        hostPct: z.number().min(0).max(100).default(10),
      })
      .default({}),
    fixedMonthly: z.number().min(0).max(1e12).default(0),
    taxPercent: z.number().min(0).max(100).default(0),
    budgetMonthly: z.number().min(0).max(1e12).nullable().default(null),
    currency: z
      .object({
        symbol: z.string().max(8).default("Rp"),
        code: z.string().max(8).default("IDR"),
        locale: z.string().max(20).default("id-ID"),
        decimals: z.number().int().min(0).max(4).default(0),
        position: z.enum(["before", "after"]).default("before"),
      })
      .default({}),
    tariff: z
      .object({
        type: z.enum(["flat", "tou", "tiered"]).default("flat"),
        flat: z.object({ price: z.number().min(0).max(1e9) }).default({ price: 1661 }),
        tou: z
          .object({
            defaultPrice: z.number().min(0).max(1e9),
            rules: z
              .array(z.object({ name: z.string().max(40), days: z.array(z.number().int().min(0).max(6)).min(1), start: HHMM, end: HHMM, price: z.number().min(0).max(1e9) }))
              .max(12),
          })
          .default({ defaultPrice: 1661, rules: [] }),
        tiers: z.array(z.object({ upToKwh: z.number().positive().max(1e9).nullable(), price: z.number().min(0).max(1e9) })).min(1).max(8).default([{ upToKwh: null, price: 1661 }]),
      })
      .default({}),
  })
  .superRefine((s, ctx) => {
    for (const [path, value] of [["timezone", s.timezone]] as const) {
      if (value === null) continue;
      try { new Intl.DateTimeFormat("en", { timeZone: value }); } catch { ctx.addIssue({ code: "custom", path: [path], message: "Unknown time zone" }); }
    }
    try { new Intl.NumberFormat(s.currency.locale); } catch { ctx.addIssue({ code: "custom", path: ["currency", "locale"], message: "Unknown locale" }); }
    const tiers = s.tariff.tiers;
    tiers.forEach((t, i) => {
      const last = i === tiers.length - 1;
      if (last && t.upToKwh !== null) ctx.addIssue({ code: "custom", path: ["tariff", "tiers", i, "upToKwh"], message: "The last block must have no upper limit" });
      if (!last && t.upToKwh === null) ctx.addIssue({ code: "custom", path: ["tariff", "tiers", i, "upToKwh"], message: "Only the last block can be unlimited" });
      if (!last && i > 0 && t.upToKwh !== null && tiers[i - 1].upToKwh !== null && t.upToKwh <= (tiers[i - 1].upToKwh as number)) {
        ctx.addIssue({ code: "custom", path: ["tariff", "tiers", i, "upToKwh"], message: "Blocks must increase" });
      }
    });
  });

export type EnergySettings = z.infer<typeof EnergySettingsSchema>;
export const defaultEnergySettings = (): EnergySettings => EnergySettingsSchema.parse({});

export function loadEnergySettings(store: Store): EnergySettings {
  const parsed = EnergySettingsSchema.safeParse(store.settings.get("energy", {}));
  return parsed.success ? parsed.data : defaultEnergySettings();
}

// ---------------------------------------------------------------------------------------------------------------------
// Sources and roll-up

export interface EnergySource {
  key: string;
  kind: "ups" | "server";
  instanceId: string;
  label: string;
  first: number;
  last: number;
}

export function listSources(store: Store): EnergySource[] {
  return store.energy.sources().map((s) => {
    const [metric, ...rest] = s.source_key.split(":");
    const instanceId = rest.join(":");
    const kind = metric === "watts" ? "ups" : "server";
    return { key: s.source_key, kind, instanceId, label: kind === "ups" ? `${instanceId} (UPS, whole rack)` : `${instanceId} (server only)`, first: s.first, last: s.last };
  });
}

export function resolveSource(store: Store, settings: EnergySettings, now = nowS()): EnergySource | null {
  const all = listSources(store);
  if (settings.source !== "auto") return all.find((s) => s.key === settings.source) ?? null;
  const fresh = all.filter((s) => s.last > now - 2 * 86400);
  return fresh.find((s) => s.kind === "ups") ?? fresh.find((s) => s.kind === "server") ?? all[0] ?? null;
}

/** Folds the minute-by-minute samples into 30-minute slots. Safe to repeat. `since` = 0 rebuilds everything that still exists. */
export function rollupEnergy(store: Store, since: number) {
  for (const key of ENERGY_KEYS) {
    for (const instanceId of store.metrics.instancesWithKey(key)) {
      const rows = store.metrics.aggregate(instanceId, key, since, BUCKET).map((r) => ({ sourceKey: `${key}:${instanceId}`, ts: r.t, avg: r.avg, peak: r.max, min: r.min, samples: r.n }));
      if (rows.length) store.energy.upsert(rows);
    }
  }
  for (const instanceId of store.metrics.instancesWithKeyLike("gcpu:%")) {
    for (const key of store.metrics.keysLike(instanceId, "gcpu:%")) {
      const vmid = Number(key.slice(5));
      if (!Number.isInteger(vmid)) continue;
      const rows = store.metrics.aggregate(instanceId, key, since, BUCKET).map((r) => ({ instanceId, vmid, ts: r.t, cores: r.avg }));
      if (rows.length) store.energy.upsertGuests(rows);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Time zones

const formatters = new Map<string, Intl.DateTimeFormat>();
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface Zoned {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  dow: number;
  /** seconds to add to UTC to get local time */
  offset: number;
}

export function zoned(tz: string, ts: number): Zoned {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
    formatters.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ts * 1000))) p[part.type] = part.value;
  const y = Number(p.year), m = Number(p.month), d = Number(p.day), h = Number(p.hour), mi = Number(p.minute);
  const offset = Math.round(Date.UTC(y, m - 1, d, h, mi) / 1000) - Math.floor(ts / 60) * 60;
  return { y, m, d, h, mi, dow: DOW[p.weekday] ?? 0, offset };
}

const dayKey = (z: Zoned) => `${z.y}-${String(z.m).padStart(2, "0")}-${String(z.d).padStart(2, "0")}`;

/** Epoch of 00:00 local on the day containing `ts`. */
export function startOfDay(tz: string, ts: number): number {
  const z = zoned(tz, ts);
  return Math.round(Date.UTC(z.y, z.m - 1, z.d) / 1000) - z.offset;
}

/** Start of the billing cycle containing `ts` (cycles begin on `billingDay` of each month, local time). */
export function cycleStart(tz: string, ts: number, billingDay: number): number {
  const z = zoned(tz, ts);
  const month = z.d >= billingDay ? z.m : z.m - 1;
  return Math.round(Date.UTC(z.y, month - 1, billingDay) / 1000) - z.offset;
}

export function nextCycleStart(tz: string, start: number, billingDay: number): number {
  const z = zoned(tz, start + 3600);
  return Math.round(Date.UTC(z.y, z.m, billingDay) / 1000) - z.offset;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pricing

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function touPrice(s: EnergySettings, z: Zoned): number {
  const minute = z.h * 60 + z.mi;
  for (const r of s.tariff.tou.rules) {
    const a = toMin(r.start), b = toMin(r.end);
    // A rule that crosses midnight (start later than end) belongs to the day it starts on.
    const hit = a <= b ? r.days.includes(z.dow) && minute >= a && minute < b : (r.days.includes(z.dow) && minute >= a) || (r.days.includes((z.dow + 6) % 7) && minute < b);
    if (hit) return r.price;
  }
  return s.tariff.tou.defaultPrice;
}

/** Cost of adding `add` kWh to a billing cycle that already used `before` kWh, using progressive blocks. */
export function tierMarginal(before: number, add: number, tiers: EnergySettings["tariff"]["tiers"]): number {
  let cost = 0, from = before, left = add, floor = 0;
  for (const t of tiers) {
    const top = t.upToKwh ?? Infinity;
    if (from < top && left > 0) {
      const room = Math.min(left, top - Math.max(from, floor));
      if (room > 0) { cost += room * t.price; left -= room; from += room; }
    }
    floor = top;
  }
  return cost;
}

export interface Money {
  energy: number;
  fixed: number;
  tax: number;
  total: number;
}

export interface SeriesPoint {
  t: number;
  label: string;
  kwh: number;
  cost: number;
  avgW: number | null;
}

export interface GuestShare { instanceId: string; vmid: number; kwh: number; cost: number; avgCores: number; hoursRunning: number }
export interface GuestEnergy {
  serverKwh: number;
  serverCost: number;
  hostKwh: number;
  /** server energy in slots where no guest data was recorded (before this feature was running, or the Proxmox poll was down) */
  unattributedKwh: number;
  /** share of the server's energy for which guest data exists */
  coverage: number;
  list: GuestShare[];
}

export interface EnergyResult {
  range: string;
  from: number;
  to: number;
  timezone: string;
  source: EnergySource | null;
  sources: EnergySource[];
  currency: EnergySettings["currency"];
  tariffType: EnergySettings["tariff"]["type"];
  kwh: number;
  cost: Money;
  avgW: number | null;
  peakW: number | null;
  minW: number | null;
  /** share of the elapsed time for which power was actually measured */
  coverage: number;
  /** kWh in this result that were estimated to fill gaps with no readings */
  estimatedKwh: number;
  adjustments: { calibration: number; extraWatts: number; gapFill: string };
  granularity: "hour" | "day";
  series: SeriesPoint[];
  byHour: { hour: number; avgW: number }[];
  /** When the UPS is the source and the server is measured too: how much of the total is the server and how much is everything else on the UPS. */
  breakdown: { serverKwh: number; otherKwh: number; serverLabel: string; otherLabel: string; serverShare: number } | null;
  /** The server's share of the result divided between its guests; null when no server power or guest data exists for the period. */
  guests: GuestEnergy | null;
  /** only for billing-cycle ranges */
  projection: { kwh: number; cost: Money; avgDailyKwh: number; daysLeft: number } | null;
  budget: { amount: number; used: number; projected: number | null; usedPct: number; projectedPct: number | null } | null;
  settingsNote: string | null;
}

export const RANGE_NAMES = ["today", "yesterday", "7d", "30d", "cycle", "lastcycle", "custom"] as const;
export type RangeName = (typeof RANGE_NAMES)[number];

/** Days a custom period may span. */
export const MAX_CUSTOM_DAYS = 400;
/** A custom period of YYYY-MM-DD dates, both days included. */
export interface CustomPeriod { from: string; to: string }

/** Local midnight of a calendar date in a time zone (noon UTC falls on the same calendar date in every zone). */
function dayStartOf(tz: string, date: string, plusDays = 0): number {
  const [y, m, d] = date.split("-").map(Number);
  return startOfDay(tz, Date.UTC(y, m - 1, d + plusDays, 12) / 1000);
}

function rangeBounds(range: RangeName, tz: string, billingDay: number, now: number, custom?: CustomPeriod): { from: number; to: number } {
  const today = startOfDay(tz, now);
  switch (range) {
    case "custom": {
      if (!custom) throw new Error("A custom period needs a start and an end date");
      return { from: dayStartOf(tz, custom.from), to: dayStartOf(tz, custom.to, 1) };
    }
    case "today": return { from: today, to: today + 86400 };
    case "yesterday": return { from: today - 86400, to: today };
    case "7d": return { from: today - 6 * 86400, to: today + 86400 };
    case "30d": return { from: today - 29 * 86400, to: today + 86400 };
    case "cycle": { const a = cycleStart(tz, now, billingDay); return { from: a, to: nextCycleStart(tz, a, billingDay) }; }
    case "lastcycle": { const b = cycleStart(tz, now, billingDay); return { from: cycleStart(tz, b - 3600, billingDay), to: b }; }
  }
}

interface Priced {
  ts: number;
  kwh: number;
  cost: number;
  avg: number;
  peak: number;
  min: number;
  z: Zoned;
  estimated: boolean;
}

type RawBucket = { ts: number; avg: number; peak: number; min: number; samples: number; estimated?: boolean };

/** Adds estimated slots for stretches with no readings, using the typical power for that local hour of day. */
function withGaps(store: Store, s: EnergySettings, sourceKey: string, real: RawBucket[], from: number, to: number, now: number): RawBucket[] {
  if (s.gapFill === "off") return real;
  const tz = s.timezone ?? "UTC";
  const src = store.energy.sources().find((x) => x.source_key === sourceKey);
  if (!src) return real;
  const maxSlots = Math.round((s.gapFillMaxHours * 3600) / BUCKET);
  // The stretch before the very first reading counts as a gap too, but only when it is short enough to be believable.
  const fromSlot = Math.ceil(from / BUCKET) * BUCKET;
  const leadingSlots = Math.max(0, (src.first - fromSlot) / BUCKET);
  const lo = leadingSlots > 0 && leadingSlots <= maxSlots ? fromSlot : Math.max(fromSlot, src.first);
  const hi = Math.min(to, Math.floor(now / BUCKET) * BUCKET);
  if (hi <= lo) return real;

  const recent = store.energy.buckets(sourceKey, now - 14 * 86400, now);
  if (recent.length === 0) return real;
  const profile = new Map<number, { w: number; n: number }>();
  let all = 0;
  for (const b of recent) {
    const h = zoned(tz, b.ts).h;
    const p = profile.get(h) ?? { w: 0, n: 0 };
    p.w += b.avg; p.n += 1; profile.set(h, p);
    all += b.avg;
  }
  const overall = all / recent.length;
  const have = new Set(real.map((b) => b.ts));

  // Find runs of missing slots; fill only the runs that are short enough to be an outage rather than "switched off".
  const filled: RawBucket[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length > 0 && run.length <= maxSlots) {
      for (const ts of run) {
        const p = profile.get(zoned(tz, ts).h);
        const avg = p ? p.w / p.n : overall;
        filled.push({ ts, avg, peak: avg, min: avg, samples: 0, estimated: true });
      }
    }
    run = [];
  };
  for (let ts = lo; ts < hi; ts += BUCKET) {
    if (have.has(ts)) flush(); else run.push(ts);
  }
  flush();
  return [...real, ...filled].sort((a, b) => a.ts - b.ts);
}

function price(store: Store, s: EnergySettings, sourceKey: string, loadFrom: number, to: number, now: number): Priced[] {
  const out: Priced[] = [];
  const tz = s.timezone ?? "UTC";
  let cycle = -1, cum = 0;
  for (const b of withGaps(store, s, sourceKey, store.energy.buckets(sourceKey, loadFrom, to), loadFrom, to, now)) {
    const seconds = Math.max(0, Math.min(BUCKET, now - b.ts));
    const avg = b.avg * s.calibration + s.extraWatts;
    const kwh = (avg * seconds) / 3600 / 1000;
    const z = zoned(tz, b.ts);
    let cost: number;
    if (s.tariff.type === "flat") cost = kwh * s.tariff.flat.price;
    else if (s.tariff.type === "tou") cost = kwh * touPrice(s, z);
    else {
      const c = cycleStart(tz, b.ts, s.billingDay);
      if (c !== cycle) { cycle = c; cum = 0; }
      cost = tierMarginal(cum, kwh, s.tariff.tiers);
      cum += kwh;
    }
    out.push({ ts: b.ts, kwh, cost, avg, peak: b.peak * s.calibration + s.extraWatts, min: b.min * s.calibration + s.extraWatts, z, estimated: b.estimated === true });
  }
  return out;
}

const withTax = (energy: number, fixed: number, taxPercent: number): Money => {
  const tax = ((energy + fixed) * taxPercent) / 100;
  return { energy, fixed, tax, total: energy + fixed + tax };
};

export function computeEnergy(store: Store, settings: EnergySettings, range: RangeName, tzOverride: string | null, now = nowS(), custom?: CustomPeriod): EnergyResult {
  const s: EnergySettings = { ...settings, timezone: settings.timezone ?? tzOverride ?? "UTC" };
  const tz = s.timezone as string;
  const sources = listSources(store);
  const source = resolveSource(store, s, now);
  const { from, to } = rangeBounds(range, tz, s.billingDay, now, custom);
  const isCycle = range === "cycle" || range === "lastcycle";
  const base: EnergyResult = {
    range, from, to, timezone: tz, source, sources, currency: s.currency, tariffType: s.tariff.type, kwh: 0,
    cost: withTax(0, isCycle ? s.fixedMonthly : 0, s.taxPercent), avgW: null, peakW: null, minW: null, coverage: 0,
    estimatedKwh: 0, breakdown: null, adjustments: { calibration: s.calibration, extraWatts: s.extraWatts, gapFill: s.gapFill },
    granularity: range === "today" || range === "yesterday" || (range === "custom" && to - from <= 2 * 86400 + 3600) ? "hour" : "day", series: [], byHour: [], guests: null, projection: null, budget: null, settingsNote: null,
  };
  if (!source) return { ...base, settingsNote: "No power readings yet. They appear after the UPS or iLO has reported for a few minutes." };

  const loadFrom = s.tariff.type === "tiered" ? Math.min(from, cycleStart(tz, from, s.billingDay)) : from;
  const priced = price(store, s, source.key, loadFrom, to, now);
  const inRange = priced.filter((p) => p.ts >= from);

  // Series, with empty hours/days filled in so gaps show as gaps.
  const step = base.granularity === "hour" ? 3600 : 86400;
  const slots = new Map<number, SeriesPoint & { w: number; n: number }>();
  const slotStart = (ts: number) => (base.granularity === "hour" ? Math.floor((ts - zoned(tz, ts).mi * 60 - (ts % 60)) / 1) : startOfDay(tz, ts));
  for (let t = from; t < Math.min(to, now + step); t += step) {
    const key = base.granularity === "hour" ? t : startOfDay(tz, t);
    if (!slots.has(key)) {
      const z = zoned(tz, key + 1);
      slots.set(key, { t: key, label: base.granularity === "hour" ? `${String(z.h).padStart(2, "0")}:00` : dayKey(z), kwh: 0, cost: 0, avgW: null, w: 0, n: 0 });
    }
  }
  const byHour = new Map<number, { w: number; n: number }>();
  let peak = -Infinity, min = Infinity, w = 0, n = 0, kwh = 0, energy = 0, estimatedKwh = 0, measured = 0;
  for (const p of inRange) {
    if (p.estimated) estimatedKwh += p.kwh; else measured += 1;
    const key = slotStart(p.ts);
    const slot = slots.get(key) ?? slots.get(startOfDay(tz, p.ts));
    if (slot) { slot.kwh += p.kwh; slot.cost += p.cost; slot.w += p.avg; slot.n += 1; }
    const h = byHour.get(p.z.h) ?? { w: 0, n: 0 };
    h.w += p.avg; h.n += 1; byHour.set(p.z.h, h);
    peak = Math.max(peak, p.peak); min = Math.min(min, p.min);
    w += p.avg; n += 1; kwh += p.kwh; energy += p.cost;
  }
  const series = [...slots.values()].sort((a, b) => a.t - b.t).map(({ w: sw, n: sn, ...pt }) => ({ ...pt, avgW: sn ? sw / sn : null }));
  const elapsed = Math.max(0, Math.min(to, now) - from);
  const covered = measured * BUCKET;

  const result: EnergyResult = {
    ...base,
    kwh,
    estimatedKwh,
    cost: withTax(energy, isCycle ? s.fixedMonthly : 0, s.taxPercent),
    avgW: n ? w / n : null,
    peakW: n ? peak : null,
    minW: n ? min : null,
    coverage: elapsed > 0 ? Math.min(1, covered / elapsed) : 0,
    series,
    byHour: [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([hour, v]) => ({ hour, avgW: v.w / v.n })),
  };

  const server = sources.find((x) => x.kind === "server" && x.last > now - 2 * 86400);
  if (source.kind === "ups" && server && kwh > 0) {
    const sRows = price(store, { ...s, calibration: 1, extraWatts: 0, tariff: { ...s.tariff, type: "flat" } }, server.key, from, to, now).filter((p) => p.ts >= from);
    const serverKwh = Math.min(kwh, sRows.reduce((a, p) => a + p.kwh, 0));
    result.breakdown = { serverKwh, otherKwh: kwh - serverKwh, serverLabel: server.instanceId, otherLabel: "Everything else on the UPS", serverShare: serverKwh / kwh };
  }

  if (server && kwh > 0) result.guests = splitAmongGuests(store, s, server.key, source, priced, from, to, now);

  if (range === "cycle") {
    // Estimate the rest of the cycle from the average of the last (up to) 7 full days.
    const today = startOfDay(tz, now);
    const recent = priced.filter((p) => p.ts >= Math.max(from, today - 7 * 86400) && p.ts < today);
    const days = Math.max(1, Math.min(7, Math.round((today - Math.max(from, today - 7 * 86400)) / 86400)));
    const haveRecent = recent.length > 0 && today > from;
    const avgDailyKwh = haveRecent ? recent.reduce((a, p) => a + p.kwh, 0) / days : kwh / Math.max(0.25, (now - from) / 86400);
    const avgDailyCost = haveRecent ? recent.reduce((a, p) => a + p.cost, 0) / days : energy / Math.max(0.25, (now - from) / 86400);
    const daysLeft = Math.max(0, (to - now) / 86400);
    const projKwh = kwh + avgDailyKwh * daysLeft;
    const projEnergy = s.tariff.type === "tiered" ? tierMarginal(0, projKwh, s.tariff.tiers) : energy + avgDailyCost * daysLeft;
    const projCost = withTax(projEnergy, s.fixedMonthly, s.taxPercent);
    result.projection = { kwh: projKwh, cost: projCost, avgDailyKwh, daysLeft };
    if (s.budgetMonthly !== null && s.budgetMonthly > 0) {
      result.budget = { amount: s.budgetMonthly, used: result.cost.total, projected: projCost.total, usedPct: (result.cost.total / s.budgetMonthly) * 100, projectedPct: (projCost.total / s.budgetMonthly) * 100 };
    }
  }
  if (range === "lastcycle" && s.budgetMonthly) result.budget = { amount: s.budgetMonthly, used: result.cost.total, projected: null, usedPct: (result.cost.total / s.budgetMonthly) * 100, projectedPct: null };
  return result;
}

/** Divides the server's measured electricity between the guests that were running in each 30-minute slot. */
function splitAmongGuests(store: Store, s: EnergySettings, serverKey: string, main: EnergySource, mainPriced: Priced[], from: number, to: number, now: number): GuestEnergy | null {
  // The server's own readings; when the server is the chosen source its calibration applies, otherwise the raw reading is used.
  const own = main.key === serverKey;
  const rows = price(store, { ...s, calibration: own ? s.calibration : 1, extraWatts: own ? s.extraWatts : 0, tariff: { ...s.tariff, type: "flat" } }, serverKey, from, to, now).filter((p) => p.ts >= from && !p.estimated);
  if (rows.length === 0) return null;
  // Price per kWh in each slot (so time-of-day and progressive tariffs carry over), including tax.
  const perKwh = new Map<number, number>();
  let totalKwh = 0, totalCost = 0;
  for (const p of mainPriced) if (p.ts >= from && p.kwh > 0) { perKwh.set(p.ts, p.cost / p.kwh); totalKwh += p.kwh; totalCost += p.cost; }
  const fallback = totalKwh > 0 ? totalCost / totalKwh : 0;
  const taxK = 1 + s.taxPercent / 100;

  const byTs = new Map<number, { vmid: number; instanceId: string; cores: number }[]>();
  for (const g of store.energy.guestBuckets(from, to)) {
    const list = byTs.get(g.ts) ?? [];
    list.push(g);
    byTs.set(g.ts, list);
  }
  const hostFrac = s.guestSplit.hostPct / 100, baseFrac = s.guestSplit.baselinePct / 100;
  const acc = new Map<string, GuestShare & { slots: number }>();
  let serverKwh = 0, serverCost = 0, hostKwh = 0, unattributed = 0, attributed = 0;
  for (const r of rows) {
    const price1 = (perKwh.get(r.ts) ?? fallback) * taxK;
    serverKwh += r.kwh; serverCost += r.kwh * price1;
    const gs = byTs.get(r.ts);
    if (!gs || gs.length === 0) { unattributed += r.kwh; continue; }
    attributed += r.kwh;
    const host = r.kwh * hostFrac;
    hostKwh += host;
    const rest = r.kwh - host;
    const sumCores = gs.reduce((a, g) => a + g.cores, 0);
    for (const g of gs) {
      const share = rest * (baseFrac / gs.length + (1 - baseFrac) * (sumCores > 0 ? g.cores / sumCores : 1 / gs.length));
      const id = `${g.instanceId}:${g.vmid}`;
      const a = acc.get(id) ?? { instanceId: g.instanceId, vmid: g.vmid, kwh: 0, cost: 0, avgCores: 0, hoursRunning: 0, slots: 0 };
      a.kwh += share; a.cost += share * price1; a.avgCores += g.cores; a.slots += 1; a.hoursRunning += BUCKET / 3600;
      acc.set(id, a);
    }
  }
  const list = [...acc.values()].map(({ slots, avgCores, ...g }) => ({ ...g, avgCores: slots ? avgCores / slots : 0 })).sort((a, b) => b.kwh - a.kwh);
  return { serverKwh, serverCost, hostKwh, unattributedKwh: unattributed, coverage: serverKwh > 0 ? attributed / serverKwh : 0, list };
}

export function formatMoney(c: EnergySettings["currency"], amount: number): string {
  const n = new Intl.NumberFormat(c.locale, { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals }).format(amount);
  return c.position === "before" ? `${c.symbol} ${n}` : `${n} ${c.symbol}`;
}

/** What Lumina measured between two moments with no calibration, no extra watts and gaps estimated: compare with your electricity meter. */
export function rawKwhBetween(store: Store, settings: EnergySettings, from: number, to: number, now = nowS()) {
  const s: EnergySettings = { ...settings, calibration: 1, extraWatts: 0, timezone: settings.timezone ?? "UTC" };
  const source = resolveSource(store, s, now);
  if (!source) return { source: null, kwh: 0, estimatedKwh: 0, coverage: 0 };
  const rows = price(store, { ...s, tariff: { ...s.tariff, type: "flat" } }, source.key, from, to, now).filter((p) => p.ts >= from && p.ts < to);
  const kwh = rows.reduce((a, p) => a + p.kwh, 0);
  const estimatedKwh = rows.filter((p) => p.estimated).reduce((a, p) => a + p.kwh, 0);
  const measuredSlots = rows.filter((p) => !p.estimated).length;
  return { source, kwh, estimatedKwh, coverage: Math.min(1, (measuredSlots * BUCKET) / Math.max(1, Math.min(to, now) - from)) };
}
