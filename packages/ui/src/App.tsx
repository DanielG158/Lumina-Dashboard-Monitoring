import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { useSpeedUnit } from "./components/UnitToggle";
import { api, type AlertsPayload, type AuthStatus, type InstanceUpdate, type MaintenanceStatus, type ModuleInfo } from "./api";
import { LoginDialog, SetupScreen } from "./components/AuthDialogs";
import { LuminaMark } from "./components/Icons";
import { ThemeMenu } from "./components/ThemeMenu";
import { LuminaContext, canOf, roleOf, type Lumina } from "./context";
import { AlertsPage } from "./pages/AlertsPage";
import { AuditPage } from "./pages/AuditPage";
import { NetworkPage } from "./pages/NetworkPage";
import { EnergyPage } from "./pages/EnergyPage";
import { MaintenancePage } from "./pages/MaintenancePage";
import { InstancesPage } from "./pages/InstancesPage";
import { Overview } from "./pages/Overview";
import { SettingsPage } from "./pages/SettingsPage";
import { applyTheme } from "./theme";
import "./styles.css";

const TABS = ["overview", "instances", "alerts", "energy", "network", "maintenance", "settings", "audit", "tv"] as const;
type Tab = (typeof TABS)[number];
const readTab = (): Tab => {
  const t = location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] as Tab;
  return TABS.includes(t) ? t : "overview";
};

const byPosition = (a: InstanceUpdate, b: InstanceUpdate) => a.position - b.position || a.instanceId.localeCompare(b.instanceId);
const EMPTY_ALERTS: AlertsPayload = { active: [], recent: [], muted: [] };

export function App() {
  useSpeedUnit(); // re-draw everything when the speed unit is switched
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [instances, setInstances] = useState<InstanceUpdate[]>([]);
  const [alerts, setAlerts] = useState<AlertsPayload>(EMPTY_ALERTS);
  const [maintenance, setMaintenance] = useState<MaintenanceStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState<{ msg: string; bad?: boolean } | null>(null);
  const [tab, setTab] = useState<Tab>(readTab());
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [login, setLogin] = useState<{ notice?: string } | null>(null);
  const [clock, setClock] = useState(Date.now());
  const toastTimer = useRef<number | undefined>(undefined);

  const role = roleOf(auth);
  const can = canOf(role);

  const notify = useCallback((msg: string, bad = false) => {
    setToast({ msg, bad });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), bad ? 7000 : 4000);
  }, []);

  const reloadAlerts = useCallback(async () => { try { setAlerts(await api.alerts()); } catch { /* not allowed or offline */ } }, []);
  const reloadMaintenance = useCallback(async () => { try { setMaintenance(await api.maintenance()); } catch { /* not allowed or offline */ } }, []);
  const reloadInstances = useCallback(async () => { try { setInstances((await api.instances()).sort(byPosition)); } catch { /* not allowed or offline */ } }, []);
  const reloadAuth = useCallback(async () => {
    try { setAuth(await api.authStatus()); } catch { setAuth({ setupRequired: false, setupCodeRequired: false, openAccess: false, publicView: true, user: null }); }
  }, []);

  useEffect(() => { applyTheme(); void reloadAuth(); }, [reloadAuth]);
  useEffect(() => { const t = setInterval(() => setClock(Date.now()), 30_000); return () => clearInterval(t); }, []);

  // A screen that is left on for weeks must not quietly show old numbers: say so when the link drops or no fresh data arrives,
  // and pick up a new Lumina version by itself.
  const [lostAt, setLostAt] = useState<number | null>(null);
  const everConnected = useRef(false);
  useEffect(() => {
    if (connected) { everConnected.current = true; setLostAt(null); return; }
    if (!everConnected.current) return;
    const t = window.setTimeout(() => setLostAt(Date.now()), 8_000);
    return () => window.clearTimeout(t);
  }, [connected]);
  useEffect(() => {
    if (lostAt === null) return;
    const t = setInterval(() => setClock(Date.now()), 5_000);
    return () => clearInterval(t);
  }, [lostAt]);
  const newest = instances.reduce((m, i) => (i.enabled && i.at ? Math.max(m, i.at) : m), 0);
  const slowest = instances.reduce((m, i) => (i.enabled ? Math.max(m, i.intervalMs) : m), 0);
  const noFresh = connected && newest > 0 && clock - newest > Math.max(5 * 60_000, slowest * 6);
  const stale = lostAt !== null || noFresh;
  useEffect(() => { document.body.classList.toggle("is-stale", stale); return () => document.body.classList.remove("is-stale"); }, [stale]);
  useEffect(() => {
    const loaded = () => document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute("src") ?? null;
    const check = async (force = false) => {
      try {
        const html = await (await fetch("/", { cache: "no-store" })).text();
        const now = /<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+)"/.exec(html)?.[1];
        const mine = loaded();
        if (now && mine && now !== mine) window.location.reload();
        else if (force) window.location.reload();
      } catch { /* still offline: try again later */ }
    };
    const timer = setInterval(() => void check(), 10 * 60_000);
    // After a restart the page may be an old build: compare once the link is back.
    if (connected && everConnected.current && lostAt === null) void check();
    // Disconnected for 5+ minutes while the server answers: the socket is stuck, so start over.
    const stuck = lostAt !== null ? setTimeout(() => { fetch("/health", { cache: "no-store" }).then((r) => { if (r.ok) window.location.reload(); }).catch(() => undefined); }, 5 * 60_000) : undefined;
    return () => { clearInterval(timer); if (stuck) clearTimeout(stuck); };
  }, [connected, lostAt]);

  useEffect(() => {
    const onHash = () => setTab(readTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      if (auth?.user) { notify("Your session ended — please sign in again", true); void reloadAuth(); }
      else setLogin({ notice: "Sign in to do that." });
    };
    window.addEventListener("lumina:unauthorized", onUnauthorized);
    return () => window.removeEventListener("lumina:unauthorized", onUnauthorized);
  }, [auth?.user, notify, reloadAuth]);

  const allowed = !!auth && !auth.setupRequired && (auth.publicView || !!auth.user);
  const identity = auth?.user?.username ?? "";

  useEffect(() => {
    if (!allowed) return;
    api.modules().then(setModules).catch(() => undefined);
    void reloadAlerts();
    void reloadInstances();
    void reloadMaintenance();
    const socket: Socket = io();
    let timer: number | undefined;
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("snapshot", (list: InstanceUpdate[]) => setInstances([...list].sort(byPosition)));
    socket.on("module:update", (u: InstanceUpdate) =>
      setInstances((prev) => {
        const i = prev.findIndex((x) => x.instanceId === u.instanceId);
        const next = i === -1 ? [...prev, u] : prev.map((x, k) => (k === i ? { ...u, position: x.position } : x));
        return next.sort(byPosition);
      }),
    );
    socket.on("alerts:changed", () => { window.clearTimeout(timer); timer = window.setTimeout(() => void reloadAlerts(), 300); });
    socket.on("instances:reordered", () => void reloadInstances());
    socket.on("maintenance:changed", () => void reloadMaintenance());
    return () => { window.clearTimeout(timer); socket.disconnect(); };
  }, [allowed, identity, reloadAlerts, reloadInstances, reloadMaintenance]);

  // A wall display should keep the screen awake and show problems in the tab title.
  useEffect(() => {
    document.body.classList.toggle("kiosk", tab === "tv");
    let lock: { release: () => Promise<void> } | null = null;
    if (tab === "tv") (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<typeof lock> } }).wakeLock?.request("screen").then((l) => { lock = l; }).catch(() => undefined);
    return () => { document.body.classList.remove("kiosk"); void lock?.release().catch(() => undefined); };
  }, [tab]);
  useEffect(() => { const n = alerts.active.filter((a) => !a.suppressed).length; document.title = n ? `(${n}) Lumina` : "Lumina"; }, [alerts.active]);

  const go = useCallback((t: string, keepScroll = false) => { location.hash = `#/${t}`; setTab(t as Tab); if (!keepScroll) window.scrollTo({ top: 0 }); }, []);

  const ctx: Lumina = useMemo(() => ({
    auth, role, can, modules, instances, alerts, connected, notify,
    alertsFor: (id) => alerts.active.filter((a) => a.instanceId === id),
    maintenance,
    maintenanceFor: (id) => maintenance?.active.find((a) => a.scope.includes("*") || a.scope.includes(id)) ?? null,
    reloadMaintenance,
    reloadAuth, reloadAlerts, reloadInstances,
    requireLogin: () => setLogin({}),
    go,
    edit: (id) => { setAdding(false); setEditing(id); if (location.hash !== "#/instances") go("instances"); },
    startAdding: () => { setEditing(null); setAdding(true); if (location.hash !== "#/instances") go("instances"); },
  }), [auth, role, can, modules, instances, alerts, maintenance, connected, notify, reloadAuth, reloadAlerts, reloadInstances, reloadMaintenance, go]);

  async function enterTv() {
    try { await document.documentElement.requestFullscreen?.(); } catch { /* not allowed */ }
    go("tv");
  }
  async function exitTv() {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    go("overview");
  }

  if (!auth) return <div className="authscreen"><div className="sub">Loading…</div></div>;
  if (auth.setupRequired && !auth.openAccess) return <SetupScreen codeRequired={auth.setupCodeRequired} onDone={async () => { await reloadAuth(); }} />;
  if (!auth.publicView && !auth.user) {
    return <div className="authscreen"><LoginDialog notice="Sign in to view this dashboard." onClose={() => undefined} onDone={() => void reloadAuth()} /></div>;
  }

  const live = alerts.active.filter((a) => !a.suppressed);
  const crit = live.filter((a) => a.severity === "critical").length;
  const tabs: [Tab, string][] = [["overview", "Overview"], ["instances", "Instances"], ["alerts", "Alerts"], ["energy", "Energy"], ["network", "Network"], ["maintenance", "Maintenance"]];
  if (auth.user || auth.openAccess) tabs.push(["settings", "Settings"]);
  if (can.admin) tabs.push(["audit", "Audit log"]);

  const finish = (msg: string) => { setAdding(false); setEditing(null); notify(msg); void reloadInstances(); };

  return (
    <LuminaContext.Provider value={ctx}>
      {tab === "tv" ? (
        <Overview kiosk onExit={() => void exitTv()} />
      ) : (
        <div className={`app ${tab === "overview" ? "fit" : ""}`}>
          <header className="topbar">
            <div className="brand"><LuminaMark size={28} />Lumina{auth.siteName ? <small>{auth.siteName}</small> : null}</div>
            <nav className="nav" aria-label="Sections">
              {tabs.map(([id, label]) => (
                <button key={id} className={tab === id ? "on" : ""} onClick={() => go(id)}>
                  {label}
                  {id === "alerts" && live.length > 0 && <span className={`badge ${crit ? "" : "warn"}`}>{live.length}</span>}
                  {id === "maintenance" && (maintenance?.active.length ?? 0) > 0 && <span className="badge" style={{ background: "var(--accent)", color: "var(--on-accent)" }}>on</span>}
                </button>
              ))}
            </nav>
            <div className="right">
              <span className="live" title={connected ? "Receiving live updates" : "Reconnecting…"}><span className={`dot ${connected ? "up" : "down"}`} /><span>{connected ? "live" : "offline"}</span></span>
              <span className="clock">{new Date(clock).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              <ThemeMenu />
              <button className="btn sm" onClick={() => void enterTv()} title="Full-screen wall display that stays awake">TV mode</button>
              {auth.user ? (
                <button className="btn sm" onClick={() => go("settings")} title="Account and settings">{auth.user.username} · {auth.user.role}</button>
              ) : (
                <button className="btn sm primary" onClick={() => setLogin({})}>Sign in</button>
              )}
            </div>
          </header>

          {auth.openAccess && (
            <div className="panel" style={{ borderColor: "var(--warn)", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "8px 14px" }}>
              <span className="dot pending" />
              <span style={{ flex: 1, minWidth: 220 }}><b>Open access.</b> No accounts exist, so anyone who can reach this page can control everything.</span>
              <button className="btn sm primary" onClick={() => { go("settings"); }}>Create an admin account</button>
            </div>
          )}
          {tab === "overview" && <Overview />}
          {tab === "instances" && <InstancesPage adding={adding} editing={editing} onClose={() => { setAdding(false); setEditing(null); }} onDone={finish} />}
          {tab === "alerts" && <AlertsPage />}
          {tab === "energy" && <EnergyPage />}
          {tab === "network" && <NetworkPage />}
          {tab === "maintenance" && <MaintenancePage />}
          {tab === "settings" && (auth.user || auth.openAccess) && <SettingsPage />}
          {tab === "audit" && can.admin && <AuditPage />}
        </div>
      )}

      {login && <LoginDialog notice={login.notice} onClose={() => setLogin(null)} onDone={() => { setLogin(null); void reloadAuth(); notify("Signed in"); }} />}
      {stale && (
        <div className="stale-banner" role="alert">
          {lostAt !== null ? "Connection to Lumina lost" : "No fresh data"}
          <span className="sub">
            {lostAt !== null ? "Trying to reconnect. " : "Lumina is not receiving updates. "}
            What you see is from {new Date(newest || lostAt || clock).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} and may be out of date.
          </span>
        </div>
      )}
      {toast && <div className={`toast ${toast.bad ? "bad" : ""}`} role="status">{toast.msg}</div>}
    </LuminaContext.Provider>
  );
}
