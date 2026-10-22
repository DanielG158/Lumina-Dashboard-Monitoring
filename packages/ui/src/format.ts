import type { Currency } from "./api";

export function money(c: Currency, amount: number): string {
  const n = new Intl.NumberFormat(c.locale, { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals }).format(amount);
  return c.position === "before" ? `${c.symbol} ${n}` : `${n} ${c.symbol}`;
}

export const kwhText = (n: number) => `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} kWh`;
export const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };

export const dateTime = (ts: number) => new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const clockTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function duration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m} min`;
  const h = m / 60;
  return h < 48 ? `${h % 1 === 0 ? h : h.toFixed(1)} h` : `${Math.round(h / 24)} days`;
}

/** <input type="datetime-local"> works in local time without seconds. */
export function toLocalInput(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const fromLocalInput = (s: string) => Math.floor(new Date(s).getTime() / 1000);
export const toDateInput = (ts: number) => toLocalInput(ts).slice(0, 10);

// ---- network speed units: bits (Mbit/s, the way links and internet plans are sold) or bytes (MB/s, the way downloads show) ----
export type SpeedUnit = "bits" | "bytes";
const UNIT_KEY = "lumina:speedUnit";
const listeners = new Set<() => void>();
let unit: SpeedUnit = (() => { try { return localStorage.getItem(UNIT_KEY) === "bytes" ? "bytes" : "bits"; } catch { return "bits"; } })();
export const getSpeedUnit = (): SpeedUnit => unit;
export function setSpeedUnit(u: SpeedUnit) {
  unit = u;
  try { localStorage.setItem(UNIT_KEY, u); } catch { /* storage unavailable: it just will not be remembered */ }
  listeners.forEach((l) => l());
}
export const subscribeSpeedUnit = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** 12_500_000 bits/s -> "12.5 Mbit/s", or "1.56 MB/s" in bytes mode */
export function bitrate(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return "—";
  if (unit === "bytes") {
    const b = bps / 8;
    if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB/s`;
    if (b >= 1e6) return `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 2)} MB/s`;
    if (b >= 1e3) return `${(b / 1e3).toFixed(0)} kB/s`;
    return `${Math.round(b)} B/s`;
  }
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbit/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)} Mbit/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} kbit/s`;
  return `${Math.round(bps)} bit/s`;
}

/** A speed given in megabits per second (internet speed tests, link speeds). */
export function mbps(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return bitrate(v * 1e6);
}
