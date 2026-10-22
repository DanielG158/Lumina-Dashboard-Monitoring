import { useSyncExternalStore } from "react";
import { getSpeedUnit, setSpeedUnit, subscribeSpeedUnit, type SpeedUnit } from "../format";

export const useSpeedUnit = (): SpeedUnit => useSyncExternalStore(subscribeSpeedUnit, getSpeedUnit);

/** Switches every network speed on screen between bits per second (Mbit/s) and bytes per second (MB/s). Remembered in this browser. */
export function UnitToggle() {
  const unit = useSpeedUnit();
  return (
    <div className="seg" role="group" aria-label="Speed units" title="Show speeds in megabits per second (how links and internet plans are sold) or megabytes per second (how downloads show)">
      <button className={unit === "bits" ? "on" : ""} onClick={() => setSpeedUnit("bits")}>Mbit/s</button>
      <button className={unit === "bytes" ? "on" : ""} onClick={() => setSpeedUnit("bytes")}>MB/s</button>
    </div>
  );
}
