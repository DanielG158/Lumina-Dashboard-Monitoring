import { useCallback, useEffect, useRef, useState } from "react";
import { api, type EventRow } from "../api";
import { useLumina } from "../context";
import { ago, every } from "../summaries";

const when = (s: number) => new Date(s * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
function length(a: number, b: number) {
  const s = Math.max(0, b - a);
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 86400)} d`;
}

export function AlertsPage() {
  const L = useLumina();
  const [busy, setBusy] = useState<string | null>(null);
  const { active, recent, muted } = L.alerts;

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    try { await fn(); await L.reloadAlerts(); } catch (err) { L.notify(err instanceof Error ? err.message : String(err), true); } finally { setBusy(null); }
  }

  return (
    <div className="stack">
      <div className="page-title"><h1>Alerts</h1><span className="grow" /><span className="sub">Checked every poll; a problem must persist for a couple of polls before it is raised.</span></div>

      <section className="panel">
        <div className="panel-head"><h2>Active <span className="tag">{active.length}</span></h2></div>
        {active.length === 0 ? (
          <div className="empty"><span className="dot up" style={{ marginRight: 8 }} />All clear — nothing needs attention.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th></th><th>Problem</th><th>Where</th><th>Since</th>{L.can.operate && <th className="num">Actions</th>}</tr></thead>
              <tbody>
                {active.map((a) => (
                  <tr key={a.id}>
                    <td><span className={`dot ${a.severity}`} title={a.severity} /></td>
                    <td style={{ whiteSpace: "normal" }}><b>{a.title}</b>{a.suppressed && <span className="tag" style={{ marginLeft: 6 }}>in maintenance</span>}{a.detail && <div className="sub">{a.detail}</div>}</td>
                    <td>{a.instanceId}</td>
                    <td className="sub">{ago(a.since * 1000)}</td>
                    {L.can.operate && <td><div className="actions"><button className="btn sm" disabled={busy === a.key} title="Stop raising and notifying about this until you unmute it" onClick={() => act(a.key, () => api.mute(a.key))}>Mute</button></div></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {muted.length > 0 && (
        <section className="panel">
          <div className="panel-head"><h2>Muted <span className="tag">{muted.length}</span></h2></div>
          <div className="chips">
            {muted.map((k) => (
              <span key={k} className="pill">
                <span>{k}</span>
                {L.can.operate && <button className="btn sm" style={{ padding: "0 7px" }} disabled={busy === k} onClick={() => act(k, () => api.unmute(k))}>Unmute</button>}
              </span>
            ))}
          </div>
        </section>
      )}

      <History />
      <div className="hint">Refresh rates are set per instance (Instances → Edit). Current: {L.instances.map((i) => `${i.instanceId} ${every(i.intervalMs)}`).join(" · ") || "—"}</div>
    </div>
  );
}

const PERIODS: [string, string, number][] = [["24h", "Last 24 hours", 86400], ["7d", "Last 7 days", 7 * 86400], ["30d", "Last 30 days", 30 * 86400], ["90d", "Last 90 days", 90 * 86400], ["all", "Everything kept", 0]];

function csvCell(v: unknown) {
  const t = String(v ?? "");
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** Every alert that was ever raised (as far back as it is kept), with filters, search and paging. */
function History() {
  const L = useLumina();
  const [period, setPeriod] = useState("7d");
  const [severity, setSeverity] = useState("");
  const [state, setState] = useState("");
  const [instance, setInstance] = useState("");
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<EventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [more, setMore] = useState(false);
  const [names, setNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 300); return () => clearTimeout(t); }, [text]);

  const filters = useCallback(() => {
    const secs = PERIODS.find((p) => p[0] === period)?.[2] ?? 0;
    return { severity, state, instance, q, since: secs ? Math.floor(Date.now() / 1000) - secs : undefined };
  }, [period, severity, state, instance, q]);

  const load = useCallback(async (append: boolean, before?: number) => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const r = await api.alertHistory({ ...filters(), before, limit: 50 });
      if (mine !== seq.current) return;
      setRows((cur) => (append ? [...cur, ...r.events] : r.events));
      setTotal(r.total); setMore(r.hasMore); setNames(r.instances);
    } catch (e) { L.notify(e instanceof Error ? e.message : String(e), true); } finally { if (mine === seq.current) setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  useEffect(() => { void load(false); }, [load]);
  // New alerts arrive while the page is open.
  useEffect(() => { const t = setTimeout(() => void load(false), 500); return () => clearTimeout(t); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L.alerts.active.length, L.alerts.recent[0]?.id]);

  function exportCsv() {
    const head = ["raised", "severity", "state", "instance", "problem", "details", "resolved"];
    const lines = rows.map((e) => [new Date(e.ts * 1000).toISOString(), e.severity, e.state, e.instanceId, e.title, e.detail ?? "", e.resolvedTs ? new Date(e.resolvedTs * 1000).toISOString() : ""].map(csvCell).join(","));
    const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `lumina-alerts-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(a.href);
  }

  const instances = [...new Set([...names, ...L.instances.map((i) => i.instanceId)])].sort();
  const filtered = Boolean(severity || state || instance || q || period !== "all");
  return (
    <section className="panel">
      <div className="panel-head"><h2>History <span className="tag">{total}</span></h2><span className="meta">{loading ? "loading…" : `showing ${rows.length} of ${total}`}</span></div>
      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <input className="field" type="search" placeholder="Search problems and details" value={text} onChange={(e) => setText(e.target.value)} style={{ minWidth: 220, flex: 1 }} aria-label="Search alert history" />
        <select className="field" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period">{PERIODS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        <select className="field" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity"><option value="">Any severity</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option></select>
        <select className="field" value={state} onChange={(e) => setState(e.target.value)} aria-label="State"><option value="">Active and resolved</option><option value="firing">Still active</option><option value="resolved">Resolved</option></select>
        <select className="field" value={instance} onChange={(e) => setInstance(e.target.value)} aria-label="Instance"><option value="">All instances</option>{instances.map((n) => <option key={n} value={n}>{n}</option>)}</select>
        {filtered && <button className="btn sm" onClick={() => { setPeriod("all"); setSeverity(""); setState(""); setInstance(""); setText(""); }}>Show everything</button>}
        <button className="btn sm" disabled={rows.length === 0} onClick={exportCsv} title="Download the rows shown as a spreadsheet file">Export CSV</button>
      </div>
      {rows.length === 0 && !loading ? <div className="empty">{filtered ? "Nothing matches these filters." : "Nothing has been raised yet."}</div> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th></th><th>Raised</th><th>Problem</th><th>Where</th><th>Lasted</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td><span className={`dot ${e.state === "firing" ? e.severity : "up"}`} title={`${e.severity}, ${e.state}`} /></td>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(e.ts * 1000).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                  <td style={{ whiteSpace: "normal" }}>{e.title}{e.detail && <div className="sub" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{e.detail}</div>}</td>
                  <td>{e.instanceId}</td>
                  <td className="sub">{e.state === "firing" ? "still active" : e.resolvedTs ? length(e.ts, e.resolvedTs) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more && <div style={{ marginTop: 10 }}><button className="btn" disabled={loading} onClick={() => void load(true, rows[rows.length - 1]?.id)}>Show 50 more</button></div>}
    </section>
  );
}
