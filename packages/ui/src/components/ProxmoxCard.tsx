import { useState } from "react";
import { api } from "../api";
import { useLumina } from "../context";
import { Spark } from "./charts";
import { CardShell, barClass, clamp, type CardProps } from "./CardShell";
import { Section } from "./Section";
import { forecastText, useForecasts } from "../hooks";

interface NodeDetails {
  version: string | null; kernel: string | null; cpuModel: string | null; cpus: number | null; sockets: number | null;
  loadavg: number[] | null; swap: { used: number; total: number } | null; rootfs: { used: number; total: number } | null;
  bootMode: string | null;
}
interface PveNode {
  node: string; status: string; cpu: number; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number;
  details?: NodeDetails;
}
interface PveGuestBackup { lastBackup: number | null; backupCount: number; backupCovered: boolean; backupExcluded: boolean }
interface PveGuest extends Partial<PveGuestBackup> {
  vmid: number; name: string; type: "qemu" | "lxc"; status: string; node: string; cpu: number; mem: number; maxmem: number;
  maxdisk: number; uptime: number; template: boolean; consoleUrl?: string | null; tags: string[]; pool: string | null; ha: string | null;
}
interface Storage { id: string; name: string; node: string; kind: string; content: string[]; shared: boolean; status: string; used: number; total: number }
interface Disk { node: string; dev: string; model: string | null; serial: string | null; sizeBytes: number; kind: string | null; health: string | null; wearout: number | null; usedBy: string | null }
interface Iface { node: string; iface: string; kind: string; active: boolean; address: string | null; gateway: string | null; ports: string | null; comment: string | null }
interface Task { node: string; user: string; type: string; id: string | null; status: string; start: number; end: number | null }
interface LogEntry { time: number; node: string; user: string; tag: string; msg: string }
interface Backup { id: string; enabled: boolean; schedule: string; storage: string | null; mode: string | null; target: string; comment: string | null }
interface Ha { id: string; type: string; status: string; node: string | null }
interface ProxmoxData {
  nodes: PveNode[]; guests: PveGuest[]; storage: Storage[]; pools: { id: string; comment: string }[]; disks: Disk[]; network: Iface[];
  tasks: Task[]; log: LogEntry[]; backups: Backup[]; ha: Ha[];
  cluster: { name: string; quorate: boolean; nodes: number } | null; warnings: string[];
  backupPolicy?: { maxAgeDays: number; listOk: boolean };
}

const EMPTY: ProxmoxData = {
  nodes: [], guests: [], storage: [], pools: [], disks: [], network: [], tasks: [], log: [], backups: [], ha: [], cluster: null, warnings: [],
};

const gb = (b: number) => (b / 1024 ** 3).toFixed(1);
const size = (b: number) => (b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(2)} TB` : `${gb(b)} GB`);
const pct = (n: number) => `${Math.round(n * 100)}%`;
const when = (s: number) => new Date(s * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function span(s: number) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : `${Math.max(0, Math.round(s))}s`;
}
const taskDot = (s: string) => (s === "OK" ? "up" : s === "running" ? "pending" : s.startsWith("WARNINGS") ? "pending" : "down");
const healthDot = (h: string | null) => (h === "OK" || h === "PASSED" ? "up" : h && h !== "UNKNOWN" ? "down" : "unknown");

interface GuestTableProps {
  id: string;
  title: string;
  guests: PveGuest[];
  pending: string | null;
  maxAgeDays: number;
  canOperate: boolean;
  onAction: (op: "start" | "stop" | "reboot", g: PveGuest) => void;
  onDialog: (kind: "snapshot" | "backup", g: PveGuest) => void;
}

function backupCell(g: PveGuest, maxAgeDays: number) {
  if (g.template) return <span className="sub">—</span>;
  if (g.backupExcluded) return <span className="sub">excluded</span>;
  if (g.lastBackup) {
    const days = (Date.now() / 1000 - g.lastBackup) / 86400;
    const stale = maxAgeDays > 0 && days > maxAgeDays;
    return <span style={{ color: stale ? "var(--warn)" : undefined }} title={new Date(g.lastBackup * 1000).toLocaleString()}>{days < 1 ? "today" : `${Math.floor(days)} d ago`}{g.backupCount && g.backupCount > 1 ? <span className="sub"> · {g.backupCount}</span> : null}</span>;
  }
  return g.backupCovered ? <span style={{ color: "var(--warn)" }}>none found</span> : <span className="sub">not in a job</span>;
}

function GuestTable({ id, title, guests, pending, maxAgeDays, canOperate, onAction, onDialog }: GuestTableProps) {
  const running = guests.filter((g) => g.status === "running").length;
  const sorted = [...guests].sort((a, b) => a.node.localeCompare(b.node) || a.vmid - b.vmid);
  return (
    <Section id={id} title={title} count={guests.length} meta={`${running} running`}>
      <table>
        <thead>
          <tr>
            <th></th><th>ID</th><th>Name</th><th>Node</th><th className="num">CPU</th><th className="num">RAM</th>
            <th className="num">Disk</th><th className="num">Uptime</th><th className="num">Last backup</th>{canOperate && <th className="num">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((g) => {
            const up = g.status === "running";
            const busy = (op: string) => pending === `${g.vmid}:${op}`;
            return (
              <tr key={`${g.node}-${g.vmid}`}>
                <td><span className={`dot ${g.status}`} /></td>
                <td>{g.vmid}</td>
                <td>
                  {g.name}
                  {g.template && <span className="tag" style={{ marginLeft: 6 }}>template</span>}
                  {g.ha && <span className="tag" style={{ marginLeft: 6 }}>HA</span>}
                  {g.pool && <span className="tag" style={{ marginLeft: 6 }}>pool: {g.pool}</span>}
                  {g.tags.map((t) => <span className="tag" key={t} style={{ marginLeft: 6 }}>{t}</span>)}
                </td>
                <td>{g.node}</td>
                <td className="num">{up ? pct(g.cpu) : "—"}</td>
                <td className="num">{up ? `${gb(g.mem)} / ${gb(g.maxmem)} GB` : `${gb(g.maxmem)} GB`}</td>
                <td className="num">{gb(g.maxdisk)} GB</td>
                <td className="num">{backupCell(g, maxAgeDays)}</td>
                <td className="num">{up ? span(g.uptime) : "—"}</td>
                {canOperate && <td>
                  <div className="actions">
                    {!g.template && !up && <button className="btn sm" disabled={!!pending} onClick={() => onAction("start", g)}>{busy("start") ? "…" : "Start"}</button>}
                    {!g.template && up && <button className="btn sm" disabled={!!pending} onClick={() => onAction("reboot", g)}>{busy("reboot") ? "…" : "Reboot"}</button>}
                    {!g.template && up && <button className="btn sm danger" disabled={!!pending} onClick={() => onAction("stop", g)}>{busy("stop") ? "…" : "Stop"}</button>}
                    {!g.template && up && g.consoleUrl && <a className="btn sm" href={g.consoleUrl} target="_blank" rel="noopener noreferrer" title="Open the console in Proxmox (you sign in there)">Console</a>}
                    {!g.template && <button className="btn sm" disabled={!!pending} title="Take a snapshot" onClick={() => onDialog("snapshot", g)}>Snapshot</button>}
                    {!g.template && <button className="btn sm" disabled={!!pending} title="Back up now" onClick={() => onDialog("backup", g)}>Backup</button>}
                  </div>
                </td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}

const gbFree = (s: Storage) => ((s.total - s.used) / 1024 ** 3).toFixed(0);

function GuestDialog({ instanceId, kind, guest, storages, onClose, onDone }: {
  instanceId: string; kind: "snapshot" | "backup"; guest: PveGuest; storages: Storage[]; onClose: () => void; onDone: (msg: string) => void;
}) {
  const targets = storages.filter((s) => s.content.includes("backup") && s.status === "available" && (s.node === guest.node || s.shared));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [storage, setStorage] = useState(targets[0]?.name ?? "");
  const [mode, setMode] = useState("snapshot");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = `${guest.name} (${guest.type === "qemu" ? "VM" : "CT"} ${guest.vmid})`;
  const chosen = targets.find((s) => s.name === storage);
  const fullness = chosen && chosen.total ? chosen.used / chosen.total : 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const base = { node: guest.node, type: guest.type, vmid: guest.vmid };
    try {
      if (kind === "snapshot") {
        const res = (await api.action(instanceId, "snapshot", { ...base, ...(name.trim() ? { name: name.trim() } : {}), ...(description.trim() ? { description: description.trim() } : {}) })).result as { snapshot?: string };
        onDone(`Snapshot "${res.snapshot}" of ${label} started — see Recent tasks for progress`);
      } else {
        await api.action(instanceId, "backup", { ...base, storage, mode });
        onDone(`Backup of ${label} started on ${storage} — see Recent tasks for progress`);
      }
    } catch (err) {
      // Show Proxmox's explanation without the internal request line.
      setError((err instanceof Error ? err.message : String(err)).replace(/^proxmox \w+ \S+ -> \d+ /, ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <form className="dialog stack" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div>
          <h2>{kind === "snapshot" ? "Take a snapshot" : "Back up now"}</h2>
          <div className="sub">{label} on {guest.node}</div>
        </div>
        {kind === "snapshot" ? (
          <>
            <label className="stack" style={{ gap: 4 }}><span className="sub">Name (optional)</span>
              <input className="field" value={name} placeholder="automatic: lumina-date-time" maxLength={40} autoFocus onChange={(e) => setName(e.target.value)} /></label>
            <label className="stack" style={{ gap: 4 }}><span className="sub">Description (optional)</span>
              <input className="field" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} /></label>
            <div className="hint">{guest.type === "qemu" ? "Disk state only; the running memory is not included. " : ""}Snapshots live on the same storage as the guest, so they are not a replacement for a backup.</div>
          </>
        ) : targets.length === 0 ? (
          <div className="error">No backup storage is available on {guest.node}. Add a storage with the "VZDump backup file" content type in Proxmox first.</div>
        ) : (
          <>
            <label className="stack" style={{ gap: 4 }}><span className="sub">Store the backup on</span>
              <select className="field" value={storage} onChange={(e) => setStorage(e.target.value)}>
                {targets.map((s) => <option key={s.id} value={s.name}>{s.name} — {Math.round((s.used / s.total) * 100)}% used, {gbFree(s)} GB free</option>)}
              </select></label>
            {fullness >= 0.9 && <div className="error">This storage is {Math.round(fullness * 100)}% full. A backup of this guest could fill it.</div>}
            <label className="stack" style={{ gap: 4 }}><span className="sub">Mode</span>
              <select className="field" value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="snapshot">Snapshot — no downtime (recommended)</option>
                <option value="suspend">Suspend — brief pause while copying</option>
                <option value="stop">Stop — shuts the guest down, then restarts it</option>
              </select></label>
            {mode !== "snapshot" && guest.status === "running" && <div className="error">This will interrupt {guest.name} while the backup runs.</div>}
          </>
        )}
        {error && <div className="error">{error}</div>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || (kind === "backup" && targets.length === 0)}>{busy ? "Starting…" : kind === "snapshot" ? "Take snapshot" : "Start backup"}</button>
        </div>
      </form>
    </div>
  );
}

export function ProxmoxCard(props: CardProps) {
  const { instance } = props;
  const { notify, can } = useLumina();
  const data = { ...EMPTY, ...((instance.data ?? {}) as Partial<ProxmoxData>) };
  const [pending, setPending] = useState<string | null>(null);
  const forecasts = useForecasts();
  const [dialog, setDialog] = useState<{ kind: "snapshot" | "backup"; guest: PveGuest } | null>(null);
  const sid = (name: string) => `proxmox:${instance.instanceId}:${name}`;

  async function run(op: "start" | "stop" | "reboot", g: PveGuest) {
    if (op !== "start" && !confirm(`${op} ${g.name} (${g.vmid})?`)) return;
    setPending(`${g.vmid}:${op}`);
    try {
      await api.action(instance.instanceId, op, { node: g.node, type: g.type, vmid: g.vmid });
      notify(`${op} sent to ${g.name}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setPending(null);
    }
  }

  const nodes = data.nodes.filter((n) => typeof n.maxmem === "number");
  const vms = data.guests.filter((g) => g.type === "qemu");
  const cts = data.guests.filter((g) => g.type === "lxc");

  return (
    <CardShell {...props} tag="Proxmox VE" historyPrefer={nodes[0] ? [`cpu:${nodes[0].node}`] : undefined}>
      {data.nodes.length === 0 && <div className="empty">No data yet — check credentials or wait for the first poll.</div>}

      {data.nodes.length > 0 && nodes.length === 0 && (
        <div className="error">
          Connected, but the API token has no permissions. In Proxmox, grant the token's user a role (e.g. PVEAuditor or
          PVEAdmin) at path / with Propagate ticked, and do the same for the token if Privilege Separation is on.
        </div>
      )}

      {data.cluster && (
        <div className="sub" style={{ marginBottom: 8 }}>
          <span className={`dot ${data.cluster.quorate ? "up" : "down"}`} style={{ marginRight: 6 }} />
          Cluster <b>{data.cluster.name}</b> · {data.cluster.quorate ? "quorate" : "NO QUORUM"} · {data.cluster.nodes} node{data.cluster.nodes === 1 ? "" : "s"}
        </div>
      )}

      {data.warnings.length > 0 && (
        <div className="error" title={data.warnings.join("\n")}>
          Some data is unavailable (token lacks permission?): {data.warnings.map((w) => w.split(":")[0]).join(", ")}
        </div>
      )}

      <div className="grid">
        {nodes.map((n) => {
          const d = n.details;
          return (
            <div className="stat" key={n.node}>
              <div className="label"><span className={`dot ${n.status}`} />{n.node} · up {span(n.uptime)}{d?.version ? ` · PVE ${d.version}` : ""}</div>
              <div className="value">{pct(n.cpu)} <span className="sub">CPU</span></div>
              <Spark instanceId={instance.instanceId} metric={`cpu:${n.node}`} unit="%" />
              <div className="sub">RAM {gb(n.mem)} / {gb(n.maxmem)} GB</div>
              <div className="bar"><i className={barClass(n.mem / n.maxmem)} style={{ width: pct(n.mem / n.maxmem) }} /></div>
              {d?.swap && d.swap.total > 0 && (
                <>
                  <div className="sub" style={{ marginTop: 6 }}>Swap {gb(d.swap.used)} / {gb(d.swap.total)} GB</div>
                  <div className="bar"><i className={barClass(d.swap.used / d.swap.total)} style={{ width: clamp((d.swap.used / d.swap.total) * 100) }} /></div>
                </>
              )}
              <div className="sub" style={{ marginTop: 6 }}>Root disk {gb(n.disk)} / {gb(n.maxdisk)} GB</div>
              <div className="bar"><i className={barClass(n.disk / n.maxdisk)} style={{ width: pct(n.disk / n.maxdisk) }} /></div>
              {d && (
                <div className="sub" style={{ marginTop: 8, lineHeight: 1.6 }}>
                  {d.cpuModel && <div>{d.cpuModel} · {d.cpus} threads{d.sockets ? ` · ${d.sockets} socket${d.sockets === 1 ? "" : "s"}` : ""}</div>}
                  {d.loadavg && <div>Load {d.loadavg.map((l) => l.toFixed(2)).join(" · ")}</div>}
                  {d.kernel && <div>{d.kernel.split(" ").slice(0, 2).join(" ")}{d.bootMode ? ` · ${d.bootMode} boot` : ""}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {vms.length > 0 && <GuestTable id={sid("vms")} title="Virtual machines" guests={vms} pending={pending} maxAgeDays={data.backupPolicy?.maxAgeDays ?? 0} canOperate={can.operate} onAction={run} onDialog={(kind, guest) => setDialog({ kind, guest })} />}
      {cts.length > 0 && <GuestTable id={sid("cts")} title="Containers" guests={cts} pending={pending} maxAgeDays={data.backupPolicy?.maxAgeDays ?? 0} canOperate={can.operate} onAction={run} onDialog={(kind, guest) => setDialog({ kind, guest })} />}

      {data.storage.length > 0 && (
        <Section id={sid("storage")} title="Storage" count={data.storage.length}>
          <table>
            <thead><tr><th></th><th>Name</th><th>Node</th><th>Type</th><th>Content</th><th className="num">Usage</th><th>Forecast</th></tr></thead>
            <tbody>
              {data.storage.map((s) => {
                const ratio = s.total ? s.used / s.total : 0;
                return (
                  <tr key={s.id}>
                    <td><span className={`dot ${s.status === "available" ? "up" : "down"}`} /></td>
                    <td>{s.name}{s.shared && <span className="tag" style={{ marginLeft: 6 }}>shared</span>}</td>
                    <td>{s.node}</td>
                    <td><span className="tag">{s.kind}</span></td>
                    <td className="sub">{s.content.join(", ")}</td>
                    <td className="num" style={{ minWidth: 190 }}>
                      {size(s.used)} / {size(s.total)} · {pct(ratio)}
                      <div className="bar"><i className={barClass(ratio)} style={{ width: clamp(ratio * 100) }} /></div>
                    </td>
                    <td className="sub">{(() => { const f = forecastText(forecasts.get(`${s.name}@${s.node}`), true); return f ? <span style={{ color: f.warn ? "var(--warn)" : undefined }}>{f.text}</span> : "—"; })()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>
      )}

      {data.disks.length > 0 && (
        <Section id={sid("disks")} title="Disks (SMART)" count={data.disks.length} meta={`${data.disks.filter((d) => healthDot(d.health) === "down").length} failing`}>
          <table>
            <thead><tr><th></th><th>Device</th><th>Node</th><th>Model</th><th>Serial</th><th>Type</th><th className="num">Size</th><th className="num">Wearout</th><th>Used by</th></tr></thead>
            <tbody>
              {data.disks.map((d) => (
                <tr key={`${d.node}-${d.dev}`}>
                  <td><span className={`dot ${healthDot(d.health)}`} title={d.health ?? "unknown"} /></td>
                  <td>{d.dev}</td>
                  <td>{d.node}</td>
                  <td>{d.model ?? "—"}</td>
                  <td className="sub">{d.serial ?? "—"}</td>
                  <td><span className="tag">{d.kind ?? "?"}</span></td>
                  <td className="num">{size(d.sizeBytes)}</td>
                  <td className="num">{d.wearout !== null ? `${d.wearout}%` : "—"}</td>
                  <td className="sub">{d.usedBy ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {data.network.length > 0 && (
        <Section id={sid("network")} title="Network" count={data.network.length} defaultCollapsed>
          <table>
            <thead><tr><th></th><th>Interface</th><th>Node</th><th>Type</th><th>Address</th><th>Gateway</th><th>Ports</th></tr></thead>
            <tbody>
              {data.network.map((i) => (
                <tr key={`${i.node}-${i.iface}`}>
                  <td><span className={`dot ${i.active ? "up" : "unknown"}`} /></td>
                  <td>{i.iface}{i.comment && <span className="sub"> · {i.comment}</span>}</td>
                  <td>{i.node}</td>
                  <td><span className="tag">{i.kind}</span></td>
                  <td>{i.address ?? "—"}</td>
                  <td>{i.gateway ?? "—"}</td>
                  <td className="sub">{i.ports ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {data.backups.length > 0 && (
        <Section id={sid("backups")} title="Backup jobs" count={data.backups.length} defaultCollapsed>
          <table>
            <thead><tr><th></th><th>Schedule</th><th>Storage</th><th>Mode</th><th>Targets</th></tr></thead>
            <tbody>
              {data.backups.map((b) => (
                <tr key={b.id}>
                  <td><span className={`dot ${b.enabled ? "up" : "unknown"}`} /></td>
                  <td>{b.schedule || "—"}</td>
                  <td>{b.storage ?? "—"}</td>
                  <td><span className="tag">{b.mode ?? "?"}</span></td>
                  <td className="sub" style={{ whiteSpace: "normal" }}>{b.target}{b.comment ? ` · ${b.comment}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {data.tasks.length > 0 && (
        <Section id={sid("tasks")} title="Recent tasks" count={data.tasks.length} defaultCollapsed>
          <table>
            <thead><tr><th></th><th>Started</th><th>Node</th><th>User</th><th>Task</th><th className="num">Duration</th><th>Status</th></tr></thead>
            <tbody>
              {data.tasks.map((t, i) => (
                <tr key={`${t.start}-${i}`}>
                  <td><span className={`dot ${taskDot(t.status)}`} /></td>
                  <td>{when(t.start)}</td>
                  <td>{t.node}</td>
                  <td>{t.user}</td>
                  <td>{t.type}{t.id ? ` ${t.id}` : ""}</td>
                  <td className="num">{t.end ? span(t.end - t.start) : "…"}</td>
                  <td className="sub" style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>{t.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {data.log.length > 0 && (
        <Section id={sid("log")} title="Cluster log" count={data.log.length} defaultCollapsed>
          <table>
            <thead><tr><th>Time</th><th>Node</th><th>User</th><th>Service</th><th>Message</th></tr></thead>
            <tbody>
              {data.log.map((l, i) => (
                <tr key={`${l.time}-${i}`}>
                  <td>{when(l.time)}</td>
                  <td>{l.node}</td>
                  <td>{l.user}</td>
                  <td><span className="tag">{l.tag}</span></td>
                  <td className="sub" style={{ whiteSpace: "normal" }}>{l.msg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {data.ha.length > 0 && (
        <Section id={sid("ha")} title="High availability" count={data.ha.length} defaultCollapsed>
          <table>
            <thead><tr><th></th><th>Item</th><th>Type</th><th>Node</th><th>Status</th></tr></thead>
            <tbody>
              {data.ha.map((h) => (
                <tr key={h.id}>
                  <td><span className={`dot ${healthDot(h.status.startsWith("OK") || /active|started|idle/i.test(h.status) ? "OK" : h.status)}`} /></td>
                  <td>{h.id}</td>
                  <td><span className="tag">{h.type}</span></td>
                  <td>{h.node ?? "—"}</td>
                  <td className="sub">{h.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {data.pools.length > 0 && (
        <Section id={sid("pools")} title="Resource pools" count={data.pools.length} defaultCollapsed>
          <table>
            <thead><tr><th>Pool</th><th>Comment</th></tr></thead>
            <tbody>{data.pools.map((p) => <tr key={p.id}><td>{p.id}</td><td className="sub">{p.comment || "—"}</td></tr>)}</tbody>
          </table>
        </Section>
      )}
      {dialog && (
        <GuestDialog
          instanceId={instance.instanceId}
          kind={dialog.kind}
          guest={dialog.guest}
          storages={data.storage}
          onClose={() => setDialog(null)}
          onDone={(msg) => { setDialog(null); notify(msg); }}
        />
      )}
    </CardShell>
  );
}
