import { useEffect, useMemo, useState } from "react";
import { api, type EnergyResult, type Forecast } from "./api";
import { browserTz } from "./format";

/** Storage forecasts, refreshed every few minutes. */
export function useForecasts(): Map<string, Forecast> {
  const [list, setList] = useState<Forecast[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api.forecast().then((l) => alive && setList(l)).catch(() => undefined);
    void load();
    const t = setInterval(load, 300_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return useMemo(() => new Map(list.map((f) => [`${f.name}@${f.node}`, f])), [list]);
}

/** The current billing cycle's energy and cost, for the overview tile. */
export function useCycleEnergy(): EnergyResult | null {
  const [e, setE] = useState<EnergyResult | null>(null);
  useEffect(() => {
    let alive = true;
    const tz = browserTz();
    const load = () => api.energy("cycle", tz).then((r) => alive && setE(r)).catch(() => undefined);
    void load();
    const t = setInterval(load, 300_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return e;
}

export const forecastText = (f: Forecast | undefined, withRate = false): { text: string; warn: boolean } | null => {
  if (!f) return null;
  if (f.status === "growing" && f.daysToFull !== null) {
    const d = Math.max(1, Math.round(f.daysToFull));
    return { text: `full in ~${d} day${d === 1 ? "" : "s"}${withRate && f.slopePerDay ? ` (+${f.slopePerDay.toFixed(1)} pts/day)` : ""}`, warn: f.daysToFull <= 14 };
  }
  if (f.status === "shrinking") return { text: "freeing space", warn: false };
  if (f.status === "stable") return { text: "stable", warn: false };
  if (f.status === "collecting") return { text: "collecting data", warn: false };
  return { text: "no clear trend", warn: false };
};
