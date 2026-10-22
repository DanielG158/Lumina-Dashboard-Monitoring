import { CardShell, type CardProps } from "./CardShell";

interface Device { name: string; moduleId: string; status: string; line: string; level: "ok" | "warn" | "bad" | "unknown" }
interface RemoteAlert { instanceId: string; key: string; severity: "critical" | "warning" | "info"; title: string; detail: string | null; since: number }
interface RemoteData { label: string; devices: Device[]; alerts: RemoteAlert[]; remoteUptime: number | null }

const DOT = { ok: "connected", warn: "degraded", bad: "disconnected", unknown: "pending" } as const;
const KIND: Record<string, string> = { proxmox: "Proxmox", ilo4: "iLO", apcupsd: "UPS", "uptime-kuma": "Uptime Kuma", cloudflare: "Cloudflare" };

export function RemoteCard(props: CardProps) {
  const d = props.instance.data as RemoteData | null;
  return (
    <CardShell {...props} tag="Another Lumina" historyPrefer={["alerts:total"]}>
      {d && (
        <>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            <div className="stat"><div className="label">Devices online</div><div className="value">{d.devices.filter((x) => x.level === "ok").length}/{d.devices.length}</div></div>
            <div className="stat"><div className="label">Critical alerts</div><div className="value" style={{ color: d.alerts.some((a) => a.severity === "critical") ? "var(--bad)" : undefined }}>{d.alerts.filter((a) => a.severity === "critical").length}</div></div>
            <div className="stat"><div className="label">Warnings</div><div className="value">{d.alerts.filter((a) => a.severity !== "critical").length}</div></div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th></th><th>Device</th><th>Type</th><th>Now</th></tr></thead>
              <tbody>
                {d.devices.map((x) => (
                  <tr key={x.name}>
                    <td><span className={`dot ${DOT[x.level]}`} /></td>
                    <td>{x.name}</td>
                    <td><span className="tag">{KIND[x.moduleId] ?? x.moduleId}</span></td>
                    <td className="sub">{x.line}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.alerts.length > 0 && (
            <div className="stack" style={{ marginTop: 8 }}>
              {d.alerts.map((a) => (
                <div key={`${a.instanceId}:${a.key}`} className="row" style={{ gap: 8 }}>
                  <span className={`dot ${a.severity === "critical" ? "disconnected" : "degraded"}`} />
                  <span>{a.title}</span><span className="sub">{a.instanceId}{a.detail ? ` · ${a.detail}` : ""}</span>
                </div>
              ))}
            </div>
          )}
          {d.devices.length === 0 && <div className="empty">That Lumina has no devices yet.</div>}
        </>
      )}
    </CardShell>
  );
}
