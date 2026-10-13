import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, type MaintenanceWindow, type ScheduleRow, type ScheduleTarget } from "../api";
import { useLumina } from "../context";
import { clockTime, dateTime, duration, fromLocalInput, toLocalInput } from "../format";

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const QUICK = [15, 30, 60, 120, 240];
const REPEAT: Record<string, string> = { none: "once", daily: "every day", weekly: "every week", once: "once" };

function ScopePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { instances } = useLumina();
  const all = value.includes("*");
  return (
    <div className="stack" style={{ gap: 6 }}>
      <label className="row"><input type="checkbox" checked={all} onChange={(e) => onChange(e.target.checked ? ["*"] : [])} /> Everything (all instances)</label>
      {!all && (
        <div className="chips" style={{ marginBottom: 0 }}>
          {instances.map((i) => <button type="button" key={i.instanceId} className={`chip ${value.includes(i.instanceId) ? "on" : ""}`} onClick={() => onChange(value.includes(i.instanceId) ? value.filter((x) => x !== i.instanceId) : [...value, i.instanceId])}>{i.instanceId}</button>)}
        </div>
      )}
    </div>
  );
}

const scopeText = (scope: string[]) => (scope.includes("*") ? "everything" : scope.join(", "));

export function MaintenancePage() {
  const L = useLumina();
  const { maintenance: m, reloadMaintenance, notify } = L;
  const [scope, setScope] = useState<string[]>(["*"]);
  const [minutes, setMinutes] = useState(60);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<MaintenanceWindow | "new" | null>(null);

  useEffect(() => { void reloadMaintenance(); const t = setInterval(() => void reloadMaintenance(), 30_000); return () => clearInterval(t); }, [reloadMaintenance]);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    try { await fn(); if (ok) notify(ok); await reloadMaintenance(); } catch (e) { notify(err(e), true); } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <div className="page-title"><h1>Maintenance</h1><span className="grow" /><span className="sub">While maintenance is on, alerts are recorded but nobody is notified.</span></div>

      {m && m.active.length > 0 && (
        <section className="panel" style={{ borderColor: "var(--accent)" }}>
          <div className="panel-head"><h2>Running now</h2></div>
          <div className="stack">
            {m.active.map((a) => (
              <div key={a.id} className="row" style={{ justifyContent: "space-between" }}>
                <div><b>{a.name}</b> <span className="sub">for {scopeText(a.scope)} · until {clockTime(a.endsAt)}{a.recurring ? " · repeating" : ""}</span>{a.note && <div className="sub">{a.note}</div>}</div>
                {L.can.operate && <button className="btn sm" disabled={busy} onClick={() => void run(() => api.endMaintenance(a.id), "Maintenance ended")}>End now</button>}
              </div>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 8 }}>Anything that is still wrong when a window ends is reported then, so nothing is lost.</div>
        </section>
      )}

      {L.can.operate ? (
        <section className="panel">
          <div className="panel-head"><h2>Start maintenance now</h2></div>
          <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); if (scope.length === 0) return notify("Choose what is being worked on", true); void run(() => api.startMaintenance({ scope, minutes, name: name.trim() || undefined, note: note.trim() || undefined }), "Maintenance started"); }}>
            <ScopePicker value={scope} onChange={setScope} />
            <div className="row">
              <span className="sub">For</span>
              <div className="seg" role="group">{QUICK.map((q) => <button type="button" key={q} className={minutes === q ? "on" : ""} onClick={() => setMinutes(q)}>{duration(q * 60)}</button>)}</div>
              <input className="field" type="number" min={1} max={10080} style={{ width: 90 }} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /><span className="sub">minutes</span>
            </div>
            <div className="row">
              <input className="field" placeholder="Name (optional), e.g. Moving the rack" style={{ flex: 1, minWidth: 220 }} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
              <input className="field" placeholder="Note (optional)" style={{ flex: 1, minWidth: 220 }} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div><button className="btn primary" disabled={busy}>Start maintenance</button></div>
          </form>
        </section>
      ) : (
        <div className="panel sub">Sign in as an operator or admin to start maintenance.</div>
      )}

      <section className="panel">
        <div className="panel-head"><h2>Scheduled windows</h2>{L.can.admin && <button className="btn sm primary" onClick={() => setEditing("new")}>+ Add</button>}</div>
        {editing && L.can.admin && <WindowForm initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reloadMaintenance(); }} />}
        {m && m.windows.length === 0 && <div className="empty">No scheduled windows. Use one for things that happen on a timetable, like a nightly backup job that makes a VM go quiet.</div>}
        {m && m.windows.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th></th><th>Name</th><th>What</th><th>Starts</th><th>Length</th><th>Repeats</th>{L.can.admin && <th className="num">Actions</th>}</tr></thead>
              <tbody>
                {m.windows.map((w) => (
                  <tr key={w.id}>
                    <td><span className={`dot ${w.enabled ? "up" : "unknown"}`} /></td>
                    <td>{w.name}</td><td className="sub">{scopeText(w.scope)}</td><td>{dateTime(w.startTs)}</td><td>{duration(w.durationS)}</td><td>{REPEAT[w.repeat]}</td>
                    {L.can.admin && <td><div className="actions">
                      <button className="btn sm" onClick={() => setEditing(w)}>Edit</button>
                      <button className="btn sm danger" onClick={() => { if (confirm(`Delete "${w.name}"?`)) void run(() => api.deleteWindow(w.id)); }}>Delete</button>
                    </div></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {m && m.upcoming.length > 0 && (
          <div className="stack" style={{ marginTop: 12 }}>
            <b style={{ fontSize: 13 }}>Coming up (next 7 days)</b>
            {m.upcoming.slice(0, 8).map((u, i) => <div key={`${u.id}-${i}`} className="sub">{dateTime(u.start)} – {clockTime(u.end)} · {u.name} · {scopeText(u.scope)}</div>)}
          </div>
        )}
      </section>

      <ScheduledActions />
    </div>
  );
}

function WindowForm({ initial, onClose, onSaved }: { initial: MaintenanceWindow | null; onClose: () => void; onSaved: () => void }) {
  const { notify } = useLumina();
  const [name, setName] = useState(initial?.name ?? "");
  const [scope, setScope] = useState<string[]>(initial?.scope ?? ["*"]);
  const [start, setStart] = useState(toLocalInput(initial?.startTs ?? Math.floor(Date.now() / 1000) + 3600));
  const [mins, setMins] = useState(initial ? Math.round(initial.durationS / 60) : 60);
  const [repeat, setRepeat] = useState<"none" | "daily" | "weekly">(initial?.repeat ?? "none");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [note, setNote] = useState(initial?.note ?? "");
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body = { name: name.trim(), scope, startTs: fromLocalInput(start), durationMinutes: mins, repeat, note: note.trim() || null, enabled };
    try { if (initial) await api.updateWindow(initial.id, body); else await api.createWindow(body); notify("Saved"); onSaved(); } catch (x) { setError(err(x)); }
  }
  return (
    <form className="subpanel stack" onSubmit={save}>
      <div className="row"><input className="field" required placeholder="Name, e.g. Nightly backups" maxLength={80} style={{ flex: 1, minWidth: 220 }} value={name} onChange={(e) => setName(e.target.value)} /></div>
      <ScopePicker value={scope} onChange={setScope} />
      <div className="row">
        <label className="row"><span className="sub">First starts</span><input className="field" type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="row"><span className="sub">Lasts</span><input className="field" type="number" min={1} max={10080} style={{ width: 90 }} value={mins} onChange={(e) => setMins(Number(e.target.value))} /><span className="sub">min</span></label>
        <label className="row"><span className="sub">Repeats</span><select className="field" value={repeat} onChange={(e) => setRepeat(e.target.value as "none" | "daily" | "weekly")}><option value="none">Never (once)</option><option value="daily">Every day</option><option value="weekly">Every week</option></select></label>
        {initial && <label className="row"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>}
      </div>
      <input className="field" placeholder="Note (optional)" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <div className="error">{error}</div>}
      <div className="row"><button className="btn primary" disabled={scope.length === 0}>Save</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function ScheduledActions() {
  const L = useLumina();
  const [rows, setRows] = useState<ScheduleRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () => api.schedules().then(setRows).catch(() => setRows([]));
  useEffect(() => { if (L.can.operate) { void load(); const t = setInterval(() => void load(), 30_000); return () => clearInterval(t); } }, [L.can.operate]);
  if (!L.can.operate) return null;

  const act = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) L.notify(ok); await load(); } catch (e) { L.notify(err(e), true); } };
  const target = (r: ScheduleRow) => {
    const i = r.input as Record<string, unknown>;
    const guest = i.vmid ? ` · ${i.type === "lxc" ? "CT" : "VM"} ${i.vmid}` : "";
    return `${r.instanceId} · ${r.actionId}${guest}${i.storage ? ` → ${i.storage}` : ""}`;
  };

  return (
    <section className="panel">
      <div className="panel-head"><h2>Scheduled actions</h2>{L.can.admin && <button className="btn sm primary" onClick={() => setAdding((a) => !a)}>{adding ? "Close" : "+ Add"}</button>}</div>
      {adding && L.can.admin && <ScheduleForm onSaved={() => { setAdding(false); void load(); }} />}
      {rows && rows.length === 0 && <div className="empty">Nothing scheduled. Examples: snapshot a VM before a nightly job, or shut the server down at night.</div>}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th></th><th>Name</th><th>What</th><th>First run</th><th>Repeats</th><th>Next run</th><th>Last run</th>{L.can.admin && <th className="num">Actions</th>}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><span className={`dot ${!r.enabled ? "unknown" : r.lastStatus === "failed" ? "down" : r.lastStatus === "missed" ? "pending" : "up"}`} /></td>
                  <td>{r.name}</td><td className="sub">{target(r)}</td><td>{dateTime(r.atTs)}</td><td>{REPEAT[r.repeat]}</td>
                  <td>{r.nextRun ? dateTime(r.nextRun) : <span className="sub">—</span>}</td>
                  <td className="sub" title={r.lastMessage ?? ""} style={{ whiteSpace: "normal", maxWidth: 260 }}>{r.lastRunTs ? `${dateTime(r.lastRunTs)} · ${r.lastStatus}` : "never"}{r.lastStatus === "failed" && r.lastMessage ? ` — ${r.lastMessage.replace(/^proxmox \w+ \S+ -> \d+ /, "")}` : ""}</td>
                  {L.can.admin && <td><div className="actions">
                    <button className="btn sm" onClick={() => { if (confirm(`Run "${r.name}" now?`)) void act(() => api.runScheduleNow(r.id), "Ran it"); }}>Run now</button>
                    <button className="btn sm" onClick={() => void act(() => api.setScheduleEnabled(r.id, !r.enabled))}>{r.enabled ? "Pause" : "Resume"}</button>
                    <button className="btn sm danger" onClick={() => { if (confirm(`Delete "${r.name}"?`)) void act(() => api.deleteSchedule(r.id)); }}>Delete</button>
                  </div></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint" style={{ marginTop: 8 }}>Only safe actions can be scheduled: snapshots, backups and start, stop and reboot for guests, and iLO power on or a graceful shutdown. Hard resets stay manual. If Lumina is not running at the scheduled time the run is skipped, not made up later.</div>
    </section>
  );
}

interface GuestOpt { key: string; node: string; type: "qemu" | "lxc"; vmid: number; name: string }

function ScheduleForm({ onSaved }: { onSaved: () => void }) {
  const L = useLumina();
  const [targets, setTargets] = useState<ScheduleTarget[]>([]);
  const [instanceId, setInstanceId] = useState("");
  const [actionId, setActionId] = useState("");
  const [guestKey, setGuestKey] = useState("");
  const [storage, setStorage] = useState("");
  const [mode, setMode] = useState("snapshot");
  const [snapName, setSnapName] = useState("");
  const [name, setName] = useState("");
  const [when, setWhen] = useState(toLocalInput(Math.floor(Date.now() / 1000) + 3600));
  const [repeat, setRepeat] = useState<"once" | "daily" | "weekly">("once");
  const [error, setError] = useState<string | null>(null);
  const { notify } = L;
  useEffect(() => { api.scheduleTargets().then((t) => { setTargets(t); if (t[0]) { setInstanceId(t[0].instanceId); setActionId(t[0].actions[0]?.id ?? ""); } }).catch((e) => notify(err(e), true)); }, [notify]);

  const target = targets.find((t) => t.instanceId === instanceId);
  const inst = L.instances.find((i) => i.instanceId === instanceId);
  const data = (inst?.data ?? {}) as { guests?: { node: string; type: "qemu" | "lxc"; vmid: number; name: string; template: boolean }[]; storage?: { name: string; content: string[]; status: string }[] };
  const guests: GuestOpt[] = useMemo(() => (data.guests ?? []).filter((g) => !g.template).map((g) => ({ key: `${g.node}/${g.vmid}`, node: g.node, type: g.type, vmid: g.vmid, name: g.name })), [data.guests]);
  const backupStores = (data.storage ?? []).filter((s) => s.content.includes("backup") && s.status === "available");
  const needsGuest = inst?.moduleId === "proxmox";

  useEffect(() => { if (needsGuest && !guestKey && guests[0]) setGuestKey(guests[0].key); }, [needsGuest, guests, guestKey]);
  useEffect(() => { if (!storage && backupStores[0]) setStorage(backupStores[0].name); }, [backupStores, storage]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let input: Record<string, unknown> = {};
    if (needsGuest) {
      const g = guests.find((x) => x.key === guestKey);
      if (!g) return setError("Choose a VM or container");
      input = { node: g.node, type: g.type, vmid: g.vmid };
      if (actionId === "snapshot" && snapName.trim()) input.name = snapName.trim();
      if (actionId === "backup") { if (!storage) return setError("No backup storage available"); input.storage = storage; input.mode = mode; }
    }
    const g = guests.find((x) => x.key === guestKey);
    try {
      await api.createSchedule({ name: name.trim() || `${actionId}${g ? ` ${g.name}` : ""}`, instanceId, actionId, input, repeat, atTs: fromLocalInput(when) });
      L.notify("Scheduled");
      onSaved();
    } catch (x) { setError(err(x)); }
  }

  if (targets.length === 0) return <div className="subpanel hint">Loading what can be scheduled…</div>;
  return (
    <form className="subpanel stack" onSubmit={save}>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="stack" style={{ gap: 4 }}><span className="sub">Instance</span><select className="field" value={instanceId} onChange={(e) => { setInstanceId(e.target.value); setActionId(targets.find((t) => t.instanceId === e.target.value)?.actions[0]?.id ?? ""); setGuestKey(""); }}>{targets.map((t) => <option key={t.instanceId} value={t.instanceId}>{t.instanceId}</option>)}</select></label>
        <label className="stack" style={{ gap: 4 }}><span className="sub">Action</span><select className="field" value={actionId} onChange={(e) => setActionId(e.target.value)}>{target?.actions.map((a) => <option key={a.id} value={a.id}>{a.label}{a.dangerous ? " ⚠" : ""}</option>)}</select></label>
        {needsGuest && <label className="stack" style={{ gap: 4 }}><span className="sub">VM / container</span><select className="field" value={guestKey} onChange={(e) => setGuestKey(e.target.value)}>{guests.map((g) => <option key={g.key} value={g.key}>{g.vmid} · {g.name}</option>)}</select></label>}
        {needsGuest && actionId === "backup" && <>
          <label className="stack" style={{ gap: 4 }}><span className="sub">Storage</span><select className="field" value={storage} onChange={(e) => setStorage(e.target.value)}>{backupStores.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}</select></label>
          <label className="stack" style={{ gap: 4 }}><span className="sub">Mode</span><select className="field" value={mode} onChange={(e) => setMode(e.target.value)}><option value="snapshot">Snapshot (no downtime)</option><option value="suspend">Suspend</option><option value="stop">Stop</option></select></label>
        </>}
        {needsGuest && actionId === "snapshot" && <label className="stack" style={{ gap: 4 }}><span className="sub">Snapshot name (optional)</span><input className="field" maxLength={40} placeholder="automatic" value={snapName} onChange={(e) => setSnapName(e.target.value)} /></label>}
      </div>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label className="stack" style={{ gap: 4 }}><span className="sub">When</span><input className="field" type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} /></label>
        <label className="stack" style={{ gap: 4 }}><span className="sub">Repeats</span><select className="field" value={repeat} onChange={(e) => setRepeat(e.target.value as "once" | "daily" | "weekly")}><option value="once">Once</option><option value="daily">Every day</option><option value="weekly">Every week</option></select></label>
        <label className="stack" style={{ gap: 4, flex: 1, minWidth: 200 }}><span className="sub">Name (optional)</span><input className="field" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
      </div>
      {error && <div className="error">{error}</div>}
      <div><button className="btn primary">Schedule</button></div>
    </form>
  );
}
