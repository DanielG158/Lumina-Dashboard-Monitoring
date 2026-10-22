import { CardShell, barClass, clamp, type CardProps } from "./CardShell";
import { Spark } from "./charts";
import { useLumina } from "../context";

interface Client { name: string; ip: string; mac: string; kind: "wired" | "wifi" | "guest" }
interface RouterData {
  model: string | null; hardware: string | null; firmware: string | null; cpu: number | null; mem: number | null; busy?: boolean;
  wan: { ip: string; gateway: string; type: string | null; uptimeS: number | null; up: boolean }; lan: { ip: string };
  clients: { wired: number; wifi: number; guest: number; total: number }; list: Client[];
}
const uptime = (s: number | null) => (s === null ? "—" : s >= 86400 ? `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min`);
const KIND = { wired: "Wired", wifi: "Wi-Fi", guest: "Guest Wi-Fi" } as const;

export function TplinkRouterCard(props: CardProps) {
  const d = props.instance.data as RouterData | null;
  const { can } = useLumina();
  return (
    <CardShell {...props} tag={d?.model ?? "TP-Link router"} historyPrefer={["clients:total", "cpu"]}>
      {d && (
        <>
          {d.busy && <div className="hint" style={{ marginBottom: 8 }}>Someone is signed in to the router's admin page right now, so this is the last reading. Lumina tries again at the next one.</div>}
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
            <div className="stat">
              <div className="label"><span className={`dot ${d.wan.up ? "connected" : "disconnected"}`} />Internet</div>
              <div className="value" style={{ fontSize: 20 }}>{d.wan.up ? "Connected" : "No connection"}</div>
              <div className="sub">{d.wan.ip ? `${d.wan.ip}${d.wan.type ? ` · ${d.wan.type}` : ""}` : d.wan.type ?? ""}{d.wan.up && d.wan.uptimeS ? ` · up ${uptime(d.wan.uptimeS)}` : ""}</div>
            </div>
            <div className="stat"><div className="label">Clients</div><div className="value">{d.clients.total}</div><Spark instanceId={props.instance.instanceId} metric="clients:total" /><div className="sub">{d.clients.wifi} Wi-Fi · {d.clients.wired} wired · {d.clients.guest} guest</div></div>
            <div className="stat"><div className="label">CPU</div><div className="value">{d.cpu ?? "—"}<span className="sub"> %</span></div>{d.cpu !== null && <div className="bar"><i className={barClass(d.cpu / 100)} style={{ width: clamp(d.cpu) }} /></div>}<Spark instanceId={props.instance.instanceId} metric="cpu" unit="%" /></div>
            <div className="stat"><div className="label">Memory</div><div className="value">{d.mem ?? "—"}<span className="sub"> %</span></div>{d.mem !== null && <div className="bar"><i className={barClass(d.mem / 100)} style={{ width: clamp(d.mem) }} /></div>}<div className="sub">{d.firmware ?? ""}</div></div>
          </div>
          {d.list.length > 0 && can.operate && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Device</th><th>Connection</th><th>Address</th><th>MAC</th></tr></thead>
                <tbody>
                  {[...d.list].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)).map((c) => (
                    <tr key={`${c.mac}-${c.ip}`}><td>{c.name || "(no name)"}</td><td><span className="tag">{KIND[c.kind]}</span></td><td className="sub">{c.ip}</td><td className="sub">{c.mac}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </CardShell>
  );
}
