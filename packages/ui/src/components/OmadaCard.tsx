import { CardShell, barClass, clamp, type CardProps } from "./CardShell";
import { Spark } from "./charts";

interface Dev { mac: string; name: string; kind: "gateway" | "switch" | "ap" | "other"; model: string; state: string; online: boolean; ip: string; uptimeS: number | null; cpu: number | null; mem: number | null; firmware: string | null; needsUpgrade: boolean; clients: number | null }
interface Site { key: string; name: string; devices: Dev[] }
interface OmadaData { controller: { version: string | null; user: string | null } | null; sites: Site[]; summary: { total: number; online: number; offline: number; clients: number; upgrades: number } }

const KIND: Record<Dev["kind"], string> = { gateway: "Router", switch: "Switch", ap: "Access point", other: "Device" };
const ORDER: Record<Dev["kind"], number> = { gateway: 0, switch: 1, ap: 2, other: 3 };
const STATE: Record<string, string> = { connected: "online", disconnected: "offline", pending: "waiting to be adopted", "heartbeat-missed": "not answering", isolated: "isolated", upgrading: "upgrading", rebooting: "rebooting", unknown: "unknown" };
const uptime = (s: number | null) => (s === null ? "—" : s >= 86400 ? `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min`);
const dot = (d: Dev) => (d.state === "connected" || d.state === "upgrading" || d.state === "rebooting" ? "connected" : d.state === "disconnected" ? "disconnected" : "degraded");

export function OmadaCard(props: CardProps) {
  const d = props.instance.data as OmadaData | null;
  return (
    <CardShell {...props} tag={d?.controller?.version ? `Omada ${d.controller.version}` : "TP-Link Omada"} historyPrefer={["clients:total", "devices:online"]}>
      {d && (
        <>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            <div className="stat"><div className="label">Devices online</div><div className="value">{d.summary.online}/{d.summary.total}</div><Spark instanceId={props.instance.instanceId} metric="devices:online" /></div>
            <div className="stat"><div className="label">Wi-Fi clients</div><div className="value">{d.summary.clients}</div><Spark instanceId={props.instance.instanceId} metric="clients:total" /></div>
            <div className="stat"><div className="label">Firmware updates</div><div className="value">{d.summary.upgrades}</div><div className="sub">{d.summary.upgrades ? "available" : "all up to date"}</div></div>
          </div>
          {d.sites.map((s) => (
            <div key={s.key} className="table-wrap">
              {d.sites.length > 1 && <div className="sub" style={{ margin: "8px 0 4px" }}>Site: {s.name}</div>}
              <table>
                <thead><tr><th></th><th>Device</th><th>Type</th><th>Model</th><th>Address</th><th className="num">Clients</th><th>CPU</th><th>Memory</th><th className="num">Up for</th></tr></thead>
                <tbody>
                  {[...s.devices].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.name.localeCompare(b.name)).map((x) => (
                    <tr key={x.mac || x.name} title={`${STATE[x.state] ?? x.state}${x.firmware ? ` · firmware ${x.firmware}` : ""}${x.needsUpgrade ? " (update available)" : ""}`}>
                      <td><span className={`dot ${dot(x)}`} /></td>
                      <td>{x.name}{x.needsUpgrade && <span className="tag" style={{ marginLeft: 6 }}>update</span>}{!x.online && <span className="sub"> · {STATE[x.state] ?? x.state}</span>}</td>
                      <td><span className="tag">{KIND[x.kind]}</span></td>
                      <td className="sub">{x.model}</td>
                      <td className="sub">{x.ip || "—"}</td>
                      <td className="num">{x.kind === "ap" ? x.clients ?? "—" : ""}</td>
                      <td style={{ minWidth: 80 }}>{x.cpu !== null ? <><div className="bar"><i className={barClass(x.cpu / 100)} style={{ width: clamp(x.cpu) }} /></div><div className="sub">{x.cpu}%</div></> : "—"}</td>
                      <td style={{ minWidth: 80 }}>{x.mem !== null ? <><div className="bar"><i className={barClass(x.mem / 100)} style={{ width: clamp(x.mem) }} /></div><div className="sub">{x.mem}%</div></> : "—"}</td>
                      <td className="num sub">{uptime(x.uptimeS)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {s.devices.length === 0 && <div className="empty">No devices are adopted in this site yet.</div>}
            </div>
          ))}
        </>
      )}
    </CardShell>
  );
}
