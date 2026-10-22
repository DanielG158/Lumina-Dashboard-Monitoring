import { CardShell, barClass, clamp, type CardProps } from "./CardShell";
import { Spark } from "./charts";
import { Section } from "./Section";
import { ProbePanel } from "./SnmpCard";

type C = "ok" | "degraded" | "failed" | "unknown";
interface D {
  product: string | null; serial: string | null; ilo: { model: string | null; name: string | null; description: string | null }; overall: C; components: { name: string; cond: C }[]; powerW: number | null;
  temps: { name: string; celsius: number; limitC: number | null; cond: C }[]; fans: { name: string; cond: C; rpm: number | null }[]; supplies: { name: string; cond: C; volts: number | null; usedW: number | null; maxW: number | null }[];
  cpus: { name: string; speedMHz: number | null; status: string }[]; dimms: { slot: string; sizeGB: number; mhz: number | null; ok: boolean }[];
  controllers: { model: string | null; slot: number | null; cond: C }[]; logical: { id: string; level: string; status: string; sizeGB: number | null; ok: boolean }[];
  drives: { id: string; location: string; model: string | null; sizeGB: number | null; status: string; statusOk: boolean; media: string | null; tempC: number | null; limitC: number | null; hours: number | null }[];
  warnings: string[];
}
const dot = (c: string) => (c === "ok" ? "connected" : c === "unknown" ? "pending" : c === "degraded" ? "degraded" : "disconnected");
const WORD: Record<string, string> = { ok: "OK", degraded: "Degraded", failed: "Failed", unknown: "unknown" };

export function IloSnmpCard(props: CardProps) {
  const d = props.instance.data as D | null;
  const sid = (n: string) => `ilosnmp:${props.instance.instanceId}:${n}`;
  const hottest = d && d.temps.length ? Math.max(...d.temps.map((t) => t.celsius)) : null;
  return (
    <CardShell {...props} tag={d?.product ?? "HPE iLO (SNMP)"} historyPrefer={["power", "temp:max"]}>
      {d ? (
        <>
          {d.warnings.length > 0 && (
            <div className="error">Some data could not be read from the iLO:<ul style={{ margin: "4px 0 0 18px", padding: 0 }}>{d.warnings.map((w) => <li key={w} style={{ wordBreak: "break-word" }}>{w}</li>)}</ul></div>
          )}
          <div className="grid">
            <div className="stat">
              <div className="label"><span className={`dot ${dot(d.overall)}`} />Server health</div>
              <div className="value" style={{ fontSize: 20 }}>{WORD[d.overall]}</div>
              <div className="sub">{d.components.map((c) => <span key={c.name} style={{ marginRight: 8, color: c.cond === "ok" || c.cond === "unknown" ? undefined : "var(--warn)" }}>{c.name} {WORD[c.cond]}</span>)}</div>
              <div className="sub">{d.ilo.model ?? "iLO"}{d.serial ? ` · S/N ${d.serial}` : ""}</div>
            </div>
            <div className="stat"><div className="label">Power draw</div><div className="value">{d.powerW ?? "—"} <span className="sub">W</span></div><Spark instanceId={props.instance.instanceId} metric="power" unit=" W" /></div>
            <div className="stat"><div className="label">Hottest sensor</div><div className="value">{hottest ?? "—"} <span className="sub">°C</span></div><Spark instanceId={props.instance.instanceId} metric="temp:max" range="24h" unit="°C" /></div>
            <div className="stat"><div className="label">Processors</div><div className="value">{d.cpus.length}</div><div className="sub">{d.cpus[0]?.name ?? ""}</div></div>
            <div className="stat"><div className="label">Memory</div><div className="value">{d.dimms.reduce((a, m) => a + m.sizeGB, 0)} <span className="sub">GB</span></div><div className="sub">{d.dimms.length} modules{d.dimms.some((m) => !m.ok) ? " · errors" : ""}</div></div>
          </div>

          <Section id={sid("temps")} title="Temperatures" count={d.temps.length} meta={hottest !== null ? `hottest ${hottest}°C` : undefined}>
            <table><thead><tr><th></th><th>Sensor</th><th className="num">°C</th><th className="num">Limit</th></tr></thead><tbody>
              {[...d.temps].sort((a, b) => b.celsius / (b.limitC ?? 100) - a.celsius / (a.limitC ?? 100)).map((t) => (
                <tr key={t.name}><td><span className={`dot ${dot(t.cond)}`} /></td><td>{t.name}</td><td className="num" style={{ color: t.limitC && t.celsius >= t.limitC * 0.9 ? "var(--warn)" : undefined }}>{t.celsius}</td>
                  <td className="num sub">{t.limitC ?? "—"}{t.limitC ? <div className="bar" style={{ width: 70, marginLeft: "auto" }}><i className={barClass(t.celsius / t.limitC)} style={{ width: clamp((t.celsius / t.limitC) * 100) }} /></div> : null}</td></tr>
              ))}
            </tbody></table>
          </Section>
          <Section id={sid("fans")} title="Fans" count={d.fans.length}>
            <table><thead><tr><th></th><th>Fan</th><th className="num">Speed</th></tr></thead><tbody>{d.fans.map((f) => <tr key={f.name}><td><span className={`dot ${dot(f.cond)}`} /></td><td>{f.name}</td><td className="num">{f.rpm ? `${f.rpm} rpm` : "—"}</td></tr>)}</tbody></table>
          </Section>
          <Section id={sid("psu")} title="Power supplies" count={d.supplies.length}>
            <table><thead><tr><th></th><th>Bay</th><th className="num">Input</th><th className="num">Output</th><th className="num">Capacity</th></tr></thead><tbody>
              {d.supplies.map((p) => <tr key={p.name}><td><span className={`dot ${dot(p.cond)}`} /></td><td>{p.name}</td><td className="num">{p.volts ? `${p.volts} V` : "—"}</td><td className="num">{p.usedW ?? "—"} W</td><td className="num">{p.maxW ?? "—"} W</td></tr>)}
            </tbody></table>
          </Section>
          {(d.controllers.length > 0 || d.drives.length > 0) && (
            <Section id={sid("storage")} title="Storage" count={d.drives.length} meta={d.controllers.map((c) => `${c.model ?? "controller"} (${WORD[c.cond]})`).join(" · ")}>
              {d.logical.length > 0 && <div className="sub" style={{ margin: "4px 0" }}>{d.logical.map((l) => `Logical drive ${l.id}: ${l.level} ${l.sizeGB ?? "?"} GB, ${l.status}`).join(" · ")}</div>}
              <table><thead><tr><th></th><th>Bay</th><th>Model</th><th>Type</th><th className="num">Size</th><th className="num">Temp</th><th>Status</th></tr></thead><tbody>
                {d.drives.map((x) => <tr key={x.id}><td><span className={`dot ${x.statusOk ? "connected" : "disconnected"}`} /></td><td>{x.location}</td><td>{x.model ?? "—"}</td><td className="sub">{x.media ?? "—"}</td><td className="num">{x.sizeGB ? `${x.sizeGB} GB` : "—"}</td><td className="num" style={{ color: x.tempC !== null && x.tempC >= (x.limitC ?? 55) ? "var(--warn)" : undefined }}>{x.tempC !== null ? `${x.tempC}°C` : "—"}</td><td>{x.status}</td></tr>)}
              </tbody></table>
            </Section>
          )}
          {d.dimms.length > 0 && (
            <Section id={sid("mem")} title="Memory modules" count={d.dimms.length} defaultCollapsed>
              <table><thead><tr><th></th><th>Slot</th><th className="num">Size</th><th className="num">Speed</th></tr></thead><tbody>{d.dimms.map((m) => <tr key={m.slot}><td><span className={`dot ${m.ok ? "connected" : "degraded"}`} /></td><td>{m.slot}</td><td className="num">{m.sizeGB} GB</td><td className="num">{m.mhz ? `${m.mhz} MHz` : "—"}</td></tr>)}</tbody></table>
            </Section>
          )}
        </>
      ) : null}
      <ProbePanel id={props.instance.instanceId} />
    </CardShell>
  );
}
