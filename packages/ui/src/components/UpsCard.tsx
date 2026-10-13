import { CardShell, clamp, lowBarClass, barClass, type CardProps } from "./CardShell";
import { Spark } from "./charts";

interface UpsData {
  name: string | null;
  model: string | null;
  status: string;
  onBattery: boolean;
  lowBattery: boolean;
  loadPct: number | null;
  batteryPct: number | null;
  runtimeMin: number | null;
  inputV: number | null;
  batteryV: number | null;
  nominalW: number | null;
  tempC: number | null;
  selfTest: string | null;
  selfTestIntervalH?: number | null;
  lastSelfTest?: string | null;
  testFields?: Record<string, string>;
  lastTransfer: string | null;
  transfers: number | null;
  timeOnBattery: string | null;
}

const SELF_TEST: Record<string, string> = { OK: "Passed", BT: "Failed (battery)", NG: "Failed", NO: "None yet", IP: "In progress" };
const fmt = (n: number | null, unit = "", digits = 0) => (n === null ? "—" : `${n.toFixed(digits)}${unit}`);

export function UpsCard(props: CardProps) {
  const d = props.instance.data as UpsData | null;
  const state = !d ? "unknown" : d.lowBattery ? "bad" : d.onBattery ? "warn" : "ok";
  const watts = d && d.loadPct !== null && d.nominalW !== null ? Math.round((d.loadPct / 100) * d.nominalW) : null;

  return (
    <CardShell {...props} tag={d?.model ?? "UPS (apcupsd)"} historyPrefer={["load"]}>
      {d && (
        <div className="grid">
          <div className="stat">
            <div className="label"><span className={`dot ${state === "ok" ? "connected" : state === "warn" ? "degraded" : "disconnected"}`} />Status</div>
            <div className="value">{d.onBattery ? "On battery" : d.status.startsWith("ONLINE") ? "Online" : d.status}</div>
            <div className="sub">{d.name ?? "UPS"} · {d.status}</div>
          </div>
          <div className="stat">
            <div className="label">Battery</div>
            <div className="value">{fmt(d.batteryPct, "%", 0)}</div>
            <div className="bar"><i className={lowBarClass((d.batteryPct ?? 100) / 100)} style={{ width: clamp(d.batteryPct ?? 0) }} /></div>
            <div className="sub" style={{ marginTop: 6 }}>{fmt(d.batteryV, " V", 1)}</div>
          </div>
          <div className="stat">
            <div className="label">Load</div>
            <div className="value">{fmt(d.loadPct, "%", 0)}</div>
            <div className="bar"><i className={barClass((d.loadPct ?? 0) / 100)} style={{ width: clamp(d.loadPct ?? 0) }} /></div>
            <Spark instanceId={props.instance.instanceId} metric="load" unit="%" />
            <div className="sub" style={{ marginTop: 6 }}>{watts !== null ? `≈ ${watts} W of ${d.nominalW} W` : ""}</div>
          </div>
          <div className="stat">
            <div className="label">Runtime remaining</div>
            <div className="value">{fmt(d.runtimeMin, " min", 0)}</div>
            <div className="sub">Input {fmt(d.inputV, " V", 0)}{d.tempC !== null ? ` · ${d.tempC.toFixed(0)}°C` : ""}</div>
          </div>
          <div className="stat">
            <div className="label">Last self-test</div>
            <div className="value">{d.selfTest ? SELF_TEST[d.selfTest] ?? d.selfTest : "—"}</div>
            <div className="sub" title={d.testFields ? Object.entries(d.testFields).map(([k, v]) => `${k}: ${v}`).join("\n") : undefined}>
              {d.lastSelfTest ? `${d.lastSelfTest}` : "date not reported by apcupsd"}{d.selfTestIntervalH ? ` · runs every ${d.selfTestIntervalH >= 48 ? `${Math.round(d.selfTestIntervalH / 24)} days` : `${d.selfTestIntervalH} h`}` : ""}
            </div>
            <div className="sub">{d.transfers ?? 0} transfers{d.lastTransfer ? ` · last: ${d.lastTransfer}` : ""}</div>
          </div>
        </div>
      )}
    </CardShell>
  );
}
