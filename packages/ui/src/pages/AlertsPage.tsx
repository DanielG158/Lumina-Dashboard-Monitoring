import { useState } from "react";
import { api } from "../api";
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

      <section className="panel">
        <div className="panel-head"><h2>History</h2></div>
        {recent.length === 0 ? <div className="empty">Nothing has been raised yet.</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th></th><th>Raised</th><th>Problem</th><th>Where</th><th>Lasted</th></tr></thead>
              <tbody>
                {recent.map((e) => (
                  <tr key={e.id}>
                    <td><span className={`dot ${e.state === "firing" ? e.severity : "up"}`} title={e.state} /></td>
                    <td>{when(e.ts)}</td>
                    <td style={{ whiteSpace: "normal" }}>{e.title}{e.detail && <span className="sub"> · {e.detail}</span>}</td>
                    <td>{e.instanceId}</td>
                    <td className="sub">{e.state === "firing" ? "still active" : e.resolvedTs ? length(e.ts, e.resolvedTs) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="hint">Refresh rates are set per instance (Instances → Edit). Current: {L.instances.map((i) => `${i.instanceId} ${every(i.intervalMs)}`).join(" · ") || "—"}</div>
    </div>
  );
}
