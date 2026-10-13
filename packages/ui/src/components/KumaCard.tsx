import { ago } from "../summaries";
import { Spark } from "./charts";
import { CardShell, type CardProps } from "./CardShell";

type State = "up" | "down" | "pending" | "maintenance" | "unknown";
interface KumaData {
  monitors: { name: string; type: string; target: string; status: State; responseMs: number | null; certDays: number | null; message?: string | null; value?: number | null; lastBeat?: number | null }[];
  statusPage?: { ok: boolean; error: string | null } | null;
  summary: { up: number; down: number; pending: number; maintenance: number };
}

const ORDER: Record<State, number> = { down: 0, pending: 1, maintenance: 2, unknown: 3, up: 4 };

export function KumaCard(props: CardProps) {
  const d = props.instance.data as KumaData | null;
  const monitors = d ? [...d.monitors].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name)) : [];
  return (
    <CardShell {...props} tag="Uptime Kuma" historyPrefer={["response:avg"]}>
      {d && (
        <>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
            {(["up", "down", "pending", "maintenance"] as const).map((k) => (
              <div className="stat" key={k}>
                <div className="label"><span className={`dot ${k}`} />{k[0].toUpperCase() + k.slice(1)}</div>
                <div className="value">{d.summary[k]}</div>
              </div>
            ))}
          </div>
          {d.statusPage && !d.statusPage.ok && <div className="error" style={{ marginBottom: 8 }}>{d.statusPage.error}</div>}
          {monitors.some((m) => m.type === "push") && (
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", marginBottom: 8 }}>
              {monitors.filter((m) => m.type === "push").map((m) => (
                <div className="stat" key={m.name}>
                  <div className="label"><span className={`dot ${m.status}`} />{m.name}</div>
                  <div className="value" style={{ fontSize: "1.3em" }}>{m.message ?? (m.responseMs !== null ? `${m.responseMs}` : m.status === "up" ? "OK" : m.status)}</div>
                  {m.value !== null && m.value !== undefined && <Spark instanceId={props.instance.instanceId} metric={`push:${m.name}`} range="24h" />}
                  <div className="sub">{m.lastBeat ? `pushed ${ago(m.lastBeat)}` : m.status === "down" ? "no push received" : m.message === null && !d.statusPage ? "add a status page to see the message" : "push monitor"}</div>
                </div>
              ))}
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th></th><th>Monitor</th><th>Type</th><th>Target</th><th className="num">Response</th></tr>
              </thead>
              <tbody>
                {monitors.map((m, i) => (
                  <tr key={`${m.name}-${i}`}>
                    <td><span className={`dot ${m.status}`} /></td>
                    <td>{m.name}</td>
                    <td><span className="tag">{m.type}</span></td>
                    <td className="sub">{m.type === "push" ? (m.message ?? "") : m.target}</td>
                    <td className="num">{m.responseMs !== null ? `${m.responseMs} ms` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {monitors.length === 0 && <div className="empty">No monitors reported.</div>}
        </>
      )}
    </CardShell>
  );
}
