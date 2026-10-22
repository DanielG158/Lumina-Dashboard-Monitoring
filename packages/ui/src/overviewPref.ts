import { useSyncExternalStore } from "react";

/** "easy": big counts and only the things that need a look. "full": every VM, container and monitor listed by name. */
export type OverviewDetail = "easy" | "full";
const KEY = "lumina:overviewDetail";
const listeners = new Set<() => void>();
let current: OverviewDetail = (() => { try { return localStorage.getItem(KEY) === "full" ? "full" : "easy"; } catch { return "easy"; } })();

export const getOverviewDetail = (): OverviewDetail => current;
export function setOverviewDetail(v: OverviewDetail) {
  current = v;
  try { localStorage.setItem(KEY, v); } catch { /* not remembered */ }
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useOverviewDetail = (): OverviewDetail => useSyncExternalStore(subscribe, getOverviewDetail);
