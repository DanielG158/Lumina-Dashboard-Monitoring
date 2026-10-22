import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLumina } from "../context";
import { Spark } from "../components/charts";
import { Icon } from "../components/Icons";
import { ago, gather, summarize } from "../summaries";
import { useOverviewDetail } from "../overviewPref";
import { orderOf, useBurnInLayout, useDisplayPrefs } from "../shuffle";
import { forecastText, useCycleEnergy, useForecasts } from "../hooks";
import { clockTime, mbps, money } from "../format";

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Picks the largest text size at which no panel has to scroll, so any screen is filled without scrolling. */
/** Detail levels, most to least: 0 everything, 1 shorter lists, 2 no recent-activity panel, 3 only the top alerts. */
const ALERT_ROWS = (kiosk: boolean) => [kiosk ? 8 : 12, 6, 4, 3];
const RECENT_ROWS = [4, 2, 0, 0];

function useFitText(ref: React.RefObject<HTMLDivElement | null>, deps: unknown[], onStuck: () => void) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      if (window.innerWidth <= 1000) { el.style.fontSize = ""; return; }
      const overflows = () => [...el.querySelectorAll<HTMLElement>(".pbody")].some((p) => p.scrollHeight > p.clientHeight + 1);
      let lo = 11, hi = 34;
      el.style.fontSize = `${hi}px`;
      if (!overflows()) return;
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2;
        el.style.fontSize = `${mid}px`;
        if (overflows()) hi = mid; else lo = mid;
      }
      el.style.fontSize = `${lo}px`;
      // Even the smallest readable text does not fit: ask for less content rather than clipping the alerts.
      if (overflows()) onStuck();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener("resize", fit);
    // Content can settle after the first measurement (data arriving, wrapping changes), so check again every few seconds.
    const again = window.setInterval(fit, 3000);
    return () => { ro.disconnect(); window.removeEventListener("resize", fit); window.clearInterval(again); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

type Level = "ok" | "warning" | "critical" | "neutral";

interface Kpi {
  key: string;
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: string;
  level: Level;
  go: string;
  spark?: { instanceId: string; metric: string; unit: string };
  icon: string;
}

export function Overview({ kiosk = false, onExit }: { kiosk?: boolean; onExit?: () => void }) {
  const L = useLumina();
  const detail = useOverviewDetail();
  const now = useNow(1000);
  const fleet = useMemo(() => gather(L.instances), [L.instances]);
  const energy = useCycleEnergy();
  const forecasts = useForecasts();
  const everything = L.alerts.active;
  const active = everything.filter((a) => !a.suppressed);
  const heldBack = everything.length - active.length;
  const maintNow = L.maintenance?.active ?? [];
  const inMaint = maintNow.length > 0;
  const crit = active.filter((a) => a.severity === "critical").length;
  const warn = active.filter((a) => a.severity === "warning").length;
  const offline = fleet.total - fleet.online;
  const level: Level = crit || offline ? "critical" : warn ? "warning" : "ok";
  const quiet = level === "ok" && inMaint;
  const title = quiet ? "Maintenance in progress" : crit ? `${crit} critical issue${crit === 1 ? "" : "s"}` : offline ? `${offline} device${offline === 1 ? "" : "s"} unreachable` : warn ? `${warn} warning${warn === 1 ? "" : "s"}` : fleet.total === 0 ? "Nothing connected yet" : "All systems operational";
  const sub = [
    inMaint ? `${maintNow[0].name}${maintNow.length > 1 ? ` +${maintNow.length - 1}` : ""} until ${clockTime(maintNow[0].endsAt)} · notifications muted` : null,
    `${fleet.online}/${fleet.total} devices online`,
    fleet.guests.length ? `${fleet.guests.filter((g) => g.status === "running").length}/${fleet.guests.length} guests running` : null,
    fleet.monitors.length ? `${fleet.monitors.filter((m) => m.status === "up").length}/${fleet.monitors.length} monitors up` : null,
  ].filter(Boolean).join("  ·  ");

  const stoppedUnexpectedly = new Set(active.filter((a) => a.key.startsWith("guest-stopped:")).map((a) => a.key.slice("guest-stopped:".length)));
  const vms = fleet.guests.filter((g) => g.type === "qemu");
  const cts = fleet.guests.filter((g) => g.type === "lxc");
  const running = (list: typeof fleet.guests) => list.filter((g) => g.status === "running").length;
  const px = fleet.proxmox[0];
  const avg = (f: (p: (typeof fleet.proxmox)[number]) => number) => (fleet.proxmox.length ? fleet.proxmox.reduce((a, p) => a + f(p), 0) / fleet.proxmox.length : 0);

  const kpis: Kpi[] = [];
  kpis.push({ key: "devices", icon: "screen", label: "Devices online", value: `${fleet.online}/${fleet.total}`, level: fleet.total === 0 ? "neutral" : offline ? "critical" : "ok", go: "instances" });
  if (energy && energy.source && !energy.settingsNote) {
    const b = energy.budget;
    kpis.push({
      key: "energy", icon: "bolt", label: "Energy this cycle", value: energy.kwh >= 100 ? energy.kwh.toFixed(0) : energy.kwh.toFixed(1), unit: "kWh",
      sub: `${money(energy.currency, energy.cost.total)}${energy.projection ? ` · ≈ ${money(energy.currency, energy.projection.cost.total)}/mo` : ""}`,
      level: b && b.usedPct >= 100 ? "critical" : b && b.projectedPct !== null && b.projectedPct > 100 ? "warning" : "neutral", go: "energy",
    });
  }
  if (fleet.backups) {
    const b = fleet.backups;
    kpis.push({
      key: "backups", icon: "disk", label: "Backups fresh", value: `${b.fresh}/${b.tracked}`,
      sub: b.stale ? `${b.stale} older than ${b.maxAgeDays} days` : b.oldestDays !== null ? `oldest ${Math.round(b.oldestDays)} d${b.uncovered ? ` · ${b.uncovered} not in a job` : ""}` : "no backups found",
      level: b.stale ? "warning" : "ok", go: "instances",
    });
  }
  kpis.push({ key: "alerts", icon: "bell", label: "Active alerts", value: active.length, sub: active.length ? `${crit} critical · ${warn} warning` : "all clear", level: crit ? "critical" : warn ? "warning" : "ok", go: "alerts" });
  if (fleet.guests.length) {
    kpis.push({ key: "guests", icon: "cube", label: "Guests running", value: `${running(fleet.guests)}/${fleet.guests.length}`, sub: `${running(vms)}/${vms.length} VMs · ${running(cts)}/${cts.length} CTs`, level: stoppedUnexpectedly.size ? "warning" : "ok", go: "instances" });
  }
  if (px) {
    const cpu = avg((p) => p.cpu), mem = avg((p) => p.mem);
    kpis.push({ key: "host", icon: "cpu", label: "Host load", value: Math.round(cpu), unit: "% CPU", sub: `RAM ${Math.round(mem)}%`, level: cpu > 90 || mem > 95 ? "critical" : cpu > 75 || mem > 85 ? "warning" : "ok", go: "instances", spark: { instanceId: px.instanceId, metric: `cpu:${px.node}`, unit: "%" } });
  }
  if (fleet.ilo) {
    const i = fleet.ilo;
    kpis.push({
      key: "power", icon: "bolt", label: "Server power", value: i.powerState === "On" ? (i.powerW ?? "—") : i.powerState ?? "—", unit: i.powerState === "On" ? "W" : undefined,
      sub: [i.inletC != null ? `inlet ${i.inletC}°C` : null, i.health ? `health ${i.health}` : null].filter(Boolean).join(" · "),
      level: i.health && i.health !== "OK" ? "critical" : i.powerState !== "On" ? "warning" : i.critical && i.hottestC != null && i.hottestC >= i.critical * 0.9 ? "warning" : "ok",
      go: "instances", spark: { instanceId: i.instanceId, metric: "power", unit: " W" },
    });
  }
  if (fleet.ups) {
    const u = fleet.ups;
    kpis.push({
      key: "ups", icon: "apcupsd", label: "UPS battery", value: u.batteryPct != null ? Math.round(u.batteryPct) : "—", unit: "%",
      sub: [u.onBattery ? "ON BATTERY" : "online", u.runtimeMin != null ? `${Math.round(u.runtimeMin)} min` : null, u.loadPct != null ? `load ${Math.round(u.loadPct)}%` : null].filter(Boolean).join(" · "),
      level: u.onBattery ? ((u.batteryPct ?? 100) < 40 ? "critical" : "warning") : (u.batteryPct ?? 100) < 90 ? "warning" : "ok",
      go: "instances", spark: { instanceId: u.instanceId, metric: "load", unit: "%" },
    });
  }
  if (fleet.monitors.length) {
    const down = fleet.monitors.filter((m) => m.status === "down").length;
    const first = fleet.monitors[0];
    kpis.push({ key: "mon", icon: "uptime-kuma", label: "Monitors up", value: `${fleet.monitors.filter((m) => m.status === "up").length}/${fleet.monitors.length}`, sub: down ? `${down} down` : "none down", level: down ? "critical" : "ok", go: "instances", spark: { instanceId: first.instanceId, metric: "response:avg", unit: " ms" } });
  }
  {
    const nets = L.instances.filter((i) => i.moduleId === "netcheck" && i.data);
    if (nets.length) {
      const all = nets.flatMap((i) => ((i.data as { targets: { ok: boolean; ms: number | null; lossPct: number }[] }).targets));
      const up = all.filter((t) => t.ok).length;
      const times = all.filter((t) => t.ok && t.ms !== null).map((t) => t.ms as number);
      const loss = all.length ? all.reduce((a, t) => a + t.lossPct, 0) / all.length : 0;
      const speed = nets.map((i) => (i.data as { speed: { downMbps: number | null } | null }).speed?.downMbps).find((x) => x != null);
      const warn = all.some((t) => t.ok && t.lossPct >= 20);
      kpis.push({
        key: "net", icon: "netcheck", label: "Network checks", value: `${up}/${all.length}`,
        sub: [times.length ? `${Math.round(times.reduce((a, b) => a + b, 0) / times.length)} ms` : null, loss > 0 ? `${Math.round(loss)}% loss` : null, speed != null ? `↓ ${mbps(speed)}` : null].filter(Boolean).join(" · ") || "all answering",
        level: up < all.length ? "critical" : warn ? "warning" : "ok", go: "instances", spark: { instanceId: nets[0].instanceId, metric: "rtt:avg", unit: " ms" },
      });
    }
  }
  {
    const om = L.instances.filter((i) => i.moduleId === "omada" && i.data);
    if (om.length) {
      const sums = om.map((i) => (i.data as { summary: { total: number; online: number; clients: number } }).summary);
      const total = sums.reduce((a, x) => a + x.total, 0), online = sums.reduce((a, x) => a + x.online, 0), clients = sums.reduce((a, x) => a + x.clients, 0);
      kpis.push({ key: "wifi", icon: "omada", label: "Wi-Fi and network", value: `${online}/${total}`, sub: `${clients} client${clients === 1 ? "" : "s"} on Wi-Fi`, level: online < total ? "critical" : "ok", go: "instances", spark: { instanceId: om[0].instanceId, metric: "clients:total", unit: "" } });
    }
  }
  if (fleet.tunnels) kpis.push({ key: "tun", icon: "cloudflare", label: "Tunnels healthy", value: `${fleet.tunnels.healthy}/${fleet.tunnels.total}`, level: fleet.tunnels.healthy < fleet.tunnels.total ? "critical" : "ok", go: "instances" });
  if (fleet.worstStorage) {
    const s = fleet.worstStorage;
    kpis.push({ key: "stor", icon: "disk", label: "Fullest storage", value: Math.round(s.pct), unit: "%", sub: `${s.name} on ${s.node}`, level: s.pct >= 90 ? "critical" : s.pct >= 80 ? "warning" : "ok", go: "instances" });
  }

  const guests = [...vms, ...cts];
  const monitors = [...fleet.monitors].sort((a, b) => (a.status === "down" ? 0 : a.status === "pending" ? 1 : 2) - (b.status === "down" ? 0 : b.status === "pending" ? 1 : 2) || a.name.localeCompare(b.name));
  const [trim, setTrim] = useState(0);
  const recent = L.alerts.recent.slice(0, RECENT_ROWS[trim]);
  const alertRows = ALERT_ROWS(kiosk)[trim];
  const clock = new Date(now);
  const wallRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!kiosk || !onExit) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onExit(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kiosk, onExit]);
  const prefs = useDisplayPrefs();
  const { layout, fading } = useBurnInLayout(prefs.mode === "always" || (prefs.mode === "tv" && kiosk), prefs.seconds, kpis.map((k) => k.key));
  const oL = (k: string) => orderOf(layout.left, k);
  const oR = (k: string) => orderOf(layout.right, k);
  // New content or a new screen size starts again from full detail.
  useEffect(() => { setTrim(0); }, [kiosk, guests.length, monitors.length, active.length, L.instances.length, kpis.length, fleet.storages.length]);
  useEffect(() => { const reset = () => setTrim(0); window.addEventListener("resize", reset); return () => window.removeEventListener("resize", reset); }, []);
  useFitText(wallRef, [kiosk, guests.length, monitors.length, active.length, recent.length, L.instances.length, kpis.length, fleet.storages.length, layout.sig, trim], () => setTrim((t) => Math.min(3, t + 1)));

  return (
    <div ref={wallRef} className={kiosk ? "tv" : "wall fit"}>
      {kiosk && <button className="btn tv-exit" onClick={onExit}>Exit TV mode</button>}

      <div className={`stage-inner ${fading ? "fade" : ""}`} style={{ transform: `translate(${layout.dx}px, ${layout.dy}px)` }}>
      <div className={`banner ${level === "ok" ? (inMaint ? "maint" : "") : level}`} style={{ order: orderOf(layout.blocks, "banner") }}>
        <span className={`dot ${level === "ok" ? (inMaint ? "info" : "up") : level === "warning" ? "pending" : "down"}`} style={{ width: 16, height: 16 }} />
        <div>
          <h1>{title}</h1>
          <div className="sub">{sub}</div>
        </div>
        <div className="clockbig">
          <b>{clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</b>
          <span className="sub">{clock.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</span>
        </div>
      </div>

      <div className="kpis" style={{ order: orderOf(layout.blocks, "kpis") }}>
        {kpis.map((k) => (
          <div key={k.key} className={`kpi ${k.level}`} style={{ order: orderOf(layout.kpis, k.key) }} onClick={() => L.go(k.go)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && L.go(k.go)}>
            <div className="k-label"><Icon name={k.icon} size={14} />{k.label}</div>
            <div className="k-value">{k.value}{k.unit && <small>{k.unit}</small>}</div>
            <div className="k-sub">{k.sub ?? " "}</div>
            {k.spark && <Spark instanceId={k.spark.instanceId} metric={k.spark.metric} unit={k.spark.unit} />}
          </div>
        ))}
      </div>

      <div className={`cols ${layout.swap ? "swap" : ""}`} style={{ order: orderOf(layout.blocks, "cols") }}>
        <div style={{ order: layout.swap ? 1 : 0 }}>
          {guests.length > 0 && detail === "easy" && (() => {
            const stopped = guests.filter((g) => g.status !== "running");
            const pct = (a: number, b: number) => (b ? (a / b) * 100 : 0);
            // Guests that were stopped on purpose are normal: the bars only turn red for ones that stopped on their own.
            const crashed = (list: typeof guests) => list.some((g) => g.status !== "running" && stoppedUnexpectedly.has(String(g.vmid)));
            return (
              <section className="wpanel" style={{ order: oL("guests") }}>
                <h3>Virtual machines &amp; containers <span className="meta">{running(guests)}/{guests.length} running</span></h3>
                <div className="pbody">
                  <div className="bigrow">
                    <div className="bigstat"><div className="num">{running(vms)}<small>/{vms.length}</small></div><div className="lbl">virtual machines running</div><div className="bar"><i className={crashed(vms) ? "bad" : ""} style={{ width: `${pct(running(vms), vms.length)}%` }} /></div></div>
                    <div className="bigstat"><div className="num">{running(cts)}<small>/{cts.length}</small></div><div className="lbl">containers running</div><div className="bar"><i className={crashed(cts) ? "bad" : ""} style={{ width: `${pct(running(cts), cts.length)}%` }} /></div></div>
                  </div>
                  {stopped.length === 0 ? <div className="okline"><span className="dot up" /> Everything is running.</div> : (
                    <>
                      <div className="sub" style={{ marginTop: 8 }}>Not running</div>
                      <div className="chipgrid">
                        {stopped.map((g) => {
                          const bad = stoppedUnexpectedly.has(String(g.vmid));
                          return (
                            <div key={`${g.instanceId}-${g.vmid}`} className={`gchip ${bad ? "bad" : "off"}`} onClick={() => L.go("instances")} title={`${g.name} (${g.type === "qemu" ? "VM" : "CT"} ${g.vmid}) — ${g.status}${bad ? " (stopped unexpectedly)" : ""}`}>
                              <span className={`dot ${bad ? "down" : "unknown"}`} />
                              <span className="n">{g.name}</span>
                              <span className="id">{g.type === "qemu" ? "VM" : "CT"} {g.vmid}</span>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              </section>
            );
          })()}
          {guests.length > 0 && detail === "full" && (
            <section className="wpanel" style={{ order: oL("guests") }}>
              <h3>Virtual machines &amp; containers <span className="meta">{running(vms)}/{vms.length} VMs · {running(cts)}/{cts.length} CTs running</span></h3>
              <div className="pbody chipgrid">
                {guests.map((g) => {
                  const up = g.status === "running";
                  const bad = stoppedUnexpectedly.has(String(g.vmid));
                  return (
                    <div key={`${g.instanceId}-${g.vmid}`} className={`gchip ${up ? "" : bad ? "bad" : "off"}`} onClick={() => L.go("instances")}
                      title={`${g.name} (${g.type === "qemu" ? "VM" : "CT"} ${g.vmid}) on ${g.node} — ${g.status}${up ? ` · CPU ${Math.round(g.cpu * 100)}% · RAM ${(g.mem / 1024 ** 3).toFixed(1)}/${(g.maxmem / 1024 ** 3).toFixed(1)} GB` : ""}`}>
                      <span className={`dot ${up ? "up" : bad ? "down" : "unknown"}`} />
                      <span className="n">{g.name}</span>
                      <span className="id">{g.type === "qemu" ? "VM" : "CT"} {g.vmid}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          {monitors.length > 0 && detail === "easy" && (() => {
            const upN = monitors.filter((m) => m.status === "up").length;
            const trouble = monitors.filter((m) => m.status !== "up");
            const slow = [...monitors].filter((m) => m.status === "up" && m.responseMs != null).sort((a, b) => (b.responseMs as number) - (a.responseMs as number)).slice(0, 3);
            return (
              <section className="wpanel" style={{ order: oL("monitors") }}>
                <h3>Monitors <span className="meta">{upN}/{monitors.length} up</span></h3>
                <div className="pbody">
                  <div className="bigrow">
                    <div className="bigstat"><div className="num">{upN}<small>/{monitors.length}</small></div><div className="lbl">monitors up</div><div className="bar"><i className={trouble.length ? "bad" : ""} style={{ width: `${(upN / monitors.length) * 100}%` }} /></div></div>
                  </div>
                  {trouble.length === 0 ? <div className="okline"><span className="dot up" /> Everything answers.{slow.length > 0 && <span className="sub"> Slowest: {slow.map((m) => `${m.name} ${m.responseMs} ms`).join(" · ")}</span>}</div> : (
                    <>
                      <div className="sub" style={{ marginTop: 8 }}>Not answering</div>
                      <div className="chipgrid wide">
                        {trouble.map((m) => (
                          <div key={`${m.instanceId}-${m.name}`} className={`gchip ${m.status === "down" ? "bad" : "warn"}`} onClick={() => L.go("instances")} title={`${m.name} — ${m.status}${m.target ? ` · ${m.target}` : ""}`}>
                            <span className={`dot ${m.status}`} /><span className="n">{m.name}</span><span className="id">{m.status}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </section>
            );
          })()}
          {monitors.length > 0 && detail === "full" && (
            <section className="wpanel" style={{ order: oL("monitors") }}>
              <h3>Monitors <span className="meta">{monitors.filter((m) => m.status === "up").length}/{monitors.length} up</span></h3>
              <div className="pbody chipgrid wide">
                {monitors.map((m) => (
                  <div key={`${m.instanceId}-${m.name}`} className={`gchip ${m.status === "down" ? "bad" : m.status === "pending" ? "warn" : ""}`} onClick={() => L.go("instances")} title={`${m.name} — ${m.status}${m.target ? ` · ${m.target}` : ""}`}>
                    <span className={`dot ${m.status}`} />
                    <span className="n">{m.name}</span>
                    <span className="id">{m.responseMs != null ? `${m.responseMs} ms` : ""}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {fleet.storages.length > 0 && (
            <section className="wpanel" style={{ order: oL("storage") }}>
              <h3>Storage <span className="meta">{fleet.storages.length} volumes</span></h3>
              <div className="pbody storlist">
                {[...fleet.storages].sort((a, b) => b.pct - a.pct).map((s) => (
                  <div key={`${s.node}-${s.name}`} className="srow" title={`${(s.used / 1024 ** 3).toFixed(0)} of ${(s.total / 1024 ** 3).toFixed(0)} GB`}>
                    <span className="n">{s.name}</span>
                    <span className="bar"><i className={s.pct >= 90 ? "bad" : s.pct >= 80 ? "warn" : ""} style={{ width: `${Math.min(100, s.pct)}%` }} /></span>
                    <span className="p">{Math.round(s.pct)}%</span>
                    {(() => { const f = forecastText(forecasts.get(`${s.name}@${s.node}`)); return f && (f.warn || f.text.startsWith("full")) ? <span className="f" style={{ color: f.warn ? "var(--warn)" : "var(--muted)" }}>{f.text}</span> : <span className="f" />; })()}
                  </div>
                ))}
              </div>
            </section>
          )}
          {guests.length === 0 && monitors.length === 0 && L.instances.some((i) => i.moduleId === "ilo4" && i.data) && (
            <section className="wpanel">
              <h2>Servers</h2>
              <div className="stack">
                {L.instances.filter((i) => i.moduleId === "ilo4" && i.data).map((i) => {
                  const d = i.data as { model: string | null; powerState: string | null; health: string | null; power: { nowW: number | null }; temperatures: { name: string; celsius: number }[]; fans: { reading: number | null; units: string }[]; healthParts?: { name: string; health: string }[] };
                  const inlet = d.temperatures.find((t) => /inlet/i.test(t.name))?.celsius ?? null;
                  const pct = d.fans.filter((f) => f.units === "Percent" && f.reading !== null).map((f) => f.reading as number);
                  const bad = (d.healthParts ?? []).filter((x) => x.health !== "OK");
                  return (
                    <div key={i.instanceId} className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                      <span><span className={`dot ${d.health === "OK" ? "up" : d.health === "Warning" ? "pending" : "down"}`} style={{ marginRight: 8 }} /><b>{i.instanceId}</b> <span className="sub">{d.model ?? ""}</span></span>
                      <span className="sub">{d.powerState ?? "—"} · {d.power.nowW ?? "—"} W{inlet !== null ? ` · inlet ${inlet}°C` : ""}{pct.length ? ` · fans ${Math.round(pct.reduce((a, b) => a + b, 0) / pct.length)}%` : ""}{bad.length ? ` · ${bad.map((x) => `${x.name}: ${x.health}`).join(", ")}` : ""}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          {guests.length === 0 && monitors.length === 0 && !L.instances.some((i) => i.moduleId === "ilo4" && i.data) && (
            <section className="wpanel"><div className="empty">{L.instances.length ? "Waiting for data…" : L.can.admin ? "Nothing connected yet — open the Instances tab and add a module." : "Nothing is connected yet. An admin can add modules."}</div></section>
          )}
        </div>

        <div style={{ order: layout.swap ? 0 : 1 }}>
          <section className="wpanel" style={{ order: oR("alerts") }}>
            <h3>Needs attention <span className="meta">{active.length ? `${active.length} active` : ""}</span></h3>
            <div className="pbody alist">
              {active.length === 0 && <div className="arow"><span className="dot up" style={{ marginTop: 5 }} /><span>All clear — nothing needs attention.</span></div>}
              {heldBack > 0 && <div className="sub">{heldBack} alert{heldBack === 1 ? " is" : "s are"} being held back by maintenance.</div>}
              {active.slice(0, alertRows).map((a) => (
                <div key={a.id} className={`arow ${a.severity}`} onClick={() => L.go("alerts")} style={{ cursor: "pointer" }}>
                  <span className={`dot ${a.severity}`} style={{ marginTop: 5 }} />
                  <div style={{ minWidth: 0 }}>
                    <div className="t">{a.title}</div>
                    <div className="sub">{a.instanceId}{a.detail ? ` · ${a.detail}` : ""}</div>
                  </div>
                  <span className="when sub">{ago(a.since * 1000, now)}</span>
                </div>
              ))}
              {active.length > alertRows && <div className="sub" style={{ cursor: "pointer" }} onClick={() => L.go("alerts")}>+{active.length - alertRows} more — open Alerts</div>}
            </div>
          </section>

          <section className="wpanel" style={{ order: oR("devices") }}>
            <h3>Devices</h3>
            <div className="pbody devices">
              {L.instances.map((i) => (
                <div key={i.instanceId} className="drow" onClick={() => L.go("instances")} title={i.error ?? undefined}>
                  <span className={`dot ${i.status}`} />
                  <b>{i.instanceId}</b>
                  {L.maintenanceFor(i.instanceId) && <span className="tag">maintenance</span>}
                  <span className="s">{summarize(i)}</span>
                </div>
              ))}
              {L.instances.length === 0 && <div className="sub">No devices yet.</div>}
            </div>
          </section>

          {recent.length > 0 && (
            <section className="wpanel" style={{ order: oR("recent") }}>
              <h3>Recent activity</h3>
              <div className="pbody alist">
                {recent.map((e) => (
                  <div key={e.id} className="arow" style={{ padding: "5px 9px" }}>
                    <span className={`dot ${e.state === "resolved" ? "up" : e.severity}`} style={{ marginTop: 5 }} />
                    <div style={{ minWidth: 0 }}><span className="t">{e.title}</span> <span className="sub">{e.state === "resolved" ? "resolved" : "raised"}</span></div>
                    <span className="when sub">{ago((e.state === "resolved" && e.resolvedTs ? e.resolvedTs : e.ts) * 1000, now)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
