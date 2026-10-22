import { bitrate, mbps } from "../format";
import { UnitToggle, useSpeedUnit } from "./UnitToggle";
import { useState } from "react";
import { api } from "../api";
import { useLumina } from "../context";
import { Spark } from "./charts";
import { CardShell, barClass, clamp, type CardProps } from "./CardShell";

interface Iface { index: number; name: string; alias: string | null; up: boolean; speedMbps: number | null; inBps: number | null; outBps: number | null; errPerSec: number | null; watched: boolean; utilPct: number | null }
interface Probe { results: { setting: string; ok: boolean; message: string }[]; working: string | null; hint: string }
interface SnmpData { snmpVersion?: string; sysName: string | null; sysDescr: string | null; uptimeS: number | null; load1: number | null; memUsedPct: number | null; interfaces: Iface[]; hiddenDown: number; busyPct: number }

const metricName = (n: string) => n.replace(/[,\s:]+/g, "_");
const uptime = (s: number | null) => (s === null ? "—" : s >= 86400 ? `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`);

/** Admins: tries the usual SNMP setting combinations against the device and says which one it accepts. */
function ProbePanel({ id }: { id: string }) {
  const { can, notify } = useLumina();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Probe | null>(null);
  if (!can.admin) return null;
  async function run() {
    setBusy(true);
    try {
      const r = (await api.action(id, "probe", {})) as { result?: Probe } & Partial<Probe>;
      setRes((r.result ?? r) as Probe);
    } catch (e) { notify(e instanceof Error ? e.message : String(e), true); } finally { setBusy(false); }
  }
  return (
    <div className="stack" style={{ marginTop: 8 }}>
      <div><button className="btn sm" disabled={busy} onClick={() => void run()}>{busy ? "Testing the settings (up to a minute)…" : "Test the SNMP settings"}</button> <span className="sub">Tries the usual authentication and encryption combinations with the user and keys you entered.</span></div>
      {res && (
        <div className="subpanel stack">
          <div className="table-wrap"><table><tbody>{res.results.map((r) => (
            <tr key={r.setting}><td><span className={`dot ${r.ok ? "connected" : "disconnected"}`} /></td><td>{r.setting}</td><td className="sub" style={{ whiteSpace: "normal" }}>{r.message}</td></tr>
          ))}</tbody></table></div>
          <div className={res.working ? "okline" : "error"}>{res.hint}</div>
        </div>
      )}
    </div>
  );
}

export function SnmpCard(props: CardProps) {
  const d = props.instance.data as SnmpData | null;
  useSpeedUnit();
  return (
    <CardShell {...props} tag="SNMP" historyPrefer={["traffic:in", "traffic:out"]}>
      {!d && <ProbePanel id={props.instance.instanceId} />}
      {d && (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}><UnitToggle /></div>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            <div className="stat"><div className="label">Device</div><div className="value" style={{ fontSize: 16 }}>{d.sysName ?? "—"}</div><div className="sub" title={d.sysDescr ?? ""}>up {uptime(d.uptimeS)}</div></div>
            <div className="stat"><div className="label">Traffic in</div><div className="value" style={{ fontSize: 18 }}>{bitrate(d.interfaces.filter((i) => (d.interfaces.some((x) => x.watched) ? i.watched : i.up)).reduce((a, i) => a + (i.inBps ?? 0), 0))}</div><Spark instanceId={props.instance.instanceId} metric="traffic:in" /></div>
            <div className="stat"><div className="label">Traffic out</div><div className="value" style={{ fontSize: 18 }}>{bitrate(d.interfaces.filter((i) => (d.interfaces.some((x) => x.watched) ? i.watched : i.up)).reduce((a, i) => a + (i.outBps ?? 0), 0))}</div><Spark instanceId={props.instance.instanceId} metric="traffic:out" /></div>
            {d.load1 !== null && <div className="stat"><div className="label">Load</div><div className="value">{d.load1}</div><Spark instanceId={props.instance.instanceId} metric="load" /></div>}
            {d.memUsedPct !== null && <div className="stat"><div className="label">Memory used</div><div className="value">{d.memUsedPct}<span className="sub"> %</span></div></div>}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th></th><th>Interface</th><th className="num">Speed</th><th className="num">In</th><th className="num">Out</th><th>Load</th><th className="num">Errors/s</th></tr></thead>
              <tbody>
                {d.interfaces.map((i) => (
                  <tr key={i.index}>
                    <td><span className={`dot ${i.up ? "connected" : i.watched ? "disconnected" : "pending"}`} title={i.up ? "up" : "down"} /></td>
                    <td>{i.name}{i.alias && <span className="sub"> · {i.alias}</span>}{i.watched && <span className="tag" style={{ marginLeft: 6 }}>watched</span>}</td>
                    <td className="num">{i.speedMbps ? mbps(i.speedMbps) : "—"}</td>
                    <td className="num">{bitrate(i.inBps)}</td>
                    <td className="num">{bitrate(i.outBps)}</td>
                    <td style={{ minWidth: 110 }}>
                      {i.up && i.utilPct !== null ? <div className="bar"><i className={barClass(i.utilPct / 100)} style={{ width: clamp(i.utilPct) }} /></div> : null}
                      {i.up && <Spark instanceId={props.instance.instanceId} metric={`if:${metricName(i.name)}:in`} />}
                    </td>
                    <td className="num sub">{i.errPerSec ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ProbePanel id={props.instance.instanceId} />
          {d.hiddenDown > 0 && <div className="hint">{d.hiddenDown} unused (down) port{d.hiddenDown === 1 ? " is" : "s are"} hidden. List a port under "Interfaces to alert on" to always show it.</div>}
        </>
      )}
    </CardShell>
  );
}
