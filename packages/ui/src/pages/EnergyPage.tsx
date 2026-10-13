import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type EnergyResult, type EnergySettings, type EnergySource, type Period, type TouRule } from "../api";
import { useLumina } from "../context";
import { browserTz, dateTime, fromLocalInput, kwhText, money, toDateInput } from "../format";

const RANGES: [string, string][] = [["today", "Today"], ["yesterday", "Yesterday"], ["7d", "7 days"], ["30d", "30 days"], ["cycle", "This billing cycle"], ["lastcycle", "Last cycle"], ["custom", "Pick dates"]];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Bars({ data, mode, currency }: { data: EnergyResult; mode: "kwh" | "cost"; currency: EnergyResult["currency"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = data.series.map((p) => (mode === "kwh" ? p.kwh : p.cost));
  const max = Math.max(...values, 0.0001);
  const W = 720, H = 200, L = 8, R = 8, T = 14, B = 26;
  const bw = (W - L - R) / Math.max(1, data.series.length);
  const every = Math.ceil(data.series.length / 12);
  const p = hover !== null ? data.series[hover] : null;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Energy per period" onPointerLeave={() => setHover(null)}>
        {[0.5, 1].map((f) => <line key={f} x1={L} x2={W - R} y1={T + (1 - f) * (H - T - B)} y2={T + (1 - f) * (H - T - B)} className="grid-line" />)}
        {data.series.map((pt, i) => {
          const h = ((mode === "kwh" ? pt.kwh : pt.cost) / max) * (H - T - B);
          return (
            <g key={pt.t} onPointerMove={() => setHover(i)}>
              <rect x={L + i * bw} y={T} width={bw} height={H - T - B} fill="transparent" />
              <rect x={L + i * bw + bw * 0.15} y={H - B - h} width={bw * 0.7} height={Math.max(0, h)} rx={2} className={`ebar ${hover === i ? "on" : ""}`} />
              {i % every === 0 && <text x={L + i * bw + bw / 2} y={H - 8} textAnchor="middle" className="axis" style={{ fontSize: 6.5 }}>{data.granularity === "hour" ? pt.label : pt.label.slice(5)}</text>}
            </g>
          );
        })}
      </svg>
      <div className="chart-readout">
        {p ? <><b>{mode === "kwh" ? kwhText(p.kwh) : money(currency, p.cost)}</b> <span className="sub">{p.label}{p.avgW !== null ? ` · average ${Math.round(p.avgW)} W` : " · no readings"} · {mode === "kwh" ? money(currency, p.cost) : kwhText(p.kwh)}</span></> : <span className="sub">Hover a bar for details</span>}
      </div>
    </div>
  );
}

export function EnergyPage() {
  const L = useLumina();
  const tz = useMemo(() => browserTz(), []);
  const [range, setRange] = useState("cycle");
  const [period, setPeriod] = useState<Period>(() => { const y = toDateInput(Date.now() / 1000 - 86400); return { from: y, to: y }; });
  const [mode, setMode] = useState<"kwh" | "cost">("kwh");
  const [data, setData] = useState<EnergyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(() => api.energy(range, tz, period).then((d) => { setData(d); setError(null); }).catch((e) => setError(err(e))), [range, tz, period]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 60_000); return () => clearInterval(t); }, [load]);

  // The first time an admin opens this page, remember their time zone so "today" and billing days line up with their clock.
  useEffect(() => {
    if (!L.can.admin) return;
    api.energySettings().then(({ settings }) => {
      if (settings.timezone === null) api.saveEnergySettings({ ...settings, timezone: tz }).then(() => { L.notify(`Time zone set to ${tz} from your browser (change it under Prices and settings)`); void load(); }).catch(() => undefined);
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L.can.admin]);

  const c = data?.currency;
  const today = toDateInput(Date.now() / 1000);
  const shiftDay = (d: string, n: number) => { const t = new Date(`${d}T12:00:00`); t.setDate(t.getDate() + n); return toDateInput(t.getTime() / 1000); };
  const setDates = (from: string, to: string) => { if (from && to) setPeriod(to < from ? { from: to, to: from } : { from, to }); };
  const spanDays = Math.round((Date.parse(period.to) - Date.parse(period.from)) / 86400000) + 1;
  const step = (dir: -1 | 1) => { const f = shiftDay(period.from, dir * spanDays), t = shiftDay(period.to, dir * spanDays); if (dir > 0 && f > today) return; setPeriod({ from: f, to: t }); };
  const cycle = range === "cycle" || range === "lastcycle";
  const projected = data?.projection;
  const budget = data?.budget;

  return (
    <div className="stack">
      <div className="page-title">
        <h1>Energy</h1><span className="grow" />
        {L.can.admin && <button className="btn" onClick={() => setShowSettings((s) => !s)}>{showSettings ? "Hide prices and settings" : "Prices and settings"}</button>}
      </div>

      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="seg" role="group" aria-label="Period" style={{ flexWrap: "wrap" }}>
          {RANGES.map(([id, label]) => <button key={id} className={id === range ? "on" : ""} onClick={() => setRange(id)}>{label}</button>)}
        </div>
        <div className="seg" role="group" aria-label="Show">
          <button className={mode === "kwh" ? "on" : ""} onClick={() => setMode("kwh")}>kWh</button>
          <button className={mode === "cost" ? "on" : ""} onClick={() => setMode("cost")}>{c?.symbol ?? "Cost"}</button>
        </div>
      </div>

      {range === "custom" && (
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <button className="btn" aria-label="Previous period" title="Previous period" onClick={() => step(-1)}>◀</button>
          <label className="row"><span className="sub">from</span><input className="field" type="date" max={today} value={period.from} onChange={(e) => setDates(e.target.value, period.to < e.target.value ? e.target.value : period.to)} /></label>
          <label className="row"><span className="sub">to</span><input className="field" type="date" max={today} value={period.to} onChange={(e) => setDates(period.from > e.target.value ? e.target.value : period.from, e.target.value)} /></label>
          <button className="btn" aria-label="Next period" title="Next period" disabled={shiftDay(period.from, spanDays) > today} onClick={() => step(1)}>▶</button>
          <span className="sub">{spanDays === 1 ? "one day" : `${spanDays} days`} · pick the same date twice for a single day</span>
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {data?.settingsNote && <div className="panel empty">{data.settingsNote}</div>}

      {data && c && !data.settingsNote && (
        <>
          <div className="kpis" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
            <div className="kpi neutral"><div className="k-label">Energy used</div><div className="k-value">{data.kwh >= 100 ? data.kwh.toFixed(0) : data.kwh.toFixed(2)}<small>kWh</small></div><div className="k-sub">{data.avgW !== null ? `average ${Math.round(data.avgW)} W` : "no readings"}</div></div>
            <div className="kpi neutral">
              <div className="k-label">{cycle ? "Cost this cycle" : "Cost"}</div>
              <div className="k-value" style={{ fontSize: "1.5em" }}>{money(c, data.cost.total)}</div>
              <div className="k-sub">{cycle ? `energy ${money(c, data.cost.energy)}${data.cost.fixed ? ` + fee ${money(c, data.cost.fixed)}` : ""}${data.cost.tax ? ` + tax ${money(c, data.cost.tax)}` : ""}` : `${data.tariffType === "flat" ? "flat rate" : data.tariffType === "tou" ? "time-of-day rates" : "progressive blocks"}${data.cost.tax ? ` + ${money(c, data.cost.tax)} tax` : ""}`}</div>
            </div>
            <div className="kpi neutral"><div className="k-label">Peak / lowest</div><div className="k-value">{data.peakW !== null ? Math.round(data.peakW) : "—"}<small>W</small></div><div className="k-sub">lowest {data.minW !== null ? `${Math.round(data.minW)} W` : "—"}</div></div>
            {projected && (
              <div className={`kpi ${budget && budget.projectedPct !== null && budget.projectedPct > 100 ? "warning" : "neutral"}`}>
                <div className="k-label">Projected for the cycle</div>
                <div className="k-value" style={{ fontSize: "1.5em" }}>{money(c, projected.cost.total)}</div>
                <div className="k-sub">≈ {projected.kwh.toFixed(0)} kWh · {projected.daysLeft.toFixed(0)} days left</div>
              </div>
            )}
            <div className={`kpi ${data.coverage < 0.9 ? "warning" : "ok"}`}>
              <div className="k-label">Data quality</div>
              <div className="k-value">{Math.round(data.coverage * 100)}<small>% measured</small></div>
              <div className="k-sub">{data.estimatedKwh > 0.005 ? `${data.estimatedKwh.toFixed(2)} kWh estimated` : "nothing estimated"}</div>
            </div>
          </div>

          {budget && (
            <div className="panel">
              <div className="row" style={{ justifyContent: "space-between" }}><b>Monthly budget</b><span className="sub">{money(c, budget.used)} of {money(c, budget.amount)}{budget.projected !== null ? ` · projected ${money(c, budget.projected)}` : ""}</span></div>
              <div className="bar" style={{ height: 10 }}><i className={budget.usedPct >= 100 ? "bad" : budget.projectedPct !== null && budget.projectedPct > 100 ? "warn" : ""} style={{ width: `${Math.min(100, budget.usedPct)}%` }} /></div>
            </div>
          )}

          <section className="panel">
            <div className="panel-head"><h2>{data.granularity === "hour" ? "By hour" : "By day"}</h2><span className="meta">{dateTime(data.from)} – {dateTime(Math.min(data.to, Date.now() / 1000))} · {data.timezone}</span></div>
            <Bars data={data} mode={mode} currency={c} />
          </section>

          <div className="two-col">
            {data.breakdown && (
              <section className="panel" style={{ marginBottom: 0 }}>
                <div className="panel-head"><h2>Where the power goes</h2></div>
                <div className="stack">
                  <div style={{ display: "flex", height: 22, borderRadius: 6, overflow: "hidden" }}>
                    <div title={data.breakdown.serverLabel} style={{ width: `${data.breakdown.serverShare * 100}%`, background: "var(--accent)" }} />
                    <div style={{ flex: 1, background: "var(--warn)" }} />
                  </div>
                  <div className="kv">
                    <span><i className="dot" style={{ background: "var(--accent)", marginRight: 6 }} />{data.breakdown.serverLabel} (server)</span><span><b>{kwhText(data.breakdown.serverKwh)}</b> · {money(c, data.cost.energy * data.breakdown.serverShare)} · {Math.round(data.breakdown.serverShare * 100)}%</span>
                    <span><i className="dot" style={{ background: "var(--warn)", marginRight: 6 }} />{data.breakdown.otherLabel}</span><span><b>{kwhText(data.breakdown.otherKwh)}</b> · {money(c, data.cost.energy * (1 - data.breakdown.serverShare))} · {Math.round((1 - data.breakdown.serverShare) * 100)}%</span>
                  </div>
                  <div className="hint">The server's share is measured by its own iLO (accurate to a few percent). The rest is whatever else is plugged into the UPS, plus the UPS's own losses.</div>
                </div>
              </section>
            )}
            {data.byHour.length > 0 && (
              <section className="panel" style={{ marginBottom: 0 }}>
                <div className="panel-head"><h2>Typical day</h2><span className="meta">average watts by hour</span></div>
                <svg viewBox="0 0 240 90" style={{ width: "100%" }} role="img" aria-label="Average power by hour of day">
                  {(() => {
                    const m = Math.max(...data.byHour.map((h) => h.avgW), 1);
                    return data.byHour.map((h) => <rect key={h.hour} x={h.hour * 10 + 1} y={80 - (h.avgW / m) * 70} width={8} height={(h.avgW / m) * 70} rx={1.5} className="ebar" ><title>{`${String(h.hour).padStart(2, "0")}:00 — ${Math.round(h.avgW)} W`}</title></rect>);
                  })()}
                  {[0, 6, 12, 18].map((h) => <text key={h} x={h * 10 + 5} y={89} className="axis" textAnchor="middle" style={{ fontSize: 4.5 }}>{String(h).padStart(2, "0")}</text>)}
                </svg>
              </section>
            )}
          </div>

          {data.guests && <GuestCosts data={data} currency={c} />}

          <section className="panel">
            <div className="panel-head"><h2>How this is measured</h2></div>
            <div className="stack" style={{ fontSize: 13 }}>
              <div>Source: <b>{data.source?.label ?? "none"}</b>. {data.source?.kind === "ups" ? "A UPS reports its load as a percentage, which is turned into watts using its rated power. It is an estimate, usually within about ±10%, and it does not include the UPS's own losses." : "The iLO reads the server's power supplies directly, so this is accurate, but it only covers the server."}</div>
              <div>Adjustments in use: ×{data.adjustments.calibration} calibration, +{data.adjustments.extraWatts} W for unmetered equipment, gaps {data.adjustments.gapFill === "estimate" ? "estimated" : "left empty"}.</div>
              <div>Readings are taken every few seconds and averaged per 30 minutes, which is accurate for energy. Gaps (Lumina or the device offline) are the biggest error, so the "data quality" tile tells you how much was actually measured.</div>
              <div>For a real-world check, compare with your electricity meter: <b>Prices and settings, Calibrate against your meter</b> works out a correction factor for you.</div>
              {data.sources.length > 1 && <div className="hint">Other sources available: {data.sources.map((s: EnergySource) => s.label).join(" · ")}.</div>}
            </div>
          </section>
        </>
      )}

      {showSettings && L.can.admin && <PriceSettings tz={tz} range={range} period={period} current={data} onSaved={() => void load()} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function Num({ value, onChange, step = "any", min, max, width }: { value: number; onChange: (n: number) => void; step?: string; min?: number; max?: number; width?: number }) {
  return <input className="field" type="number" step={step} min={min} max={max} value={Number.isFinite(value) ? value : ""} style={width ? { width } : undefined} onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))} />;
}
function F({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return <label className="stack" style={{ gap: 4 }}><span>{label}</span>{children}{help && <span className="hint">{help}</span>}</label>;
}

function GuestCosts({ data, currency }: { data: EnergyResult; currency: NonNullable<EnergyResult["currency"]> }) {
  const g = data.guests!;
  const top = Math.max(...g.list.map((x) => x.kwh), 1e-9);
  const name = (id: string, vmid: number) => data.guestNames[id]?.name ?? `guest ${vmid}`;
  return (
    <section className="panel">
      <div className="panel-head"><h2>Cost per VM and container</h2><span className="meta">the server's {kwhText(g.serverKwh)} · {money(currency, g.serverCost)}</span></div>
      {g.list.length === 0 ? (
        <div className="empty">No guest activity has been recorded for this period yet. Lumina started keeping it recently, so it fills in from now on.</div>
      ) : (
        <div className="stack">
          {g.list.map((x) => {
            const id = `${x.instanceId}:${x.vmid}`;
            const info = data.guestNames[id];
            return (
              <div className="guest-row" key={id} title={`${x.avgCores.toFixed(2)} cores on average while running · ran ${x.hoursRunning.toFixed(1)} h`}>
                <span>{name(id, x.vmid)} <span className="sub">{info ? `${info.type === "qemu" ? "VM" : "CT"} ${x.vmid}` : `#${x.vmid}`}</span></span>
                <div className="bar" style={{ height: 8 }}><i style={{ width: `${(x.kwh / top) * 100}%` }} /></div>
                <span className="num"><b>{x.kwh.toFixed(2)}</b> kWh</span>
                <span className="num">{money(currency, x.cost)}</span>
              </div>
            );
          })}
          <div className="kv">
            <span>Proxmox host itself</span><span>{kwhText(g.hostKwh)}</span>
            {g.unattributedKwh > 0.005 && <><span>No guest data recorded</span><span>{kwhText(g.unattributedKwh)}</span></>}
          </div>
        </div>
      )}
      <div className="hint">An estimate, not a measurement: the iLO measures the whole server, and Lumina divides it by how much CPU each guest used, plus an equal share for just being switched on. Tax is included; the fixed monthly fee is not. {g.coverage < 0.95 ? `Only ${Math.round(g.coverage * 100)}% of this period has guest data. ` : ""}Adjust the split under Prices and settings.</div>
    </section>
  );
}

function PriceSettings({ tz, range, period, current, onSaved }: { tz: string; range: string; period: Period; current: EnergyResult | null; onSaved: () => void }) {
  const L = useLumina();
  const [s, setS] = useState<EnergySettings | null>(null);
  const [sources, setSources] = useState<EnergySource[]>([]);
  const [saved, setSaved] = useState<EnergySettings | null>(null);
  const [preview, setPreview] = useState<EnergyResult | null>(null);
  const [cal, setCal] = useState({ startDate: "", endDate: "", startKwh: "", endKwh: "" });
  const [calResult, setCalResult] = useState<{ luminaKwh: number; estimatedKwh: number; coverage: number; factor: number; meterKwh: number } | null>(null);
  const zones = useMemo(() => { try { return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone"); } catch { return []; } }, []);

  // Load once. The app context changes whenever any device updates, so depending on it would wipe unsaved edits.
  const { notify } = L;
  useEffect(() => { api.energySettings().then((r) => { setS(r.settings); setSaved(r.settings); setSources(r.sources); }).catch((e) => notify(err(e), true)); }, [notify]);
  if (!s) return <div className="panel empty">Loading…</div>;
  const set = (patch: Partial<EnergySettings>) => setS({ ...s, ...patch });
  const setTariff = (patch: Partial<EnergySettings["tariff"]>) => setS({ ...s, tariff: { ...s.tariff, ...patch } });
  const c = s.currency;
  const dirty = JSON.stringify(s) !== JSON.stringify(saved);

  async function save() {
    try { await api.saveEnergySettings(s!); setSaved(s); setPreview(null); L.notify("Prices and settings saved"); onSaved(); } catch (e) { L.notify(err(e), true); }
  }
  async function runPreview() {
    try { setPreview(await api.previewEnergy(s!, range, tz, period)); } catch (e) { L.notify(err(e), true); }
  }
  async function calibrate() {
    const meter = Number(cal.endKwh) - Number(cal.startKwh);
    if (!cal.startDate || !cal.endDate || !(meter > 0)) return L.notify("Enter both dates and both meter readings (the end reading must be higher)", true);
    try {
      setCalResult(await api.calibrate({ from: fromLocalInput(`${cal.startDate}T00:00`), to: fromLocalInput(`${cal.endDate}T00:00`), meterKwh: meter }));
    } catch (e) { L.notify(err(e), true); }
  }

  const rule = (i: number, patch: Partial<TouRule>) => setTariff({ tou: { ...s.tariff.tou, rules: s.tariff.tou.rules.map((r, k) => (k === i ? { ...r, ...patch } : r)) } });

  return (
    <section className="panel stack">
      <div className="panel-head"><h2>Prices and settings</h2>{dirty && <span className="tag warn">unsaved changes</span>}</div>

      <div className="stack">
        <h3 style={{ margin: 0 }}>Electricity price</h3>
        <div className="seg" role="group" style={{ alignSelf: "start" }}>
          {([["flat", "One price"], ["tou", "By time of day"], ["tiered", "Progressive blocks"]] as const).map(([id, label]) => <button key={id} className={s.tariff.type === id ? "on" : ""} onClick={() => setTariff({ type: id })}>{label}</button>)}
        </div>

        {s.tariff.type === "flat" && <F label={`Price per kWh (${c.symbol})`} help="Your rate. Rp 1,661 is the default."><Num value={s.tariff.flat.price} min={0} onChange={(n) => setTariff({ flat: { price: n } })} width={160} /></F>}

        {s.tariff.type === "tou" && (
          <div className="stack">
            <F label={`Price when no rule below applies (${c.symbol} per kWh)`}><Num value={s.tariff.tou.defaultPrice} min={0} onChange={(n) => setTariff({ tou: { ...s.tariff.tou, defaultPrice: n } })} width={160} /></F>
            {s.tariff.tou.rules.map((r, i) => (
              <div key={i} className="subpanel stack" style={{ marginTop: 0 }}>
                <div className="row">
                  <input className="field" value={r.name} placeholder="Name, e.g. Night" maxLength={40} onChange={(e) => rule(i, { name: e.target.value })} />
                  <label className="row"><span className="sub">from</span><input className="field" type="time" value={r.start} onChange={(e) => rule(i, { start: e.target.value })} /></label>
                  <label className="row"><span className="sub">to</span><input className="field" type="time" value={r.end} onChange={(e) => rule(i, { end: e.target.value })} /></label>
                  <label className="row"><span className="sub">{c.symbol}/kWh</span><Num value={r.price} min={0} onChange={(n) => rule(i, { price: n })} width={110} /></label>
                  <button className="btn sm danger" onClick={() => setTariff({ tou: { ...s.tariff.tou, rules: s.tariff.tou.rules.filter((_, k) => k !== i) } })}>Remove</button>
                </div>
                <div className="chips" style={{ marginBottom: 0 }}>
                  {DAYS.map((d, k) => <button key={d} type="button" className={`chip ${r.days.includes(k) ? "on" : ""}`} onClick={() => rule(i, { days: r.days.includes(k) ? r.days.filter((x) => x !== k) : [...r.days, k].sort() })}>{d}</button>)}
                </div>
                <div className="hint">If "to" is earlier than "from" the rule runs overnight and belongs to the day it starts on. The first matching rule wins.</div>
              </div>
            ))}
            <div><button className="btn sm" onClick={() => setTariff({ tou: { ...s.tariff.tou, rules: [...s.tariff.tou.rules, { name: "", days: [0, 1, 2, 3, 4, 5, 6], start: "22:00", end: "06:00", price: s.tariff.tou.defaultPrice }] } })}>+ Add a time-of-day rule</button></div>
          </div>
        )}

        {s.tariff.type === "tiered" && (
          <div className="stack">
            <div className="hint">Each block applies to the kWh used in a billing cycle, in order. The last block has no limit.</div>
            {s.tariff.tiers.map((t, i) => {
              const last = i === s.tariff.tiers.length - 1;
              return (
                <div key={i} className="row">
                  <span className="sub" style={{ width: 70 }}>{i === 0 ? "First" : "Next"}</span>
                  {last ? <span style={{ width: 130 }}>the rest</span> : <Num value={t.upToKwh ?? NaN} min={0} onChange={(n) => setTariff({ tiers: s.tariff.tiers.map((x, k) => (k === i ? { ...x, upToKwh: n } : x)) })} width={130} />}
                  <span className="sub">{last ? "" : "kWh (cumulative limit)"}</span>
                  <label className="row"><span className="sub">{c.symbol}/kWh</span><Num value={t.price} min={0} onChange={(n) => setTariff({ tiers: s.tariff.tiers.map((x, k) => (k === i ? { ...x, price: n } : x)) })} width={110} /></label>
                  {s.tariff.tiers.length > 1 && <button className="btn sm danger" onClick={() => setTariff({ tiers: s.tariff.tiers.filter((_, k) => k !== i).map((x, k, a) => (k === a.length - 1 ? { ...x, upToKwh: null } : x)) })}>Remove</button>}
                </div>
              );
            })}
            <div><button className="btn sm" onClick={() => { const t = s.tariff.tiers; const last = t[t.length - 1]; const prev = t.length > 1 ? (t[t.length - 2].upToKwh ?? 0) : 0; setTariff({ tiers: [...t.slice(0, -1), { upToKwh: prev + 100, price: last.price }, { upToKwh: null, price: last.price }] }); }}>+ Add a block</button></div>
          </div>
        )}
      </div>

      <div className="row" style={{ alignItems: "flex-start" }}>
        <F label={`Fixed monthly charge (${c.symbol})`} help="Standing or subscription fee, added once per billing cycle."><Num value={s.fixedMonthly} min={0} onChange={(n) => set({ fixedMonthly: n })} width={150} /></F>
        <F label="Tax / levy (%)" help="Applied to energy plus the fixed charge."><Num value={s.taxPercent} min={0} max={100} onChange={(n) => set({ taxPercent: n })} width={100} /></F>
        <F label="Billing cycle starts on day" help="1–28 of each month."><Num value={s.billingDay} step="1" min={1} max={28} onChange={(n) => set({ billingDay: n })} width={90} /></F>
        <F label="Guest cost: shared equally (%)" help="How much of each guest's share is the same for every running guest, because RAM and idle CPU cost power even when nothing happens. The rest follows CPU use."><Num value={s.guestSplit.baselinePct} min={0} max={100} onChange={(n) => set({ guestSplit: { ...s.guestSplit, baselinePct: n } })} width={100} /></F>
        <F label="Guest cost: kept for the host (%)" help="Part of the server's power not charged to any guest (Proxmox itself, fans, disks)."><Num value={s.guestSplit.hostPct} min={0} max={100} onChange={(n) => set({ guestSplit: { ...s.guestSplit, hostPct: n } })} width={100} /></F>
        <F label={`Monthly budget (${c.symbol}, optional)`} help="Raises an alert when exceeded or when on course to be."><input className="field" type="number" min={0} style={{ width: 160 }} value={s.budgetMonthly ?? ""} placeholder="no budget" onChange={(e) => set({ budgetMonthly: e.target.value === "" ? null : Number(e.target.value) })} /></F>
      </div>

      <div className="stack">
        <h3 style={{ margin: 0 }}>Currency and display</h3>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <F label="Symbol"><input className="field" style={{ width: 80 }} maxLength={8} value={c.symbol} onChange={(e) => set({ currency: { ...c, symbol: e.target.value } })} /></F>
          <F label="Code"><input className="field" style={{ width: 80 }} maxLength={8} value={c.code} onChange={(e) => set({ currency: { ...c, code: e.target.value } })} /></F>
          <F label="Number format" help="e.g. id-ID, en-US, de-DE"><input className="field" style={{ width: 110 }} value={c.locale} onChange={(e) => set({ currency: { ...c, locale: e.target.value } })} /></F>
          <F label="Decimals"><Num value={c.decimals} step="1" min={0} max={4} onChange={(n) => set({ currency: { ...c, decimals: n } })} width={80} /></F>
          <F label="Symbol position"><select className="field" value={c.position} onChange={(e) => set({ currency: { ...c, position: e.target.value as "before" | "after" } })}><option value="before">before the number</option><option value="after">after the number</option></select></F>
        </div>
        <div className="hint">Looks like: <b>{(() => { try { return money(c, 1234567.89); } catch { return "—"; } })()}</b></div>
      </div>

      <div className="stack">
        <h3 style={{ margin: 0 }}>Measurement</h3>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <F label="Power source" help="Automatic prefers the UPS because it sees everything plugged into it."><select className="field" value={s.source} onChange={(e) => set({ source: e.target.value })}><option value="auto">Automatic</option>{sources.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></F>
          <F label="Calibration factor" help="Multiplies the readings. 1 = no change."><Num value={s.calibration} min={0.1} max={10} onChange={(n) => set({ calibration: n })} width={110} /></F>
          <F label="Extra watts" help="Constant draw Lumina can't see (a switch, a PC, UPS losses)."><Num value={s.extraWatts} min={0} onChange={(n) => set({ extraWatts: n })} width={110} /></F>
        </div>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <F label="When readings are missing" help="Fills outages with the typical power for that hour, and tells you how much is estimated."><select className="field" value={s.gapFill} onChange={(e) => set({ gapFill: e.target.value as "estimate" | "off" })}><option value="estimate">Estimate the gap</option><option value="off">Leave it empty</option></select></F>
          <F label="Longest gap to estimate (hours)" help="Longer gaps are assumed to be switched off."><Num value={s.gapFillMaxHours} step="1" min={1} max={720} onChange={(n) => set({ gapFillMaxHours: n })} width={110} /></F>
          <F label="Time zone" help="Decides when a day starts and which hours are 'night'.">
            <div className="row">
              <input className="field" list="tzlist" style={{ width: 200 }} value={s.timezone ?? ""} placeholder={tz} onChange={(e) => set({ timezone: e.target.value || null })} />
              <datalist id="tzlist">{zones.map((z) => <option key={z} value={z} />)}</datalist>
              <button className="btn sm" type="button" onClick={() => set({ timezone: tz })}>Use mine ({tz})</button>
            </div>
          </F>
        </div>
      </div>

      <div className="subpanel stack" style={{ marginTop: 0 }}>
        <h3 style={{ margin: 0 }}>Calibrate against your meter</h3>
        <div className="hint">Write down your electricity meter's kWh reading on a day, and again a few days later (the longer, the better). Lumina compares its own measurement over the same days and suggests the correction factor.</div>
        <div className="row">
          <label className="row"><span className="sub">Start day</span><input className="field" type="date" value={cal.startDate} max={toDateInput(Date.now() / 1000)} onChange={(e) => setCal({ ...cal, startDate: e.target.value })} /></label>
          <label className="row"><span className="sub">meter</span><input className="field" type="number" step="any" style={{ width: 120 }} value={cal.startKwh} onChange={(e) => setCal({ ...cal, startKwh: e.target.value })} /></label>
          <label className="row"><span className="sub">End day</span><input className="field" type="date" value={cal.endDate} max={toDateInput(Date.now() / 1000)} onChange={(e) => setCal({ ...cal, endDate: e.target.value })} /></label>
          <label className="row"><span className="sub">meter</span><input className="field" type="number" step="any" style={{ width: 120 }} value={cal.endKwh} onChange={(e) => setCal({ ...cal, endKwh: e.target.value })} /></label>
          <button className="btn" onClick={() => void calibrate()}>Compare</button>
        </div>
        <div className="hint">Meter readings are taken at the start of each day, and Lumina's measurement runs from midnight at the start to midnight at the end. If your meter measures more than Lumina does (it will, if other things share the meter), enter the whole meter anyway and use "Extra watts" instead of applying this factor.</div>
        {calResult && (
          <div className="stack">
            <div>Lumina measured <b>{kwhText(calResult.luminaKwh)}</b> ({Math.round(calResult.coverage * 100)}% measured, {calResult.estimatedKwh.toFixed(2)} kWh estimated). Your meter shows <b>{kwhText(calResult.meterKwh)}</b>. Suggested factor: <b>×{calResult.factor.toFixed(3)}</b>{calResult.factor > 1.5 || calResult.factor < 0.67 ? " — that is a big difference, so something else shares the meter or the period has gaps." : "."}</div>
            <div><button className="btn sm primary" onClick={() => { set({ calibration: Math.round(calResult.factor * 1000) / 1000, extraWatts: 0 }); setCalResult(null); }}>Apply this factor (and clear extra watts)</button></div>
          </div>
        )}
      </div>

      <div className="row">
        <button className="btn" onClick={() => void runPreview()}>What would this cost? (preview)</button>
        <button className="btn primary" disabled={!dirty} onClick={() => void save()}>Save</button>
        {dirty && <button className="btn" onClick={() => { setS(saved); setPreview(null); }}>Discard changes</button>}
      </div>
      {preview && current && (
        <div className="subpanel">
          For <b>{range === "custom" ? `${period.from} to ${period.to}` : RANGES.find((r) => r[0] === range)?.[1].toLowerCase()}</b>, these settings give <b>{money(s.currency, preview.cost.total)}</b> for {kwhText(preview.kwh)}; the saved settings give <b>{money(current.currency, current.cost.total)}</b> for {kwhText(current.kwh)}
          {" "}({preview.cost.total >= current.cost.total ? "+" : "−"}{money(s.currency, Math.abs(preview.cost.total - current.cost.total))}). Nothing is saved until you press Save.
        </div>
      )}
    </section>
  );
}
