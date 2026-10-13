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
