import { useEffect, useState } from "react";
import { api, type AuditEntry } from "../api";

export function AuditPage() {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.audit(200).then(setRows).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => { void load(); }, []);

  return (
    <div className="stack">
      <div className="page-title"><h1>Audit log</h1><span className="grow" /><button className="btn sm" onClick={() => void load()}>Refresh</button></div>
      <section className="panel">
        {error && <div className="error">{error}</div>}
        {!rows && !error && <div className="empty">Loading…</div>}
        {rows && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Who</th><th>What</th><th>Target</th><th>Detail</th><th>From</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
                    <td>{r.user ?? <span className="sub">anonymous</span>}</td>
                    <td><span className={`tag ${/failed|blocked|dangerous/.test(r.action) ? "warn" : ""}`}>{r.action}</span></td>
                    <td>{r.target ?? "—"}</td>
                    <td className="sub" style={{ whiteSpace: "normal", maxWidth: 360 }}>{r.detail ?? ""}</td>
                    <td className="sub">{r.ip ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
