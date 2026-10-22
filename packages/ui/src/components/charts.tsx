import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { bitrate, mbps } from "../format";
import { Section } from "./Section";
import { UnitToggle, useSpeedUnit } from "./UnitToggle";

type Point = [number, number, number, number];
export const RANGES = ["1h", "6h", "24h", "7d"] as const;
export type Range = (typeof RANGES)[number];

export function useMetrics(instanceId: string, keys: string[], range: Range, refreshMs = 60_000) {
  const [series, setSeries] = useState<Record<string, Point[]>>({});
  const [error, setError] = useState<string | null>(null);
  const k = keys.join(",");
  useEffect(() => {
    if (!k) return;
    let alive = true;
    const load = () =>
      api.metrics(instanceId, k.split(","), range)
        .then((r) => alive && (setSeries(r.series), setError(null)))
        .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    void load();
    const t = setInterval(load, refreshMs);
    return () => { alive = false; clearInterval(t); };
  }, [instanceId, k, range, refreshMs]);
  return { series, error };
}

/** "@bps" values are bits per second and "@mbps" megabits per second; both follow the Mbit/s | MB/s switch. */
export const SPEED_UNITS = new Set(["@bps", "@mbps"]);
interface Described { label: string; unit: string }
const FIXED: Record<string, Described> = {
  load: { label: "Load", unit: "%" }, battery: { label: "Battery charge", unit: "%" }, runtime: { label: "Runtime remaining", unit: " min" },
  inputV: { label: "Input voltage", unit: " V" }, watts: { label: "Estimated draw", unit: " W" },
  power: { label: "Power draw", unit: " W" }, "temp:max": { label: "Hottest sensor", unit: "°C" }, "temp:inlet": { label: "Inlet temperature", unit: "°C" },
  "fan:avg": { label: "Average fan speed", unit: "%" }, "drive-temp:max": { label: "Hottest drive", unit: "°C" },
  "guests:running": { label: "Running guests", unit: "" }, "guests:total": { label: "Total guests", unit: "" },
  "monitors:up": { label: "Monitors up", unit: "" }, "monitors:down": { label: "Monitors down", unit: "" }, "response:avg": { label: "Average response", unit: " ms" },
  "tunnels:healthy": { label: "Healthy tunnels", unit: "" }, "tunnels:total": { label: "Total tunnels", unit: "" },
  "traffic:in": { label: "Traffic in (all links)", unit: "@bps" }, "traffic:out": { label: "Traffic out (all links)", unit: "@bps" },
  "speed:down": { label: "Internet download", unit: "@mbps" }, "speed:up": { label: "Internet upload", unit: "@mbps" }, "speed:latency": { label: "Speed test response", unit: " ms" },
  "rtt:avg": { label: "Average latency", unit: " ms" }, "net:up": { label: "Checks up", unit: "" }, "net:down": { label: "Checks down", unit: "" },
  mem: { label: "Memory used", unit: "%" },
};
const PREFIXED: [string, string, string][] = [
  ["cpu:", "CPU", "%"], ["mem:", "Memory", "%"], ["rootfs:", "Root disk", "%"], ["storage:", "Storage", "%"],
  ["resp:", "Response", " ms"], ["connections:", "Connections", ""],
];

export function describeMetric(key: string): Described {
  if (FIXED[key]) return FIXED[key];
  const link = /^if:(.+):(in|out)$/.exec(key);
  if (link) return { label: `${link[1]} · ${link[2] === "in" ? "download (in)" : "upload (out)"}`, unit: "@bps" };
  const loss = /^loss:(.+)$/.exec(key);
  if (loss) return { label: `Packet loss · ${loss[1]}`, unit: "%" };
  const rtt = /^rtt:(.+)$/.exec(key);
  if (rtt) return { label: `Latency · ${rtt[1]}`, unit: " ms" };
  const pushed = /^push:(.+)$/.exec(key);
  if (pushed) return { label: `Pushed value · ${pushed[1]}`, unit: "" };
  for (const [p, label, unit] of PREFIXED) if (key.startsWith(p)) return { label: `${label} · ${key.slice(p.length)}`, unit };
  return { label: key, unit: "" };
}

export function fmt(v: number, unit: string) {
  if (unit === "@bps") return bitrate(v);
  if (unit === "@mbps") return mbps(v);
  const digits = Math.abs(v) >= 100 || Number.isInteger(v) ? 0 : 1;
  return `${v.toFixed(digits)}${unit}`;
}

const clock = (t: number, range: Range) =>
  new Date(t * 1000).toLocaleString([], range === "7d" ? { month: "short", day: "numeric", hour: "2-digit" } : range === "24h" ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

/** Tiny trend line for a tile. */
export function Spark({ instanceId, metric, range = "1h", unit = "" }: { instanceId: string; metric: string; range?: Range; unit?: string }) {
  const { series } = useMetrics(instanceId, [metric], range, 60_000);
  const pts = series[metric] ?? [];
  if (pts.length < 2) return <div className="spark empty" aria-hidden />;
  const vals = pts.map((p) => p[1]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * 100;
  const y = (v: number) => 28 - ((v - lo) / span) * 24;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={`${describeMetric(metric).label} over the last ${range}`}>
      <title>{`${describeMetric(metric).label}: now ${fmt(vals[vals.length - 1], unit)}, min ${fmt(lo, unit)}, max ${fmt(hi, unit)} (last ${range})`}</title>
      <path d={`${line} L100,30 L0,30 Z`} className="spark-area" />
      <path d={line} className="spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Full chart with axes and a hover read-out. */
export function MetricChart({ points, unit, range }: { points: Point[]; unit: string; range: Range }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  useSpeedUnit();
  const W = 640, H = 190, L = 78, R = 10, T = 10, B = 24;

  const model = useMemo(() => {
    if (points.length < 2) return null;
    const lo = Math.min(...points.map((p) => p[2])), hi = Math.max(...points.map((p) => p[3]));
    const pad = (hi - lo || 1) * 0.1;
    // Things that can never be negative (speeds, percentages, counts) should not get an axis that dips below zero.
    const y0 = lo >= 0 ? Math.max(0, lo - pad) : lo - pad, y1 = hi + pad;
    const t0 = points[0][0], t1 = points[points.length - 1][0];
    const x = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
    const y = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    return { y0, y1, t0, t1, x, y };
  }, [points]);

  if (!model) return <div className="empty" style={{ padding: "28px 0" }}>Not enough history yet — a point is recorded every minute.</div>;
  const { y0, y1, t0, t1, x, y } = model;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  const band = [...points.map((p) => `${x(p[0]).toFixed(1)},${y(p[3]).toFixed(1)}`), ...[...points].reverse().map((p) => `${x(p[0]).toFixed(1)},${y(p[2]).toFixed(1)}`)].join(" ");
  const ticks = [0, 0.5, 1].map((f) => y0 + (y1 - y0) * f);
  const h = hover !== null ? points[hover] : null;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const box = ref.current!.getBoundingClientRect();
    const t = t0 + (((e.clientX - box.left) / box.width) * W - L) / (W - L - R) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i][0] - t) < Math.abs(points[best][0] - t)) best = i;
    setHover(best);
  }

  return (
    <div className="chart">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="History chart">
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid-line" />
            <text x={L - 6} y={y(v) + 3} textAnchor="end" className="axis">{fmt(v, unit)}</text>
          </g>
        ))}
        <text x={L} y={H - 6} className="axis">{clock(t0, range)}</text>
        <text x={W - R} y={H - 6} textAnchor="end" className="axis">{clock(t1, range)}</text>
        <polygon points={band} className="chart-band" />
        <path d={line} className="chart-line" />
        {h && (
          <g>
            <line x1={x(h[0])} x2={x(h[0])} y1={T} y2={H - B} className="chart-cursor" />
            <circle cx={x(h[0])} cy={y(h[1])} r={4} className="chart-dot" />
          </g>
        )}
      </svg>
      <div className="chart-readout">
        {h ? <><b>{fmt(h[1], unit)}</b> <span className="sub">at {clock(h[0], range)} · range {fmt(h[2], unit)} – {fmt(h[3], unit)}</span></> : <span className="sub">Hover the chart for exact values</span>}
      </div>
    </div>
  );
}

/** Collapsible per-instance history: pick a metric and a time range. */
export function HistorySection({ instanceId, prefer }: { instanceId: string; prefer?: string[] }) {
  const [keys, setKeys] = useState<string[] | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("1h");

  return (
    <Section id={`history:${instanceId}`} title="History" defaultCollapsed>
      <HistoryBody instanceId={instanceId} prefer={prefer} keys={keys} setKeys={setKeys} keyName={key} setKey={setKey} range={range} setRange={setRange} />
    </Section>
  );
}

interface BodyProps {
  instanceId: string;
  prefer?: string[];
  keys: string[] | null;
  setKeys: (k: string[]) => void;
  keyName: string | null;
  setKey: (k: string) => void;
  range: Range;
  setRange: (r: Range) => void;
}

function HistoryBody({ instanceId, prefer, keys, setKeys, keyName, setKey, range, setRange }: BodyProps) {
  useSpeedUnit();
  useEffect(() => {
    let alive = true;
    api.metricKeys(instanceId).then((k) => {
      if (!alive) return;
      setKeys(k);
      if (!keyName) setKey(prefer?.find((p) => k.includes(p)) ?? k[0] ?? "");
    }).catch(() => alive && setKeys([]));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  const { series } = useMetrics(instanceId, keyName ? [keyName] : [], range);
  const pts = keyName ? series[keyName] ?? [] : [];
  const unit = keyName ? describeMetric(keyName).unit : "";
  const vals = pts.map((p) => p[1]);

  if (keys === null) return <div className="empty">Loading…</div>;
  if (keys.length === 0) return <div className="empty">No history recorded yet — it starts after the first minute.</div>;

  return (
    <div style={{ padding: "8px 2px" }}>
      <div className="chips">
        {keys.map((k) => (
          <button key={k} className={`chip ${k === keyName ? "on" : ""}`} onClick={() => setKey(k)}>{describeMetric(k).label}</button>
        ))}
      </div>
      <div className="seg" role="group" aria-label="Time range">
        {RANGES.map((r) => <button key={r} className={r === range ? "on" : ""} onClick={() => setRange(r)}>{r}</button>)}
      </div>
      {SPEED_UNITS.has(unit) && <div style={{ display: "flex", justifyContent: "flex-end", margin: "6px 0" }}><UnitToggle /></div>}
      <MetricChart points={pts} unit={unit} range={range} />
      {vals.length > 0 && (
        <div className="sub" style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 4 }}>
          <span>Now <b>{fmt(vals[vals.length - 1], unit)}</b></span>
          <span>Min <b>{fmt(Math.min(...pts.map((p) => p[2])), unit)}</b></span>
          <span>Avg <b>{fmt(vals.reduce((a, b) => a + b, 0) / vals.length, unit)}</b></span>
          <span>Max <b>{fmt(Math.max(...pts.map((p) => p[3])), unit)}</b></span>
        </div>
      )}
    </div>
  );
}
