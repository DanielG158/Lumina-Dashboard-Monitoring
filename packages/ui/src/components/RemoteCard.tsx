import { CardShell, type CardProps } from "./CardShell";
import { CARDS } from "./cards";
import type { InstanceStatus, InstanceUpdate } from "../api";
import { LuminaContext, RemoteView, useLumina } from "../context";

interface Device { name: string; moduleId: string; status: string; line: string; level: "ok" | "warn" | "bad" | "unknown" }
interface RemoteAlert { instanceId: string; key: string; severity: "critical" | "warning" | "info"; title: string; detail: string | null; since: number }
interface RemoteInstance { instanceId: string; moduleId: string; status: string; enabled: boolean; error: string | null; at: number | null; intervalMs: number; data: unknown }
interface RemoteData { label: string; devices: Device[]; alerts: RemoteAlert[]; remoteUptime: number | null; detailed?: boolean; remote?: RemoteInstance[] }

const DOT = { ok: "connected", warn: "degraded", bad: "disconnected", unknown: "pending" } as const;
const KIND: Record<string, string> = { proxmox: "Proxmox", ilo4: "iLO", apcupsd: "UPS", "uptime-kuma": "Uptime Kuma", cloudflare: "Cloudflare" };

/** The other Lumina's devices drawn with the same cards as a device of this one, read-only and without local history. */
function Devices({ d }: { d: RemoteData }) {
  const L = useLumina();
  const view = { ...L, can: { operate: false, admin: false } };
  return (
    <LuminaContext.Provider value={view}>
      <RemoteView.Provider value={true}>
        <div className="remote-devices">
          {(d.remote ?? []).map((x, i) => {
            const Card = CARDS[x.moduleId];
            const inst: InstanceUpdate = {
              instanceId: `${d.label}: ${x.instanceId}`, moduleId: x.moduleId, status: x.status as InstanceStatus, enabled: x.enabled, data: x.data, error: x.error,
              at: x.at, intervalMs: x.intervalMs, defaultIntervalMs: x.intervalMs, minIntervalMs: x.intervalMs, customInterval: false, position: i,
              remote: { label: d.label, alerts: d.alerts.filter((a) => a.instanceId === x.instanceId) },
            };
            return Card ? <Card key={x.instanceId} instance={inst} /> : (
              <CardShell key={x.instanceId} instance={inst} tag={x.moduleId}><pre style={{ fontSize: 12, overflow: "auto" }}>{JSON.stringify(x.data, null, 2)}</pre></CardShell>
            );
          })}
        </div>
      </RemoteView.Provider>
    </LuminaContext.Provider>
  );
}

export function RemoteCard(props: CardProps) {
  const d = props.instance.data as RemoteData | null;
  const detailed = Boolean(d?.detailed && d.remote?.length);
  return (
    <CardShell {...props} tag="Another Lumina" historyPrefer={["alerts:total"]}>
      {d && (
        <>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            <div className="stat"><div className="label">Devices online</div><div className="value">{d.devices.filter((x) => x.level === "ok").length}/{d.devices.length}</div></div>
            <div className="stat"><div className="label">Critical alerts</div><div className="value" style={{ color: d.alerts.some((a) => a.severity === "critical") ? "var(--bad)" : undefined }}>{d.alerts.filter((a) => a.severity === "critical").length}</div></div>
            <div className="stat"><div className="label">Warnings</div><div className="value">{d.alerts.filter((a) => a.severity !== "critical").length}</div></div>
          </div>
          {detailed && <Devices d={d} />}
          {!detailed && <div className="table-wrap">
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
          </div>}
          {!detailed && d.alerts.length > 0 && (
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
          {!detailed && d.devices.length > 0 && <div className="sub" style={{ marginTop: 8 }}>Only a summary is shown. To see each device here like on that Lumina, create its access token with "Full detail" (Settings, Access tokens there) and enter it in this instance.</div>}
        </>
      )}
    </CardShell>
  );
}
