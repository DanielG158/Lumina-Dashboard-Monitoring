import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, type InstanceUpdate, type SpeedResult } from "../api";
import { Spark } from "../components/charts";
import { clamp, barClass } from "../components/CardShell";
import { ChecksEditor } from "../components/ChecksEditor";
import { UnitToggle, useSpeedUnit } from "../components/UnitToggle";
import { bitrate, mbps } from "../format";
import { useLumina } from "../context";
import { ago } from "../summaries";

interface Check { name: string; kind: string; target: string; ok: boolean; ms: number | null; lossPct: number; recentLossPct?: number; error: string | null }
interface NetData {
  targets: Check[]; speed: { at: number; downMbps: number | null; upMbps: number | null; latencyMs: number | null; error: string | null } | null;
  speedRunning: boolean; speedEnabled: boolean; warn: { latencyMs: number; lossPct: number; minDownMbps: number | null };
  summary: { up: number; down: number; avgMs: number | null; avgLossPct: number };
}
interface Iface { index: number; name: string; up: boolean; speedMbps: number | null; inBps: number | null; outBps: number | null; watched: boolean; utilPct: number | null }
interface SnmpData { sysName: string | null; interfaces: Iface[] }
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const metricName = (n: string) => n.replace(/[,\s]+/g, " ").trim();
const PERIODS: [string, string, number][] = [["24h", "24 hours", 86400], ["7d", "7 days", 7 * 86400], ["30d", "30 days", 30 * 86400], ["all", "Everything", 0]];

export function NetworkPage() {
  const L = useLumina();
  useSpeedUnit();
  const nets = L.instances.filter((i) => i.moduleId === "netcheck" && i.data);
  const snmps = L.instances.filter((i) => i.moduleId === "snmp" && i.data);
  const allNets = L.instances.filter((i) => i.moduleId === "netcheck");

  const checks = nets.flatMap((i) => (i.data as NetData).targets);
  const up = checks.filter((c) => c.ok).length;
  const times = checks.filter((c) => c.ok && c.ms !== null).map((c) => c.ms as number);
  const loss = checks.length ? checks.reduce((a, c) => a + c.lossPct, 0) / checks.length : 0;
  const latest = nets.map((i) => (i.data as NetData).speed).filter(Boolean).sort((a, b) => (b!.at - a!.at))[0] ?? null;
  const links = snmps.flatMap((i) => (i.data as SnmpData).interfaces);

  return (
    <div className="stack">
      <div className="page-title"><h1>Network</h1><span className="grow" /><UnitToggle /></div>

      {allNets.length === 0 && snmps.length === 0 ? (
        <section className="panel">
          <div className="empty">
            Nothing is monitoring the network yet. Add <b>Network checks</b> (ping, ports, DNS, web, and an internet speed test) or <b>Router / switch (SNMP)</b> under Instances.
            {L.can.admin && <div style={{ marginTop: 10 }}><button className="btn primary" onClick={() => L.startAdding()}>Add one now</button></div>}
          </div>
        </section>
      ) : (
        <>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
            <div className="stat"><div className="label">Checks up</div><div className="value">{up}/{checks.length}</div></div>
            <div className="stat"><div className="label">Average latency</div><div className="value">{times.length ? Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10 : "—"}<span className="sub"> ms</span></div></div>
            <div className="stat"><div className="label">Average packet loss</div><div className="value">{Math.round(loss * 10) / 10}<span className="sub"> %</span></div></div>
            <div className="stat"><div className="label">Last speed test</div><div className="value" style={{ fontSize: 18 }}>{latest ? `${mbps(latest.downMbps)} ↓` : "—"}</div><div className="sub">{latest ? `${mbps(latest.upMbps)} ↑ · ${ago(latest.at)}` : "no test yet"}</div></div>
            {snmps.length > 0 && <div className="stat"><div className="label">Links up</div><div className="value">{links.filter((l) => l.up).length}/{links.length}</div></div>}
          </div>

          {L.can.admin && allNets.length > 0 && <ChecksPanel instances={allNets} />}
          {allNets.length > 0 && <SpeedPanel instances={allNets} />}
          {nets.length > 0 && <LatencyPanel nets={nets} />}
          {snmps.length > 0 && <LinksPanel snmps={snmps} />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The list of checks, as a form

function ChecksPanel({ instances }: { instances: InstanceUpdate[] }) {
  const L = useLumina();
  const [id, setId] = useState(instances[0].instanceId);
  const inst = instances.find((i) => i.instanceId === id) ?? instances[0];
  const live = (inst.data as NetData | null)?.targets;
  const [cfg, setCfg] = useState<Record<string, unknown> | null>(null);
  const [poll, setPoll] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [opts, setOpts] = useState({ packets: "4", latency: "150", loss: "20", every: "30" });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);

  const load = useCallback(() => {
    api.getConfig(id).then(({ config, pollIntervalSec }) => {
      setCfg(config); setPoll(pollIntervalSec); setText(String(config.targets ?? ""));
      setOpts({ packets: String(config.packets ?? 4), latency: String(config.warnLatencyMs ?? 150), loss: String(config.warnLossPct ?? 20), every: String(pollIntervalSec ?? Math.round(inst.intervalMs / 1000)) });
      setVersion((v) => v + 1);
    }).catch((e) => L.notify(err(e), true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => { if (open) load(); }, [open, load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!cfg) return;
    setSaving(true);
    try {
      await api.updateInstance(id, { ...cfg, targets: text, packets: Number(opts.packets), warnLatencyMs: Number(opts.latency), warnLossPct: Number(opts.loss) }, Number(opts.every) || poll);
      L.notify("Checks saved");
      await L.reloadInstances();
      setOpen(false);
    } catch (x) { L.notify(err(x), true); } finally { setSaving(false); }
  }
  const num = (k: keyof typeof opts) => (e: React.ChangeEvent<HTMLInputElement>) => setOpts({ ...opts, [k]: e.target.value });
  const unchanged = cfg !== null && text === String(cfg.targets ?? "") && opts.packets === String(cfg.packets ?? 4) && opts.latency === String(cfg.warnLatencyMs ?? 150) && opts.loss === String(cfg.warnLossPct ?? 20) && opts.every === String(poll ?? Math.round(inst.intervalMs / 1000));

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>What is checked</h2>
        <span className="meta">
          {instances.length > 1 && <select className="field" style={{ marginRight: 8 }} value={id} onChange={(e) => { setId(e.target.value); setCfg(null); }} aria-label="Instance">{instances.map((i) => <option key={i.instanceId}>{i.instanceId}</option>)}</select>}
          <button className="btn sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "Close" : "Edit checks"}</button>
        </span>
      </div>
      {!open && <div className="sub">{(live ?? []).length ? `${(live ?? []).length} checks: ${(live ?? []).map((t) => t.name).join(", ")}` : "No checks yet."} Press <b>Edit checks</b> to add, change or remove them.</div>}
      {open && !cfg && <div className="empty">Loading…</div>}
      {open && cfg && (
        <form className="stack" onSubmit={save}>
          <ChecksEditor key={`${id}:${version}`} value={text} live={live} onChange={(t, errs) => { setText(t); setErrors(errs); }} />
          <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
            <label className="stack" style={{ gap: 4 }}><span>Check every (seconds)</span><input className="field" type="number" min={10} max={3600} style={{ width: 110 }} value={opts.every} onChange={num("every")} /></label>
            <label className="stack" style={{ gap: 4 }}><span>Pings per check</span><input className="field" type="number" min={1} max={10} style={{ width: 100 }} value={opts.packets} onChange={num("packets")} /></label>
            <label className="stack" style={{ gap: 4 }}><span>Warn when slower than (ms)</span><input className="field" type="number" min={1} style={{ width: 140 }} value={opts.latency} onChange={num("latency")} /></label>
            <label className="stack" style={{ gap: 4 }}><span>Warn when packet loss is at least (%)</span><input className="field" type="number" min={1} max={100} style={{ width: 160 }} value={opts.loss} onChange={num("loss")} /></label>
          </div>
          <div className="hint">Pings give latency and packet loss. If a network drops pings on purpose, use a TCP port check instead. A check that stops answering raises a critical alert.</div>
          {errors.length > 0 && <div className="error">Fix the checks marked in red before saving.</div>}
          <div className="row"><button className="btn primary" disabled={saving || errors.length > 0 || unchanged || !text.trim()}>{saving ? "Saving…" : "Save checks"}</button><button type="button" className="btn" onClick={() => load()}>Discard changes</button></div>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Internet speed

function SpeedPanel({ instances }: { instances: InstanceUpdate[] }) {
  const L = useLumina();
  useSpeedUnit();
  const [id, setId] = useState(instances[0].instanceId);
  const inst = instances.find((i) => i.instanceId === id) ?? instances[0];
  const d = inst.data as NetData | null;
  const [period, setPeriod] = useState("7d");
  const [rows, setRows] = useState<SpeedResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(15);

  const load = useCallback(() => {
    const secs = PERIODS.find((p) => p[0] === period)?.[2] ?? 0;
    return api.speedTests({ instance: inst.instanceId, since: secs ? Math.floor(Date.now() / 1000) - secs : undefined, limit: 1000 }).then(setRows).catch((e) => L.notify(err(e), true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst.instanceId, period]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 60_000); return () => clearInterval(t); }, [load]);
  useEffect(() => { void load(); // a new result arrived
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.speed?.at]);

  async function run() {
    setBusy(true);
    try {
      await api.action(inst.instanceId, "speedtest", {});
      await api.refresh(inst.instanceId).catch(() => undefined);
      await load();
      L.notify("Speed test finished");
    } catch (e) { L.notify(err(e), true); } finally { setBusy(false); }
  }

  const ok = rows.filter((r) => r.downMbps !== null);
  const avg = (f: (r: SpeedResult) => number | null) => { const v = ok.map(f).filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const best = ok.length ? Math.max(...ok.map((r) => r.downMbps as number)) : null;
  const worst = ok.length ? Math.min(...ok.map((r) => r.downMbps as number)) : null;

  function exportCsv() {
    const lines = ["time,download_mbit_s,upload_mbit_s,response_ms,error", ...rows.map((r) => [new Date(r.ts * 1000).toISOString(), r.downMbps ?? "", r.upMbps ?? "", r.latencyMs ?? "", JSON.stringify(r.error ?? "")].join(","))];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })); a.download = `lumina-speedtests-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Internet speed</h2>
        <span className="meta">
          {instances.length > 1 && <select className="field" style={{ marginRight: 8 }} value={inst.instanceId} onChange={(e) => setId(e.target.value)} aria-label="Instance">{instances.map((i) => <option key={i.instanceId}>{i.instanceId}</option>)}</select>}
          {d?.speedRunning ? "testing now…" : d?.speedEnabled ? (d.speed ? `last test ${ago(d.speed.at)}` : "first test soon") : "switched off"}
        </span>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
        <div className="stat"><div className="label">Download</div><div className="value" style={{ fontSize: 24 }}>{mbps(d?.speed?.downMbps)}</div><div className="sub">{ok.length ? `average ${mbps(avg((r) => r.downMbps))}` : ""}</div></div>
        <div className="stat"><div className="label">Upload</div><div className="value" style={{ fontSize: 24 }}>{mbps(d?.speed?.upMbps)}</div><div className="sub">{ok.length ? `average ${mbps(avg((r) => r.upMbps))}` : ""}</div></div>
        <div className="stat"><div className="label">Response</div><div className="value" style={{ fontSize: 24 }}>{d?.speed?.latencyMs ?? "—"}<span className="sub"> ms</span></div><div className="sub">to the test server</div></div>
        <div className="stat"><div className="label">Best / worst download</div><div className="value" style={{ fontSize: 18 }}>{mbps(best)}</div><div className="sub">worst {mbps(worst)} · {ok.length} test{ok.length === 1 ? "" : "s"}</div></div>
      </div>
      {d?.speed?.error && <div className="error">{d.speed.error}</div>}

      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8, margin: "10px 0" }}>
        <div className="seg" role="group" aria-label="Period">{PERIODS.map(([k, label]) => <button key={k} className={k === period ? "on" : ""} onClick={() => setPeriod(k)}>{label}</button>)}</div>
        <div className="row" style={{ gap: 8 }}>
          {L.can.operate && <button className="btn primary" disabled={busy || !d?.speedEnabled || d?.speedRunning} title={d?.speedEnabled ? "Download and upload test data now" : "Switch speed tests on first (settings below)"} onClick={() => void run()}>{busy || d?.speedRunning ? "Testing…" : "Run speed test now"}</button>}
          <button className="btn" disabled={rows.length === 0} onClick={exportCsv}>Export CSV</button>
        </div>
      </div>

      <SpeedChart rows={rows} />

      {rows.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead><tr><th>When</th><th className="num">Download</th><th className="num">Upload</th><th className="num">Response</th><th>Result</th></tr></thead>
            <tbody>
              {rows.slice(0, shown).map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.ts * 1000).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                  <td className="num">{mbps(r.downMbps)}</td><td className="num">{mbps(r.upMbps)}</td><td className="num">{r.latencyMs ?? "—"} ms</td>
                  <td className="sub">{r.error ?? (d?.warn.minDownMbps && r.downMbps !== null && r.downMbps < d.warn.minDownMbps ? "below your limit" : "ok")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > shown && <div style={{ marginTop: 8 }}><button className="btn sm" onClick={() => setShown((n) => n + 30)}>Show more</button></div>}
        </div>
      )}
      {rows.length === 0 && <div className="hint" style={{ marginTop: 8 }}>No results in this period yet. Results are kept for two years.</div>}

      {L.can.admin && <SpeedSettings id={inst.instanceId} />}
    </section>
  );
}

function SpeedChart({ rows }: { rows: SpeedResult[] }) {
  useSpeedUnit();
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const pts = useMemo(() => [...rows].filter((r) => r.downMbps !== null || r.upMbps !== null).sort((a, b) => a.ts - b.ts), [rows]);
  if (pts.length === 0) return <div className="empty" style={{ padding: "24px 0" }}>The chart appears after the first speed test.</div>;
  const W = 720, H = 220, L = 86, R = 12, T = 12, B = 26;
  const vals = pts.flatMap((p) => [p.downMbps ?? 0, p.upMbps ?? 0]);
  const hi = Math.max(...vals) * 1.1 || 1;
  const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
  const x = (t: number) => L + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - v / hi) * (H - T - B);
  const path = (key: "downMbps" | "upMbps") => pts.filter((p) => p[key] !== null).map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p[key] as number).toFixed(1)}`).join(" ");
  const h = hover !== null ? pts[hover] : null;
  const fmtT = (t: number) => new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="chart">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Internet speed over time"
        onPointerMove={(e) => { const b = ref.current!.getBoundingClientRect(); const t = t0 + ((((e.clientX - b.left) / b.width) * W - L) / (W - L - R)) * (t1 - t0); let best = 0; for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].ts - t) < Math.abs(pts[best].ts - t)) best = i; setHover(best); }}
        onPointerLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => <g key={f}><line x1={L} x2={W - R} y1={y(hi * f)} y2={y(hi * f)} className="grid-line" /><text x={L - 6} y={y(hi * f) + 3} textAnchor="end" className="axis">{mbps(hi * f)}</text></g>)}
        <text x={L} y={H - 6} className="axis">{fmtT(t0)}</text>
        <text x={W - R} y={H - 6} textAnchor="end" className="axis">{fmtT(t1)}</text>
        <path d={path("downMbps")} className="chart-line" />
        <path d={path("upMbps")} className="chart-line" style={{ stroke: "var(--warn)" }} />
        {pts.map((p) => <g key={p.id}>{p.downMbps !== null && <circle cx={x(p.ts)} cy={y(p.downMbps)} r={3} className="chart-dot" />}{p.upMbps !== null && <circle cx={x(p.ts)} cy={y(p.upMbps)} r={3} style={{ fill: "var(--warn)" }} />}</g>)}
        {h && <line x1={x(h.ts)} x2={x(h.ts)} y1={T} y2={H - B} className="chart-cursor" />}
      </svg>
      <div className="chart-readout">
        <span className="sub"><i className="dot" style={{ background: "var(--accent)", marginRight: 4 }} />download <i className="dot" style={{ background: "var(--warn)", margin: "0 4px 0 12px" }} />upload</span>
        {"  "}{h ? <><b>{mbps(h.downMbps)} ↓ · {mbps(h.upMbps)} ↑</b> <span className="sub">at {fmtT(h.ts)}</span></> : <span className="sub">Hover the chart for exact values</span>}
      </div>
    </div>
  );
}

function SpeedSettings({ id }: { id: string }) {
  const L = useLumina();
  const [cfg, setCfg] = useState<Record<string, unknown> | null>(null);
  const [poll, setPoll] = useState<number | null>(null);
  const [f, setF] = useState({ on: false, hours: "6", mb: "25", min: "", down: "", up: "" });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getConfig(id).then(({ config, pollIntervalSec }) => {
      if (!alive) return;
      setCfg(config); setPoll(pollIntervalSec);
      setF({ on: Boolean(config.speedTest), hours: String(config.speedTestEveryHours ?? 6), mb: String(config.speedTestMB ?? 25), min: config.minDownMbps != null ? String(config.minDownMbps) : "", down: String(config.speedTestDownloadUrl ?? "https://speed.cloudflare.com/__down"), up: String(config.speedTestUploadUrl ?? "https://speed.cloudflare.com/__up") });
    }).catch((e) => L.notify(err(e), true));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  if (!cfg) return null;

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const next: Record<string, unknown> = { ...cfg, speedTest: f.on, speedTestEveryHours: Number(f.hours), speedTestMB: Number(f.mb), speedTestDownloadUrl: f.down.trim(), speedTestUploadUrl: f.up.trim() };
      if (f.min.trim() === "") delete next.minDownMbps; else next.minDownMbps = Number(f.min);
      await api.updateInstance(id, next, poll);
      L.notify("Speed test settings saved");
      await L.reloadInstances();
    } catch (x) { L.notify(err(x), true); } finally { setSaving(false); }
  }
  const num = (k: "hours" | "mb" | "min") => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div style={{ marginTop: 14 }}>
      <button className="btn sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "Hide speed test settings" : "Speed test settings"}</button>
      {open && (
        <form className="subpanel stack" onSubmit={save} style={{ marginTop: 8 }}>
          <label className="check"><span><input type="checkbox" checked={f.on} onChange={(e) => setF({ ...f, on: e.target.checked })} /> Run internet speed tests automatically</span></label>
          <div className="hint">Each test downloads and uploads test data, which uses your internet connection and tells the test server your address. Nothing runs unless this is ticked.</div>
          <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
            <label className="stack" style={{ gap: 4 }}><span>Every (hours)</span><input className="field" type="number" min={1} max={168} style={{ width: 100 }} value={f.hours} onChange={num("hours")} /></label>
            <label className="stack" style={{ gap: 4 }}><span>Test size (MB)</span><input className="field" type="number" min={1} max={200} style={{ width: 100 }} value={f.mb} onChange={num("mb")} /></label>
            <label className="stack" style={{ gap: 4 }}><span>Warn below (Mbit/s)</span><input className="field" type="number" min={0} style={{ width: 130 }} value={f.min} placeholder="no limit" onChange={num("min")} /></label>
          </div>
          <div className="hint">About {Math.round((Number(f.mb) * 1.4 * (24 / Math.max(1, Number(f.hours)))) || 0)} MB of data per day at these settings. A faster connection can use a larger test for a more accurate figure.</div>
          <label className="stack" style={{ gap: 4 }}><span>Download test address</span><input className="field" value={f.down} onChange={(e) => setF({ ...f, down: e.target.value })} /></label>
          <label className="stack" style={{ gap: 4 }}><span>Upload test address</span><input className="field" value={f.up} onChange={(e) => setF({ ...f, up: e.target.value })} /></label>
          <div><button className="btn primary" disabled={saving}>{saving ? "Saving…" : "Save"}</button></div>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function LatencyPanel({ nets }: { nets: InstanceUpdate[] }) {
  const L = useLumina();
  return (
    <section className="panel">
      <div className="panel-head"><h2>Latency and packet loss</h2><span className="meta">last 1 hour trend</span></div>
      {nets.map((i) => {
        const d = i.data as NetData;
        return (
          <div key={i.instanceId} className="table-wrap">
            {nets.length > 1 && <div className="sub" style={{ margin: "6px 0" }}>{i.instanceId}</div>}
            <table>
              <thead><tr><th></th><th>Check</th><th>Type</th><th className="num">Latency</th><th>Trend</th><th className="num">Loss</th></tr></thead>
              <tbody>
                {d.targets.map((t) => (
                  <tr key={t.name} title={t.error ?? undefined}>
                    <td><span className={`dot ${t.ok ? (t.lossPct >= d.warn.lossPct || (t.ms ?? 0) >= d.warn.latencyMs ? "degraded" : "connected") : "disconnected"}`} /></td>
                    <td>{t.name}{L.can.operate && <span className="sub"> · {t.target}</span>}</td>
                    <td><span className="tag">{t.kind}</span></td>
                    <td className="num">{t.ok ? `${t.ms ?? "—"} ms` : <span style={{ color: "var(--bad)" }}>{t.error ?? "down"}</span>}</td>
                    <td style={{ width: 130 }}><Spark instanceId={i.instanceId} metric={`rtt:${metricName(t.name)}`} unit=" ms" /></td>
                    <td className="num">{t.lossPct}%<span className="sub"> · {t.recentLossPct ?? t.lossPct}% recent</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </section>
  );
}

function LinksPanel({ snmps }: { snmps: InstanceUpdate[] }) {
  useSpeedUnit();
  return (
    <section className="panel">
      <div className="panel-head"><h2>Links</h2><span className="meta">from SNMP</span></div>
      {snmps.map((i) => {
        const d = i.data as SnmpData;
        return (
          <div key={i.instanceId} className="table-wrap">
            <div className="sub" style={{ margin: "6px 0" }}>{d.sysName ?? i.instanceId}</div>
            <table>
              <thead><tr><th></th><th>Interface</th><th className="num">Speed</th><th className="num">In</th><th className="num">Out</th><th>Load</th></tr></thead>
              <tbody>
                {d.interfaces.map((l) => (
                  <tr key={l.index}>
                    <td><span className={`dot ${l.up ? "connected" : l.watched ? "disconnected" : "pending"}`} /></td>
                    <td>{l.name}{l.watched && <span className="tag" style={{ marginLeft: 6 }}>watched</span>}</td>
                    <td className="num">{l.speedMbps ? mbps(l.speedMbps) : "—"}</td>
                    <td className="num">{bitrate(l.inBps)}</td><td className="num">{bitrate(l.outBps)}</td>
                    <td style={{ minWidth: 120 }}>{l.up && l.utilPct !== null ? <div className="bar"><i className={barClass(l.utilPct / 100)} style={{ width: clamp(l.utilPct) }} /></div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </section>
  );
}
