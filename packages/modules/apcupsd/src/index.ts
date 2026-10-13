import { z } from "zod";
import { createConnection } from "node:net";
import { defineModule, type AlertCondition } from "@lumina/sdk";

const ConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(3551),
});
type Config = z.infer<typeof ConfigSchema>;

// apcupsd NIS: 2-byte big-endian length + payload, reply is a stream of the same records ending with length 0.
function nisStatus(host: string, port: number, timeoutMs = 5000): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host, port });
    const lines: string[] = [];
    let buf = Buffer.alloc(0);
    let done = false;

    sock.setTimeout(timeoutMs, () => sock.destroy(new Error(`apcupsd ${host}:${port} timed out`)));
    sock.on("connect", () => {
      const cmd = Buffer.from("status");
      const header = Buffer.alloc(2);
      header.writeUInt16BE(cmd.length);
      sock.write(Buffer.concat([header, cmd]));
    });
    sock.on("data", (chunk) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const len = buf.readUInt16BE(0);
        if (len === 0) {
          done = true;
          sock.end();
          return;
        }
        if (buf.length < 2 + len) break;
        lines.push(buf.subarray(2, 2 + len).toString("utf8"));
        buf = buf.subarray(2 + len);
      }
    });
    sock.on("error", reject);
    sock.on("close", () => {
      if (!done) return reject(new Error("apcupsd closed the connection before sending the full status"));
      const out: Record<string, string> = {};
      for (const line of lines) {
        const i = line.indexOf(":");
        if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      resolve(out);
    });
  });
}

const num = (v: string | undefined) => {
  const n = v === undefined ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

export default defineModule<Config>({
  id: "apcupsd",
  name: "UPS (apcupsd)",
  description: "APC UPS via the apcupsd network information server (port 3551). Read-only.",
  fields: [
    { key: "host", label: "apcupsd host", type: "text", required: true, placeholder: "192.168.11.x" },
    { key: "port", label: "Port", type: "number", default: 3551 },
  ],
  configSchema: ConfigSchema,
  pollIntervalMs: 10_000,
  minPollIntervalMs: 2_000,
  multiInstance: true,

  async create(config) {
    let healthy = false;
    return {
      async poll() {
        let raw: Record<string, string>;
        try {
          raw = await nisStatus(config.host, config.port);
        } catch (err) {
          healthy = false;
          throw err;
        }
        healthy = true;
        const status = raw.STATUS ?? "UNKNOWN";
        return {
          name: raw.UPSNAME ?? null,
          model: raw.MODEL ?? null,
          status,
          onBattery: /ONBATT/.test(status),
          lowBattery: /LOWBATT/.test(status),
          loadPct: num(raw.LOADPCT),
          batteryPct: num(raw.BCHARGE),
          runtimeMin: num(raw.TIMELEFT),
          inputV: num(raw.LINEV),
          batteryV: num(raw.BATTV),
          nominalW: num(raw.NOMPOWER),
          tempC: num(raw.ITEMP),
          selfTest: raw.SELFTEST ?? null,
          selfTestIntervalH: num(raw.STESTI),
          lastSelfTest: raw.LASTSTEST ?? null,
          testFields: Object.fromEntries(Object.entries(raw).filter(([k]) => /TEST/.test(k))),
          lastTransfer: raw.LASTXFER ?? null,
          transfers: num(raw.NUMXFERS),
          timeOnBattery: raw.TONBATT ?? null,
          battDate: raw.BATTDATE ?? null,
        };
      },
      async status() {
        return healthy ? "connected" : "disconnected";
      },
      alerts(d: any) {
        const out: AlertCondition[] = [];
        const left = d.runtimeMin !== null ? `, ${Math.round(d.runtimeMin)} min remaining` : "";
        if (/COMMLOST/.test(d.status)) out.push({ key: "comm-lost", severity: "critical", title: "UPS communication lost", detail: "apcupsd can no longer talk to the UPS" });
        if (/REPLACEBATT/.test(d.status)) out.push({ key: "replace-battery", severity: "warning", title: "UPS battery needs replacing" });
        if (d.lowBattery) out.push({ key: "low-battery", severity: "critical", title: "UPS battery is low", detail: `${d.batteryPct ?? "?"}% charge${left}` });
        else if (d.onBattery) out.push({ key: "on-battery", severity: "warning", title: "UPS is running on battery", detail: `${d.batteryPct ?? "?"}% charge${left}` });
        if (d.loadPct !== null && d.loadPct >= 85) out.push({ key: "high-load", severity: "warning", title: "UPS load is high", detail: `${d.loadPct}% of capacity` });
        if (d.selfTest === "BT" || d.selfTest === "NG") out.push({ key: "self-test-failed", severity: "warning", title: "UPS self-test failed", detail: d.selfTest === "BT" ? "Battery test failed" : "Self-test failed" });
        return out;
      },
      metrics(d: any) {
        const m: Record<string, number> = {};
        if (d.loadPct !== null) m.load = d.loadPct;
        if (d.batteryPct !== null) m.battery = d.batteryPct;
        if (d.runtimeMin !== null) m.runtime = d.runtimeMin;
        if (d.inputV !== null) m.inputV = d.inputV;
        if (d.loadPct !== null && d.nominalW !== null) m.watts = (d.loadPct / 100) * d.nominalW;
        return m;
      },
      actions: [],
    };
  },
});
