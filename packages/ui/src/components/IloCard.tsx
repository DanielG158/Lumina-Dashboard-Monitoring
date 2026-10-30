import { useState } from "react";
import { api } from "../api";
import { useLumina } from "../context";
import { Spark } from "./charts";
import { CardShell, barClass, clamp, type CardProps } from "./CardShell";
import { Section } from "./Section";

interface Port {
  name: string; mac: string | null; speedMbps: number | null; fullDuplex: boolean | null; health: string | null; state: string | null;
  ips: string[]; team: string | null; goodRx: number | null; badRx: number | null; goodTx: number | null; badTx: number | null;
}
interface Drive {
  location: string | null; model: string | null; serial: string | null; media: string | null; protocol: string | null; capacityGB: number | null;
  health: string | null; tempC: number | null; rpm: number | null; firmware: string | null; powerOnHours: number | null; ssdWearPct: number | null; reasons: string[];
}
interface Entry { id: string; time: string | null; severity: string; message: string }
interface IloData {
  model: string | null; serial: string | null; sku: string | null; hostName: string | null; powerState: string | null; health: string | null; healthParts?: { name: string; health: string }[];
  indicatorLed: string | null; postState: string | null; bios: string | null; provisioning: string | null; powerRegulator: string | null;
  hostOs: { name: string; description: string | null } | null; tpm: string | null;
  smartBattery: { model: string; health: string | null; maxCapW: number | null; firmware: string | null }[];
  cpu: { count: number | null; model: string | null; health: string | null;
    processors: { socket: string | null; model: string | null; cores: number | null; threads: number | null; maxMHz: number | null; health: string | null }[] | null };
  memory: { totalGiB: number | null; health: string | null;
    dimms: { slot: string; sizeGB: number | null; type: string | null; technology: string | null; mhz: number | null; rank: number | null; ecc: string | null; status: string | null }[] | null };
  power: { nowW: number | null; avgW: number | null; minW: number | null; maxW: number | null; capacityW: number | null };
  supplies: { name: string; model: string | null; serial: string | null; firmware: string | null; inputV: number | null; outputW: number | null; maxW: number | null; capacityW: number | null; health: string | null; state: string | null }[];
  temperatures: { name: string; celsius: number; criticalC: number | null; context: string | null; health: string | null }[];
  fans: { name: string; reading: number | null; units: string; health: string | null }[];
  ilo: { firmware: string | null; license: string | null; licenseType: string | null; health: string | null; selfTests: { name: string; status: string; notes: string | null }[];
    hostName: string | null; ip: string | null; ipOrigin: string | null; mac: string | null; speedMbps: number | null } | null;
  storage: { health: string | null; controllers: { model: string | null; location: string | null; firmware: string | null; health: string | null }[];
    logical?: { name: string; raid: string | null; type: string | null; capacityGiB: number | null; health: string | null; state: string; rebuilding: boolean; percent: number | null; reasons: string[] }[]; drives: Drive[] } | null;
  network: { name: string; firmware: string | null; ports: Port[] }[] | null;
  firmware: { name: string; version: string }[] | null;
  logs: { iml: Entry[] | null; iel: Entry[] | null };
  warnings: string[];
}

const healthDot = (h: string | null) => (h === "OK" || h === "Ok" || h === "Enabled" ? "up" : h ? "down" : "unknown");
const sevDot = (s: string) => (s === "Critical" ? "down" : s === "Warning" ? "pending" : "up");
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const count = (n: number | null) => (n === null ? "—" : n.toLocaleString());

function Log({ id, title, entries }: { id: string; title: string; entries: Entry[] | null }) {
  if (!entries) return null;
  const bad = entries.filter((e) => e.severity !== "OK" && e.severity !== "Informational").length;
  return (
    <Section id={id} title={title} count={entries.length} meta={bad ? `${bad} warning/critical` : undefined} defaultCollapsed>
      <table>
        <thead><tr><th></th><th>Time</th><th>Message</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td><span className={`dot ${sevDot(e.severity)}`} title={e.severity} /></td>
              <td>{when(e.time)}</td>
              <td className="sub" style={{ whiteSpace: "normal" }}>{e.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

const POWER_CONFIRM: Record<string, string> = {
  shutdown: "Send a graceful shutdown (power-button press) to this server? The operating system will shut itself down.",
  restart: "HARD RESET this server? This restarts it immediately without shutting the operating system down, and unsaved data and running VMs will be lost.",
  "force-off": "FORCE OFF this server? This cuts power immediately without shutting the operating system down, and running VMs will be lost.",
};

export function IloCard(props: CardProps) {
  const d = props.instance.data as IloData | null;
  const { can } = useLumina();
  const [busy, setBusy] = useState<string | null>(null);
  const notify = useLumina().notify;

  async function power(action: string, label: string) {
    const warning = POWER_CONFIRM[action];
    if (warning && !confirm(`${warning}\n\nServer: ${d?.hostName ?? props.instance.instanceId}`)) return;
    setBusy(action);
    try {
      await api.action(props.instance.instanceId, action, {});
      notify(`${label} sent — the status updates within a few seconds`);
      setTimeout(() => void api.refresh(props.instance.instanceId).catch(() => undefined), 5000);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(null);
    }
  }
  const sid = (name: string) => `ilo:${props.instance.instanceId}:${name}`;
  const hottest = d && d.temperatures.length ? Math.max(...d.temperatures.map((t) => t.celsius)) : null;
  const loading = d && !d.storage && !d.ilo;

  return (
    <CardShell {...props} tag={d?.model ?? "HPE iLO"} historyPrefer={["power"]}>
      {d && (
        <>
          {loading && <div className="sub" style={{ marginBottom: 8 }}>Loading hardware details from iLO — the first load takes about 30 seconds…</div>}
          {d.warnings.length > 0 && (
            <div className="error">
              Some data could not be read from the iLO:
              <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>{d.warnings.map((w) => <li key={w} style={{ wordBreak: "break-word" }}>{w}</li>)}</ul>
            </div>
          )}

          <div className="grid">
            <div className="stat">
              <div className="label"><span className={`dot ${d.powerState === "On" ? "running" : "stopped"}`} />Server power</div>
              <div className="value">{d.powerState ?? "—"}</div>
              <div className="sub"><span className={`dot ${healthDot(d.health)}`} style={{ marginRight: 6 }} />Health: {d.health ?? "unknown"}{d.postState ? ` · ${d.postState}` : ""}</div>
              {d.healthParts && d.healthParts.filter((x) => x.health !== "OK").length > 0 && (
                <div className="sub" style={{ color: "var(--warn)" }}>{d.healthParts.filter((x) => x.health !== "OK").map((x) => `${x.name}: ${x.health}`).join(" · ")}</div>
              )}
              <div className="sub">{d.sku ?? ""}{d.serial ? ` · S/N ${d.serial}` : ""}</div>
              <div className="actions" style={{ justifyContent: "flex-start", margin: "8px 0 2px", flexWrap: "wrap" }}>
                {can.operate && d.powerState === "Off" && <button className="btn sm primary" disabled={!!busy} onClick={() => power("power-on", "Power on")}>{busy === "power-on" ? "…" : "Power on"}</button>}
                {can.operate && d.powerState === "On" && <button className="btn sm" disabled={!!busy} onClick={() => power("shutdown", "Shutdown")}>{busy === "shutdown" ? "…" : "Shut down"}</button>}
                {can.operate && d.powerState === "On" && <button className="btn sm danger" disabled={!!busy} onClick={() => power("restart", "Hard reset")}>{busy === "restart" ? "…" : "Hard reset"}</button>}
                {can.operate && d.powerState === "On" && <button className="btn sm danger" disabled={!!busy} onClick={() => power("force-off", "Force off")}>{busy === "force-off" ? "…" : "Force off"}</button>}
              </div>
              {d.hostOs && <div className="sub" title={d.hostOs.description ?? ""}>{d.hostName ? `${d.hostName} · ` : ""}{d.hostOs.name}</div>}
            </div>
            <div className="stat">
              <div className="label">Power draw</div>
              <div className="value">{d.power.nowW ?? "—"} <span className="sub">W</span></div>
              {d.power.capacityW ? (
                <div className="bar"><i className={barClass((d.power.nowW ?? 0) / d.power.capacityW)} style={{ width: clamp(((d.power.nowW ?? 0) / d.power.capacityW) * 100) }} /></div>
              ) : null}
              <Spark instanceId={props.instance.instanceId} metric="power" unit=" W" />
              <div className="sub" style={{ marginTop: 6 }}>avg {d.power.avgW ?? "—"} · min {d.power.minW ?? "—"} · max {d.power.maxW ?? "—"} W</div>
              {d.powerRegulator && <div className="sub">Regulator: {d.powerRegulator}</div>}
            </div>
            <div className="stat">
              <div className="label"><span className={`dot ${healthDot(d.cpu.health)}`} />Processors</div>
              <div className="value">{d.cpu.count ?? "—"} <span className="sub">socket{d.cpu.count === 1 ? "" : "s"}</span></div>
              <div className="sub">{d.cpu.model ?? ""}</div>
              {d.cpu.processors && <div className="sub">{d.cpu.processors.reduce((a, p) => a + (p.cores ?? 0), 0)} cores · {d.cpu.processors.reduce((a, p) => a + (p.threads ?? 0), 0)} threads</div>}
            </div>
            <div className="stat">
              <div className="label"><span className={`dot ${healthDot(d.memory.health)}`} />Memory</div>
              <div className="value">{d.memory.totalGiB ?? "—"} <span className="sub">GiB</span></div>
              {d.memory.dimms && <div className="sub">{d.memory.dimms.length} DIMM{d.memory.dimms.length === 1 ? "" : "s"} · {d.memory.dimms[0]?.type} {d.memory.dimms[0]?.mhz} MHz</div>}
            </div>
            <div className="stat">
              <div className="label"><span className={`dot ${healthDot(d.ilo?.health ?? null)}`} />iLO</div>
              <div className="value" style={{ fontSize: 16 }}>{d.ilo?.firmware ?? "…"}</div>
              <div className="sub">{d.ilo?.license ?? ""}{d.ilo?.licenseType ? ` (${d.ilo.licenseType})` : ""}</div>
              <div className="sub">{d.ilo?.ip ? `${d.ilo.ip}${d.ilo.ipOrigin ? ` · ${d.ilo.ipOrigin}` : ""}` : ""}</div>
            </div>
            <div className="stat">
              <div className="label">BIOS</div>
              <div className="value" style={{ fontSize: 16 }}>{d.bios ?? "—"}</div>
              {d.provisioning && <div className="sub">Intelligent Provisioning {d.provisioning}</div>}
              <div className="sub">TPM: {d.tpm ?? "—"} · UID LED: {d.indicatorLed ?? "—"}</div>
              {d.smartBattery.map((b, i) => <div className="sub" key={i}><span className={`dot ${healthDot(b.health)}`} style={{ marginRight: 6 }} />{b.model}</div>)}
            </div>
          </div>

          {(d.temperatures.length > 0 || d.fans.length > 0) && (() => {
            const inlet = d.temperatures.find((t) => /inlet/i.test(t.name));
            const pct = d.fans.filter((f) => f.units === "Percent" && f.reading !== null).map((f) => f.reading as number);
            const avg = pct.length ? pct.reduce((a, b) => a + b, 0) / pct.length : null;
            const bad = d.fans.filter((f) => f.health && f.health !== "OK").length;
            return (
              <Section id={sid("cooling")} title="Cooling" meta={`${bad ? `${bad} fan problem · ` : ""}${avg !== null ? `fans ${Math.round(avg)}%` : ""}${hottest !== null ? ` · hottest ${hottest}°C` : ""}`.replace(/^ · /, "")}>
                <div className="cool-grid">
                  <div className="stat"><div className="label">Air intake</div><div className="value">{inlet ? `${inlet.celsius}°C` : "—"}</div><Spark instanceId={props.instance.instanceId} metric="temp:inlet" range="24h" unit="°C" /><div className="sub">last 24 h{inlet?.criticalC ? ` · limit ${inlet.criticalC}°C` : ""}</div></div>
                  <div className="stat"><div className="label">Hottest part</div><div className="value">{hottest !== null ? `${hottest}°C` : "—"}</div><Spark instanceId={props.instance.instanceId} metric="temp:max" range="24h" unit="°C" /><div className="sub">last 24 h</div></div>
                  <div className="stat"><div className="label">Fan speed (average)</div><div className="value">{avg !== null ? `${Math.round(avg)}%` : "—"}</div><Spark instanceId={props.instance.instanceId} metric="fan:avg" range="24h" unit="%" /><div className="sub">{pct.length ? `${pct.length} fans · fastest ${Math.max(...pct)}%` : "last 24 h"}</div></div>
                  <div className="stat"><div className="label">Server power</div><div className="value">{d.power.nowW !== null ? `${d.power.nowW} W` : "—"}</div><Spark instanceId={props.instance.instanceId} metric="power" range="24h" unit=" W" /><div className="sub">fans rise with heat and load</div></div>
                </div>
                <div className="hint">The iLO manages the fans itself and Lumina cannot change their speed, so this view is read-only. Rising fan speed with a steady load usually means dust or poor airflow.</div>
              </Section>
            );
          })()}

          <Section id={sid("temps")} title="Temperatures" count={d.temperatures.length} meta={hottest !== null ? `hottest ${hottest}°C` : undefined} defaultCollapsed>
            <table>
              <thead><tr><th></th><th>Sensor</th><th>Location</th><th className="num">°C</th><th className="num">Critical at</th></tr></thead>
              <tbody>
                {[...d.temperatures].sort((a, b) => b.celsius / (b.criticalC ?? 100) - a.celsius / (a.criticalC ?? 100)).map((t, i) => (
                  <tr key={`${t.name}-${i}`}>
                    <td><span className={`dot ${healthDot(t.health)}`} /></td>
                    <td>{t.name}</td>
                    <td className="sub">{t.context ?? "—"}</td>
                    <td className="num" style={{ color: t.criticalC && t.celsius > t.criticalC * 0.85 ? "var(--warn)" : undefined }}>{t.celsius}</td>
                    <td className="num sub">{t.criticalC ?? "—"}{t.criticalC ? <div className="bar" style={{ width: 70, marginLeft: "auto" }}><i className={barClass(t.celsius / t.criticalC)} style={{ width: clamp((t.celsius / t.criticalC) * 100) }} /></div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section id={sid("fans")} title="Fans" count={d.fans.length}>
            <table>
              <thead><tr><th></th><th>Fan</th><th className="num">Speed</th></tr></thead>
              <tbody>
                {d.fans.map((f, i) => (
                  <tr key={`${f.name}-${i}`}>
                    <td><span className={`dot ${healthDot(f.health)}`} /></td>
                    <td>{f.name}</td>
                    <td className="num">
                      {f.reading ?? "—"}{f.units === "Percent" ? "%" : ` ${f.units}`}
                      {f.units === "Percent" && f.reading !== null && <div className="bar" style={{ width: 90, marginLeft: "auto" }}><i style={{ width: clamp(f.reading) }} /></div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section id={sid("psu")} title="Power supplies" count={d.supplies.length}>
            <table>
              <thead><tr><th></th><th>Bay</th><th>Model</th><th>Serial</th><th>Firmware</th><th className="num">Input</th><th className="num">Output</th><th className="num">Capacity</th></tr></thead>
              <tbody>
                {d.supplies.map((s, i) => (
                  <tr key={`${s.name}-${i}`}>
                    <td><span className={`dot ${healthDot(s.health)}`} title={s.state ?? ""} /></td>
                    <td>{s.name}</td>
                    <td>{s.model ?? "—"}</td>
                    <td className="sub">{s.serial ?? "—"}</td>
                    <td className="sub">{s.firmware ?? "—"}</td>
                    <td className="num">{s.inputV !== null ? `${s.inputV} V` : "—"}</td>
                    <td className="num">{s.outputW !== null ? `${s.outputW} W` : "—"}</td>
                    <td className="num">{s.capacityW !== null ? `${s.capacityW} W` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          {d.storage && (
            <Section id={sid("storage")} title="Storage" count={d.storage.drives.length} meta={d.storage.controllers.map((c) => `${c.model ?? "controller"} (${c.health ?? "?"})`).join(" · ")}>
              {(d.storage.logical ?? []).length > 0 && (
                <table>
                  <thead><tr><th></th><th>RAID volume</th><th>Level</th><th className="num">Size</th><th>Status</th></tr></thead>
                  <tbody>
                    {(d.storage.logical ?? []).map((l, i) => (
                      <tr key={i}>
                        <td><span className={`dot ${healthDot(l.health)}`} title={l.reasons.join(", ") || l.health || ""} /></td>
                        <td>{l.name}</td>
                        <td><span className="tag">{l.raid ?? "—"}</span></td>
                        <td className="num">{l.capacityGiB !== null ? `${l.capacityGiB.toLocaleString()} GiB` : "—"}</td>
                        <td>{l.state}{l.rebuilding && l.percent !== null ? ` · ${l.percent}%` : ""}{l.reasons.length ? <small className="warn"> {l.reasons.join(", ")}</small> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <table>
                <thead><tr><th></th><th>Bay</th><th>Model</th><th>Serial</th><th>Type</th><th className="num">Size</th><th className="num">Temp</th><th className="num">Speed</th><th>Firmware</th></tr></thead>
                <tbody>
                  {d.storage.drives.map((x, i) => (
                    <tr key={`${x.serial}-${i}`}>
                      <td><span className={`dot ${healthDot(x.health)}`} title={x.reasons.join(", ") || x.health || ""} /></td>
                      <td>{x.location ?? "—"}</td>
                      <td>{x.model ?? "—"}</td>
                      <td className="sub">{x.serial ?? "—"}</td>
                      <td><span className="tag">{[x.media, x.protocol].filter(Boolean).join(" ")}</span></td>
                      <td className="num">{x.capacityGB !== null ? `${x.capacityGB} GB` : "—"}</td>
                      <td className="num">{x.tempC !== null ? `${x.tempC}°C` : "—"}</td>
                      <td className="num">{x.rpm ? `${x.rpm.toLocaleString()} rpm` : x.ssdWearPct !== null ? `wear ${x.ssdWearPct}%` : "—"}</td>
                      <td className="sub">{x.firmware ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {d.cpu.processors && (
            <Section id={sid("cpus")} title="Processors" count={d.cpu.processors.length} defaultCollapsed>
              <table>
                <thead><tr><th></th><th>Socket</th><th>Model</th><th className="num">Cores</th><th className="num">Threads</th><th className="num">Max clock</th></tr></thead>
                <tbody>
                  {d.cpu.processors.map((p, i) => (
                    <tr key={i}>
                      <td><span className={`dot ${healthDot(p.health)}`} /></td>
                      <td>{p.socket ?? "—"}</td>
                      <td>{p.model ?? "—"}</td>
                      <td className="num">{p.cores ?? "—"}</td>
                      <td className="num">{p.threads ?? "—"}</td>
                      <td className="num">{p.maxMHz ? `${(p.maxMHz / 1000).toFixed(1)} GHz` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {d.memory.dimms && (
            <Section id={sid("dimms")} title="Memory modules" count={d.memory.dimms.length} defaultCollapsed>
              <table>
                <thead><tr><th></th><th>Slot</th><th className="num">Size</th><th>Type</th><th className="num">Speed</th><th className="num">Ranks</th><th>ECC</th><th>Status</th></tr></thead>
                <tbody>
                  {d.memory.dimms.map((m) => (
                    <tr key={m.slot}>
                      <td><span className={`dot ${m.status === "GoodInUse" ? "up" : "pending"}`} /></td>
                      <td>{m.slot}</td>
                      <td className="num">{m.sizeGB !== null ? `${m.sizeGB} GB` : "—"}</td>
                      <td>{[m.type, m.technology].filter(Boolean).join(" ")}</td>
                      <td className="num">{m.mhz ? `${m.mhz} MHz` : "—"}</td>
                      <td className="num">{m.rank ?? "—"}</td>
                      <td className="sub">{m.ecc ?? "—"}</td>
                      <td className="sub">{m.status ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {d.network && (
            <Section id={sid("network")} title="Network ports" count={d.network.reduce((a, n) => a + n.ports.length, 0)} defaultCollapsed>
              <table>
                <thead><tr><th></th><th>Port</th><th>MAC</th><th>Address</th><th className="num">Link</th><th className="num">Rx ok / bad</th><th className="num">Tx ok / bad</th><th>Team</th></tr></thead>
                <tbody>
                  {d.network.flatMap((a) => a.ports.map((p) => (
                    <tr key={`${a.name}-${p.name}`}>
                      <td><span className={`dot ${p.state === "Enabled" ? "up" : "unknown"}`} title={p.state ?? ""} /></td>
                      <td>{p.name}</td>
                      <td className="sub">{p.mac ?? "—"}</td>
                      <td>{p.ips.join(", ") || "—"}</td>
                      <td className="num">{p.speedMbps ? `${p.speedMbps} Mb/s` : "down"}</td>
                      <td className="num">{count(p.goodRx)} / <span style={{ color: p.badRx ? "var(--bad)" : undefined }}>{count(p.badRx)}</span></td>
                      <td className="num">{count(p.goodTx)} / <span style={{ color: p.badTx ? "var(--bad)" : undefined }}>{count(p.badTx)}</span></td>
                      <td className="sub">{p.team ?? "—"}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </Section>
          )}

          {(d.firmware || d.ilo) && (
            <Section id={sid("firmware")} title="Firmware" count={(d.firmware?.length ?? 0) + 3} defaultCollapsed>
              <table>
                <thead><tr><th>Component</th><th>Version</th></tr></thead>
                <tbody>
                  {[
                    { name: "iLO", version: d.ilo?.firmware ?? "" },
                    { name: "System ROM (BIOS)", version: d.bios ?? "" },
                    { name: "Smart Array controller", version: d.storage?.controllers[0]?.firmware ?? "" },
                    ...(d.network ?? []).map((n) => ({ name: n.name, version: n.firmware ?? "" })),
                    ...(d.firmware ?? []),
                  ].filter((f) => f.version).map((f) => <tr key={f.name}><td>{f.name}</td><td className="sub">{f.version}</td></tr>)}
                </tbody>
              </table>
            </Section>
          )}

          {d.ilo && d.ilo.selfTests.length > 0 && (
            <Section id={sid("selftests")} title="iLO self-tests" count={d.ilo.selfTests.length} meta={`${d.ilo.selfTests.filter((t) => t.status !== "OK" && t.status !== "Informational").length} failing`} defaultCollapsed>
              <table>
                <thead><tr><th></th><th>Test</th><th>Notes</th></tr></thead>
                <tbody>
                  {d.ilo.selfTests.map((t) => (
                    <tr key={t.name}>
                      <td><span className={`dot ${t.status === "OK" || t.status === "Informational" ? "up" : "down"}`} title={t.status} /></td>
                      <td>{t.name}</td>
                      <td className="sub" style={{ whiteSpace: "normal" }}>{t.notes ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          <Log id={sid("iml")} title="Hardware log (IML)" entries={d.logs.iml} />
          <Log id={sid("iel")} title="iLO event log" entries={d.logs.iel} />
        </>
      )}
    </CardShell>
  );
}
