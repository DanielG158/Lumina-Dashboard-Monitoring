import { useState } from "react";
import { api } from "../api";
import { useLumina } from "../context";
import { ago } from "../summaries";
import { mbps } from "../format";
import { UnitToggle, useSpeedUnit } from "./UnitToggle";
import { Spark } from "./charts";
import { CardShell, type CardProps } from "./CardShell";
import { Section } from "./Section";

interface Check { name: string; kind: string; target: string; ok: boolean; ms: number | null; minMs: number | null; maxMs: number | null; jitterMs: number | null; lossPct: number; recentLossPct?: number; error: string | null }
interface Speed { at: number; downMbps: number | null; upMbps: number | null; latencyMs: number | null; error: string | null }
interface NetData {
  targets: Check[]; speed: Speed | null; speedRunning: boolean; speedEnabled: boolean; icmpBlocked: boolean;
  warn: { latencyMs: number; lossPct: number; minDownMbps: number | null };
  summary: { up: number; down: number; avgMs: number | null; avgLossPct: number };
}

const metricName = (n: string) => n.replace(/[,\s]+/g, " ").trim();

export function NetCheckCard(props: CardProps) {
  const d = props.instance.data as NetData | null;
  const { can, notify } = useLumina();
  const [busy, setBusy] = useState(false);
  useSpeedUnit();
  const sid = (n: string) => `net:${props.instance.instanceId}:${n}`;

  async function speed() {
    setBusy(true);
    try {
      const r = (await api.action(props.instance.instanceId, "speedtest", {})) as { result?: Speed } & Partial<Speed>;
      const s = (r.result ?? r) as Speed;
      notify(s.error ? s.error : `Download ${mbps(s.downMbps)}, upload ${mbps(s.upMbps)}`, Boolean(s.error));
      void api.refresh(props.instance.instanceId).catch(() => undefined);
    } catch (e) { notify(e instanceof Error ? e.message : String(e), true); } finally { setBusy(false); }
  }

  return (
    <CardShell {...props} tag="Network checks" historyPrefer={["rtt:avg"]}>
      {d && (
        <>
          {d.icmpBlocked && (
            <div className="error">
              The Lumina service is not allowed to send pings, so ping checks fail. Run this once on the Lumina machine, then wait a minute:
              <code style={{ display: "block", userSelect: "all", marginTop: 4 }}>echo "net.ipv4.ping_group_range = 0 2147483647" | sudo tee /etc/sysctl.d/90-lumina-ping.conf && sudo sysctl --system</code>
            </div>
          )}
          {!d.icmpBlocked && d.targets.some((t) => t.kind === "ping" && !t.ok) && d.targets.some((t) => t.kind !== "ping" && t.ok) && d.targets.filter((t) => t.kind === "ping").every((t) => !t.ok) && (
            <div className="hint" style={{ marginBottom: 8 }}>
              Every ping fails but the TCP, DNS or web checks work, so this network most likely drops pings (ICMP), often on purpose. The devices are probably fine. Use a TCP check on a port the device answers on (for example <code>192.168.1.1:443</code>) instead of a ping.
            </div>
          )}
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            <div className="stat"><div className="label">Checks up</div><div className="value">{d.summary.up}/{d.targets.length}</div></div>
            <div className="stat"><div className="label">Average latency</div><div className="value">{d.summary.avgMs ?? "—"}<span className="sub"> ms</span></div><Spark instanceId={props.instance.instanceId} metric="rtt:avg" unit=" ms" /></div>
            <div className="stat"><div className="label">Average loss</div><div className="value">{d.summary.avgLossPct}<span className="sub"> %</span></div></div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th></th><th>Check</th><th>Type</th><th>Target</th><th className="num">Latency</th><th>Trend</th><th className="num">Loss</th></tr></thead>
              <tbody>
                {d.targets.map((t) => (
                  <tr key={t.name} title={t.error ?? (t.jitterMs !== null ? `min ${t.minMs} · max ${t.maxMs} · jitter ${t.jitterMs} ms` : undefined)}>
                    <td><span className={`dot ${t.ok ? (t.lossPct >= d.warn.lossPct || (t.ms ?? 0) >= d.warn.latencyMs ? "degraded" : "connected") : "disconnected"}`} /></td>
                    <td>{t.name}</td>
                    <td><span className="tag">{t.kind}</span></td>
                    <td className="sub">{t.target}</td>
                    <td className="num">{t.ok ? `${t.ms ?? "—"} ms` : <span style={{ color: "var(--bad)" }}>{t.error ?? "down"}</span>}</td>
                    <td style={{ width: 110 }}><Spark instanceId={props.instance.instanceId} metric={`rtt:${metricName(t.name)}`} unit=" ms" /></td>
                    <td className="num">{t.lossPct}%<span className="sub"> · {t.recentLossPct ?? t.lossPct}% recent</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(d.speedEnabled || d.speed) && (
            <Section id={sid("speed")} title="Internet speed" meta={d.speed ? `${mbps(d.speed.downMbps)} ↓ · ${mbps(d.speed.upMbps)} ↑ · ${ago(d.speed.at)}` : d.speedRunning ? "testing…" : "no test yet"}>
              <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))" }}>
                <div className="stat"><div className="label">Download</div><div className="value" style={{ fontSize: 22 }}>{mbps(d.speed?.downMbps)}</div><Spark instanceId={props.instance.instanceId} metric="speed:down" range="7d" unit=" Mbit/s" /></div>
                <div className="stat"><div className="label">Upload</div><div className="value" style={{ fontSize: 22 }}>{mbps(d.speed?.upMbps)}</div><Spark instanceId={props.instance.instanceId} metric="speed:up" range="7d" unit=" Mbit/s" /></div>
                <div className="stat"><div className="label">Response</div><div className="value">{d.speed?.latencyMs ?? "—"}<span className="sub"> ms</span></div></div>
              </div>
              {d.speed?.error && <div className="error">{d.speed.error}</div>}
              {can.operate && d.speedEnabled && <div><button className="btn sm" disabled={busy || d.speedRunning} onClick={() => void speed()}>{busy || d.speedRunning ? "Testing…" : "Run speed test now"}</button></div>}
              <div style={{ display: "flex", justifyContent: "flex-end" }}><UnitToggle /></div>
              <div className="hint">Each test downloads and uploads test data, which uses your internet connection. Charts show the last 7 days.</div>
            </Section>
          )}
        </>
      )}
    </CardShell>
  );
}
