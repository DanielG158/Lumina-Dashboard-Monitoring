import { useEffect, useState, type ReactNode } from "react";
import { api, type InstanceUpdate } from "../api";
import { useLumina } from "../context";
import { ago, every, summarize } from "../summaries";
import { HistorySection } from "./charts";
import { ModuleIcon } from "./Icons";

export interface CardProps {
  instance: InstanceUpdate;
}

/** The Instances page can open or close every card at once; each card keeps its own choice in this browser. */
export const setAllCards = (open: boolean) => window.dispatchEvent(new CustomEvent("lumina:cards", { detail: open }));

function useOpen(key: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(key) === "1"; } catch { return false; }
  });
  useEffect(() => {
    const all = (e: Event) => {
      const o = Boolean((e as CustomEvent<boolean>).detail);
      try { localStorage.setItem(key, o ? "1" : "0"); } catch { /* storage unavailable */ }
      setOpen(o);
    };
    window.addEventListener("lumina:cards", all);
    return () => window.removeEventListener("lumina:cards", all);
  }, [key]);
  return [open, () => setOpen((o) => {
    try { localStorage.setItem(key, o ? "0" : "1"); } catch { /* storage unavailable */ }
    return !o;
  })];
}

export const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-");

export function CardShell({ instance, tag, children, historyPrefer }: CardProps & { tag: string; children: ReactNode; historyPrefer?: string[] }) {
  const { can, alertsFor, notify, edit, go, instances, reloadInstances, maintenanceFor } = useLumina();
  const maint = maintenanceFor(instance.instanceId);
  const [open, toggle] = useOpen(`lumina:card:${instance.instanceId}`);
  const [busy, setBusy] = useState(false);
  const alerts = alertsFor(instance.instanceId);
  const ids = instances.map((i) => i.instanceId);
  const idx = ids.indexOf(instance.instanceId);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
    return label;
  }

  const move = (delta: number) => {
    const next = [...ids];
    const j = idx + delta;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    void run("move", async () => { await api.reorder(next); await reloadInstances(); });
  };

  return (
    <section className="panel inst" data-status={instance.status} id={`inst-${slug(instance.instanceId)}`}>
      <div className="card-head">
        <button className="card-title" onClick={toggle} aria-expanded={open}>
          <ModuleIcon moduleId={instance.moduleId} />
          <span className={`dot ${instance.status}`} />
          {instance.instanceId}
          <span className="tag">{tag}</span>
          <span className="chevron" style={{ marginLeft: 2 }}>{open ? "▾" : "▸"}</span>
        </button>
        <span className="card-summary">{summarize(instance)}</span>
        <div className="card-tools">
          <span className="meta">{instance.enabled ? `${ago(instance.at)} · every ${every(instance.intervalMs)}` : "paused"}</span>
          {can.operate && instance.enabled && (
            <button className="btn sm icon" title="Refresh now" disabled={busy} onClick={() => run("refresh", () => api.refresh(instance.instanceId))}>⟳</button>
          )}
          {can.admin && (
            <>
              <button className="btn sm" disabled={busy} onClick={() => run("toggle", async () => { await api.setEnabled(instance.instanceId, !instance.enabled); await reloadInstances(); })}>
                {instance.enabled ? "Pause" : "Resume"}
              </button>
              <button className="btn sm icon" title="Move up" disabled={busy || idx <= 0} onClick={() => move(-1)}>▲</button>
              <button className="btn sm icon" title="Move down" disabled={busy || idx === ids.length - 1} onClick={() => move(1)}>▼</button>
              <button className="btn sm" onClick={() => edit(instance.instanceId)}>Edit</button>
              <button
                className="btn sm danger"
                disabled={busy}
                onClick={() => {
                  if (!confirm(`Remove "${instance.instanceId}"? Its history is deleted too.`)) return;
                  void run("remove", async () => { await api.removeInstance(instance.instanceId); await reloadInstances(); notify("Instance removed"); });
                }}
              >Remove</button>
            </>
          )}
        </div>
      </div>

      {maint && (
        <div className="pills"><button className="pill maint" onClick={() => go("maintenance")} title={maint.note ?? undefined}><i className="dot info" /><span>Maintenance: {maint.name} until {new Date(maint.endsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — notifications are muted</span></button></div>
      )}
      {alerts.length > 0 && (
        <div className="pills">
          {alerts.slice(0, 6).map((a) => (
            <button key={a.key} className={`pill ${a.severity}`} title={a.detail ?? a.title} onClick={() => go("alerts")}>
              <i className={`dot ${a.severity}`} /><span>{a.title}</span>
            </button>
          ))}
          {alerts.length > 6 && <button className="pill" title="Open the Alerts page" onClick={() => go("alerts")}>+{alerts.length - 6} more</button>}
        </div>
      )}

      {instance.enabled && instance.status !== "connected" && instance.error && <div className="error">Can't reach this service: {instance.error}</div>}
      {!instance.enabled && open && <div className="empty">This instance is paused, so nothing is being polled. Resume it to see data again.</div>}

      {open && instance.enabled && (
        <>
          {children}
          <HistorySection instanceId={instance.instanceId} prefer={historyPrefer} />
        </>
      )}
    </section>
  );
}

export const barClass = (ratio: number) => (ratio > 0.9 ? "bad" : ratio > 0.75 ? "warn" : "");
export const lowBarClass = (ratio: number) => (ratio < 0.2 ? "bad" : ratio < 0.5 ? "warn" : "");
export const clamp = (n: number) => `${Math.max(0, Math.min(100, n))}%`;
