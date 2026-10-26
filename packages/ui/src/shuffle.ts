import { useEffect, useRef, useState } from "react";
import { getShuffleMode, getShuffleSeconds, type ShuffleMode } from "./theme";

export function useDisplayPrefs(): { mode: ShuffleMode; seconds: number } {
  const [p, setP] = useState({ mode: getShuffleMode(), seconds: getShuffleSeconds() });
  useEffect(() => {
    const update = () => setP({ mode: getShuffleMode(), seconds: getShuffleSeconds() });
    window.addEventListener("lumina:display", update);
    window.addEventListener("storage", update);
    return () => { window.removeEventListener("lumina:display", update); window.removeEventListener("storage", update); };
  }, []);
  return p;
}

export interface BurnInLayout {
  blocks: string[];
  kpis: string[];
  left: string[];
  right: string[];
  swap: boolean;
  dx: number;
  dy: number;
  sig: string;
}

const BLOCKS = ["banner", "kpis", "cols"];
const LEFT = ["guests", "hosts", "servers", "monitors", "storage"];
const RIGHT = ["alerts", "devices", "recent"];

function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const sigOf = (l: Omit<BurnInLayout, "sig">) => JSON.stringify([l.blocks, l.kpis, l.left, l.right, l.swap]);

export function identityLayout(kpis: string[]): BurnInLayout {
  const l = { blocks: BLOCKS, kpis, left: LEFT, right: RIGHT, swap: false, dx: 0, dy: 0 };
  return { ...l, sig: sigOf(l) };
}

/** A new arrangement that differs from the previous one, nudged a few pixels so even unchanged edges move. */
function nextLayout(prev: BurnInLayout, kpis: string[]): BurnInLayout {
  const nudge = () => Math.round((Math.random() * 2 - 1) * 14);
  let l = identityLayout(kpis);
  for (let i = 0; i < 12; i++) {
    const c = { blocks: shuffled(BLOCKS), kpis: shuffled(kpis), left: shuffled(LEFT), right: shuffled(RIGHT), swap: Math.random() < 0.5, dx: nudge(), dy: nudge() };
    l = { ...c, sig: sigOf(c) };
    if (l.sig !== prev.sig) break;
  }
  return l;
}

/** Every `seconds` the display fades out, rearranges and fades back in, so no element stays in the same place for long. */
export function useBurnInLayout(active: boolean, seconds: number, kpiKeys: string[]) {
  const [layout, setLayout] = useState<BurnInLayout>(() => identityLayout(kpiKeys));
  const [fading, setFading] = useState(false);
  const keys = useRef(kpiKeys);
  keys.current = kpiKeys;

  useEffect(() => {
    if (!active) {
      setLayout(identityLayout(keys.current));
      setFading(false);
      return;
    }
    const timers: number[] = [];
    const tick = window.setInterval(() => {
      setFading(true);
      timers.push(window.setTimeout(() => setLayout((prev) => nextLayout(prev, keys.current)), 450));
      timers.push(window.setTimeout(() => setFading(false), 560));
    }, Math.max(5, seconds) * 1000);
    return () => { window.clearInterval(tick); timers.forEach(window.clearTimeout); };
  }, [active, seconds]);

  return { layout, fading };
}

/** Position of `key` in an ordering; unknown keys go last so new tiles never break the layout. */
export const orderOf = (list: string[], key: string) => { const i = list.indexOf(key); return i === -1 ? list.length + 1 : i; };
