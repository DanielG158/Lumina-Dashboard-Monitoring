import { useEffect, useRef, useState } from "react";
import { UnitToggle } from "./UnitToggle";
import { setOverviewDetail, useOverviewDetail } from "../overviewPref";
import { THEMES, getAccent, getShuffleMode, getShuffleSeconds, getTheme, setAccent, setShuffle, setTheme, type ShuffleMode } from "../theme";

export function ThemeMenu() {
  const [open, setOpen] = useState(false);
  const [theme, setT] = useState(getTheme());
  const [accent, setA] = useState(getAccent());
  const [mode, setMode] = useState<ShuffleMode>(getShuffleMode());
  const [secs, setSecs] = useState(getShuffleSeconds());
  const detail = useOverviewDetail();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button className="btn sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>Theme</button>
      {open && (
        <div className="popover stack">
          <div className="themes">
            {THEMES.map((t) => (
              <button key={t.id} className={`theme-opt ${t.id === theme ? "on" : ""}`} onClick={() => { setTheme(t.id); setT(t.id); }}>
                <div className="swatch">{t.swatch.map((c) => <i key={c} style={{ background: c }} />)}</div>
                {t.name}
              </button>
            ))}
          </div>
          <label className="row" style={{ justifyContent: "space-between" }}>
            <span>Accent colour</span>
            <input type="color" value={accent ?? "#7c9cff"} onChange={(e) => { setAccent(e.target.value); setA(e.target.value); }} />
          </label>
          {accent && <button className="btn sm" onClick={() => { setAccent(null); setA(null); }}>Reset accent</button>}
          <label className="stack" style={{ gap: 4 }}>
            <span>Overview detail</span>
            <select className="field" value={detail} onChange={(e) => setOverviewDetail(e.target.value as "easy" | "full")}>
              <option value="easy">Easy to read: big counts, only what needs a look</option>
              <option value="full">Everything: every VM and monitor by name</option>
            </select>
          </label>
          <label className="stack" style={{ gap: 4 }}>
            <span>Burn-in protection</span>
            <div className="row">
              <select className="field" value={mode} onChange={(e) => { const m = e.target.value as ShuffleMode; setMode(m); setShuffle(m, secs); }}>
                <option value="tv">TV mode only</option>
                <option value="always">Overview and TV mode</option>
                <option value="off">Off</option>
              </select>
              <select className="field" value={secs} disabled={mode === "off"} onChange={(e) => { const n = Number(e.target.value); setSecs(n); setShuffle(mode, n); }}>
                {[10, 15, 30, 60].map((n) => <option key={n} value={n}>every {n} s</option>)}
              </select>
            </div>
            <span className="hint">Rearranges the tiles and panels and nudges them a few pixels, so a screen left on all day never shows the same picture for long.</span>
          </label>
          <label className="row" style={{ justifyContent: "space-between" }}><span>Network speed units</span><UnitToggle /></label>
          <div className="hint">Saved in this browser only.</div>
        </div>
      )}
    </div>
  );
}
