import { useEffect, useMemo, useRef, useState } from "react";

export type CheckKind = "ping" | "tcp" | "dns" | "http";
export interface Row { id: number; name: string; kind: CheckKind; host: string; port: string; server: string }
interface Live { name: string; ok: boolean; ms: number | null; lossPct: number; error: string | null }

const KINDS: [CheckKind, string, string][] = [
  ["ping", "Ping", "Is it reachable, how fast, and how many packets are lost"],
  ["tcp", "TCP port", "Does a service answer on this port (a web server, SSH, a database)"],
  ["dns", "DNS lookup", "Can this name be resolved (optionally by a specific DNS server)"],
  ["http", "Web page", "Does this address return a page (not an error)"],
];
const PRESETS: { label: string; row: Omit<Row, "id"> }[] = [
  { label: "Internet (Cloudflare 1.1.1.1)", row: { name: "Internet", kind: "ping", host: "1.1.1.1", port: "", server: "" } },
  { label: "Internet (Google 8.8.8.8)", row: { name: "Internet (Google)", kind: "ping", host: "8.8.8.8", port: "", server: "" } },
  { label: "Internet reachable on a port (1.1.1.1:443)", row: { name: "Internet (port 443)", kind: "tcp", host: "1.1.1.1", port: "443", server: "" } },
  { label: "DNS lookup (public DNS)", row: { name: "DNS (public)", kind: "dns", host: "example.com", port: "", server: "1.1.1.1" } },
  { label: "Gateway / router (ping)", row: { name: "Gateway", kind: "ping", host: "", port: "", server: "" } },
  { label: "Web page", row: { name: "Website", kind: "http", host: "https://", port: "", server: "" } },
];

const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const isHost = (h: string) => IPV4.test(h) ? h.split(".").every((n) => Number(n) <= 255) : /^[0-9a-fA-F:]+$/.test(h) && h.includes(":") ? true : HOST.test(h);
const isIp = (h: string) => (IPV4.test(h) && h.split(".").every((n) => Number(n) <= 255)) || (/^[0-9a-fA-F:]+$/.test(h) && h.includes(":"));

let nextId = 1;
const blank = (): Row => ({ id: nextId++, name: "", kind: "ping", host: "", port: "", server: "" });

/** The text the server stores: one check per line, "Name | type | address". */
export function serialize(rows: Row[]): string {
  return rows.filter((r) => r.name.trim() || r.host.trim()).map((r) => {
    const target = r.kind === "tcp" ? `${r.host.includes(":") && !r.host.startsWith("[") ? `[${r.host.trim()}]` : r.host.trim()}:${r.port.trim()}` : r.kind === "dns" ? `${r.host.trim()}${r.server.trim() ? ` @${r.server.trim()}` : ""}` : r.host.trim();
    return `${r.name.trim()} | ${r.kind} | ${target}`;
  }).join("\n");
}

export function parseRows(text: string): Row[] {
  const out: Row[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [name = "", kindRaw = "ping", ...rest] = line.split("|").map((x) => x.trim());
    const target = rest.join("|").trim();
    const kind = (["ping", "tcp", "dns", "http"].includes(kindRaw.toLowerCase()) ? kindRaw.toLowerCase() : "ping") as CheckKind;
    const row: Row = { id: nextId++, name, kind, host: target, port: "", server: "" };
    if (kind === "tcp") { const m = /^(\[[^\]]+\]|.+):(\d+)$/.exec(target); if (m) { row.host = m[1].replace(/^\[|\]$/g, ""); row.port = m[2]; } }
    if (kind === "dns") { const m = /^(\S+)(?:\s+@(\S+))?$/.exec(target); if (m) { row.host = m[1]; row.server = m[2] ?? ""; } }
    out.push(row);
  }
  return out;
}

export function validateRow(r: Row, all: Row[]): string | null {
  if (!r.name.trim() && !r.host.trim()) return null; // an empty row is simply ignored
  if (!r.name.trim()) return "Give it a name";
  if (r.name.trim().length > 60) return "The name is too long";
  if (all.filter((x) => x.name.trim().toLowerCase() === r.name.trim().toLowerCase()).length > 1) return "Two checks have the same name";
  if (!r.host.trim()) return r.kind === "http" ? "Enter the web address" : r.kind === "dns" ? "Enter the name to look up" : "Enter an address";
  if (r.kind === "ping" && !isHost(r.host.trim())) return "That is not a host name or IP address";
  if (r.kind === "tcp") {
    if (!isHost(r.host.trim())) return "That is not a host name or IP address";
    const p = Number(r.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return "The port must be 1 to 65535";
  }
  if (r.kind === "dns") {
    if (!HOST.test(r.host.trim())) return "Enter a name such as example.com";
    if (r.server.trim() && !isIp(r.server.trim())) return "The DNS server must be an IP address";
  }
  if (r.kind === "http") { try { const u = new URL(r.host.trim()); if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(); } catch { return "Start with http:// or https://"; } }
  return null;
}

/** A form for the list of network checks, in place of typing one line per check. */
export function ChecksEditor({ value, onChange, live }: { value: string; onChange: (text: string, errors: string[]) => void; live?: Live[] }) {
  const [rows, setRows] = useState<Row[]>(() => { const r = parseRows(value); return r.length ? r : [blank()]; });
  const first = useRef(true);
  const errors = useMemo(() => rows.map((r) => validateRow(r, rows)), [rows]);
  const count = rows.filter((r) => r.name.trim() || r.host.trim()).length;

  useEffect(() => {
    if (first.current) { first.current = false; onChange(serialize(rows), errors.filter((e): e is string => Boolean(e))); return; }
    onChange(serialize(rows), errors.filter((e): e is string => Boolean(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const set = (id: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) => setRows((rs) => { const j = i + d; if (j < 0 || j >= rs.length) return rs; const c = [...rs]; [c[i], c[j]] = [c[j], c[i]]; return c; });
  const state = (name: string) => live?.find((l) => l.name === name.trim());

  return (
    <div className="stack" style={{ gap: 8 }}>
      {rows.map((r, i) => {
        const e = errors[i];
        const l = state(r.name);
        return (
          <div key={r.id} className="subpanel" style={{ padding: 8 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
              {live && <span className={`dot ${l ? (l.ok ? "connected" : "disconnected") : "pending"}`} style={{ marginTop: 11 }} title={l ? (l.ok ? `answers in ${l.ms} ms` : l.error ?? "not answering") : "not checked yet"} />}
              <input className="field" style={{ width: 170 }} placeholder="Name (e.g. Gateway)" aria-label="Check name" value={r.name} onChange={(ev) => set(r.id, { name: ev.target.value })} />
              <select className="field" aria-label="Check type" value={r.kind} onChange={(ev) => set(r.id, { kind: ev.target.value as CheckKind, port: ev.target.value === "tcp" ? r.port || "443" : "" })} title={KINDS.find((k) => k[0] === r.kind)?.[2]}>
                {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input className="field" style={{ minWidth: 190, flex: 1 }} aria-label={r.kind === "http" ? "Web address" : r.kind === "dns" ? "Name to look up" : "Address"}
                placeholder={r.kind === "http" ? "https://example.com" : r.kind === "dns" ? "example.com" : "192.168.1.1 or host name"} value={r.host} onChange={(ev) => set(r.id, { host: ev.target.value })} />
              {r.kind === "tcp" && <input className="field" style={{ width: 90 }} inputMode="numeric" placeholder="Port" aria-label="Port" value={r.port} onChange={(ev) => set(r.id, { port: ev.target.value.replace(/\D/g, "") })} />}
              {r.kind === "dns" && <input className="field" style={{ width: 170 }} placeholder="DNS server (optional)" aria-label="DNS server" value={r.server} onChange={(ev) => set(r.id, { server: ev.target.value })} />}
              <div className="actions">
                <button type="button" className="btn sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="btn sm" aria-label="Move down" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button type="button" className="btn sm danger" aria-label="Remove this check" onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.id !== r.id) : [blank()]))}>Remove</button>
              </div>
            </div>
            {e && <div className="hint" style={{ color: "var(--bad)", marginTop: 4 }}>{e}</div>}
          </div>
        );
      })}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn sm" onClick={() => setRows((rs) => [...rs, blank()])}>+ Add a check</button>
        <select className="field" aria-label="Add a common check" value="" onChange={(ev) => { const p = PRESETS[Number(ev.target.value)]; if (p) setRows((rs) => [...rs.filter((x) => x.name.trim() || x.host.trim()), { id: nextId++, ...p.row }]); }}>
          <option value="">+ Add a common check…</option>
          {PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
        </select>
        <span className="sub">{count} check{count === 1 ? "" : "s"}</span>
      </div>
    </div>
  );
}
