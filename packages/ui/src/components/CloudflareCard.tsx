import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useLumina } from "../context";
import { CardShell, type CardProps } from "./CardShell";

interface TunnelData {
  id: string;
  name: string;
  status: string;
  remoteManaged: boolean;
  connections: number;
  colos: string[];
  ingress: { hostname: string | null; service: string; path: string | null }[];
}
interface HostRow {
  name: string;
  source: "tunnel" | "dns" | "extra";
  pending?: boolean;
  dns?: { ok: boolean; error?: string };
  https?: { ok: boolean; status?: number; ms?: number; error?: string };
  cert?: { daysLeft: number; trusted: boolean } | null;
}
interface RecordRow { id: string; type: string; name: string; content: string; proxied: boolean; ttl: number; tunnel: boolean }
interface DayRow { date: string; requests: number; bytes: number; cachedRequests: number; cachedBytes: number; threats: number }
interface CfData {
  tunnels: (TunnelData & { churn?: number; pendingReconnect?: number })[];
  dnsManaged: boolean;
  zone?: { id: string; name: string | null } | null;
  records?: RecordRow[] | null;
  hostnames?: HostRow[];
  analytics?: DayRow[] | null;
  access?: { entries: { at: number; email: string; app: string; allowed: boolean; ip: string }[]; denied1h: number } | null;
  ddns?: { ip: string | null; hosts: { name: string; status: string; detail: string }[] } | null;
  notes?: Record<string, string>;
}

const NEEDS: Record<string, string> = {
  records: "Add Zone, DNS, Read (or Edit) to the API token to see the DNS records.",
  analytics: "Add Zone, Analytics, Read to the API token to see traffic.",
  access: "Add Account, Access: Audit Logs, Read to the API token (and switch on Zero Trust) to see Access logins.",
  ddns: "Dynamic DNS could not read this network's public IP.",
};
const big = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.round(b / 1e3)} kB`);

const dotFor = (s: string) => (s === "healthy" ? "connected" : s === "degraded" ? "degraded" : s === "inactive" ? "unknown" : "disconnected");

export function CloudflareCard(props: CardProps) {
  const { instance } = props;
  const { notify, can } = useLumina();
  const d = instance.data as CfData | null;
  const [pending, setPending] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { hostname: string; service: string }>>({});
  const [rec, setRec] = useState({ type: "A", name: "", content: "", proxied: false });

  async function run(action: string, input: Record<string, string | boolean>, label: string) {
    setPending(`${action}:${input.tunnelId ?? input.id ?? ""}:${input.hostname ?? ""}`);
    try {
      const res = (await api.action(instance.instanceId, action, input)) as { result?: { dns?: string } };
      notify(res.result?.dns ? `${label} — ${res.result.dns}` : label);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setPending(null);
    }
  }

  async function add(e: FormEvent, t: TunnelData) {
    e.preventDefault();
    const v = draft[t.id];
    if (!v?.hostname || !v?.service) return;
    await run("add-endpoint", { tunnelId: t.id, hostname: v.hostname, service: v.service }, `Added ${v.hostname}`);
    setDraft((p) => ({ ...p, [t.id]: { hostname: "", service: "" } }));
  }

  async function addRecord(e: FormEvent) {
    e.preventDefault();
    if (!rec.name.trim() || !rec.content.trim()) return;
    await run("dns-add", { type: rec.type, name: rec.name.trim(), content: rec.content.trim(), proxied: rec.type === "TXT" ? false : rec.proxied }, `Added ${rec.name.trim()}`);
    setRec({ type: rec.type, name: "", content: "", proxied: false });
  }

  const notes = d?.notes ?? {};
  const hosts = d?.hostnames ?? [];
  const days = d?.analytics ?? [];
  const week = days.reduce((a, x) => ({ requests: a.requests + x.requests, bytes: a.bytes + x.bytes, cached: a.cached + x.cachedRequests, threats: a.threats + x.threats }), { requests: 0, bytes: 0, cached: 0, threats: 0 });
  const peak = Math.max(1, ...days.map((x) => x.requests));
  const hostState = (h: HostRow) => (h.pending ? "unknown" : !h.dns?.ok || !h.https?.ok ? "disconnected" : (h.https.status ?? 0) >= 500 ? "degraded" : "connected");

  return (
    <CardShell {...props} tag="Cloudflare Tunnels">
      {d?.tunnels.length === 0 && <div className="empty">No tunnels found in this account.</div>}
      {d?.tunnels.map((t) => (
        <div className="subpanel" key={t.id}>
          <div className="panel-head">
            <h2 style={{ fontSize: 15 }}>
              <span className={`dot ${dotFor(t.status)}`} />
              {t.name}
              <span className="tag">{t.status}</span>
              {(t.churn ?? 0) >= 3 && <span className="tag warn">keeps reconnecting</span>}
            </h2>
            <span className="meta">
              {t.connections} connection{t.connections === 1 ? "" : "s"}
              {t.colos.length ? ` · ${t.colos.join(", ")}` : ""}
            </span>
          </div>

          {!t.remoteManaged ? (
            <div className="sub">Locally-managed tunnel (config file) — hostnames can't be edited from the API.</div>
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Public hostname</th><th>Service</th>{can.admin && <th className="num">Actions</th>}</tr></thead>
                  <tbody>
                    {t.ingress.filter((r) => r.hostname).map((r) => (
                      <tr key={`${r.hostname}${r.path ?? ""}`}>
                        <td>{r.hostname}{r.path ? <span className="sub">{r.path}</span> : null}</td>
                        <td className="sub">{r.service}</td>
                        {can.admin && <td>
                          <div className="actions">
                            <button
                              className="btn sm"
                              disabled={!!pending}
                              onClick={() => {
                                const service = prompt(`New service for ${r.hostname}`, r.service);
                                if (service && service !== r.service)
                                  void run("edit-endpoint", { tunnelId: t.id, hostname: r.hostname!, service }, `Updated ${r.hostname}`);
                              }}
                            >Edit</button>
                            <button
                              className="btn sm danger"
                              disabled={!!pending}
                              onClick={() => {
                                if (confirm(`Remove ${r.hostname} from ${t.name}?${d.dnsManaged ? " Its DNS record will be deleted too." : ""}`))
                                  void run("remove-endpoint", { tunnelId: t.id, hostname: r.hostname! }, `Removed ${r.hostname}`);
                              }}
                            >Remove</button>
                          </div>
                        </td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {can.admin && <form className="inline-add" onSubmit={(e) => void add(e, t)}>
                <input
                  placeholder="app.example.com"
                  value={draft[t.id]?.hostname ?? ""}
                  onChange={(e) => setDraft((p) => ({ ...p, [t.id]: { service: p[t.id]?.service ?? "", hostname: e.target.value } }))}
                />
                <input
                  placeholder="http://192.168.11.x:8080"
                  value={draft[t.id]?.service ?? ""}
                  onChange={(e) => setDraft((p) => ({ ...p, [t.id]: { hostname: p[t.id]?.hostname ?? "", service: e.target.value } }))}
                />
                <button className="btn sm primary" disabled={!!pending}>Add hostname</button>
              </form>}
            </>
          )}
        </div>
      ))}

      {hosts.length > 0 && (
        <div className="subpanel">
          <div className="panel-head"><h2 style={{ fontSize: 15 }}>Public hostnames</h2><span className="meta">{hosts.filter((h) => hostState(h) === "connected").length}/{hosts.length} answering · checked every 5 min</span></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Hostname</th><th>DNS</th><th>HTTPS</th><th className="num">Speed</th><th className="num">Certificate</th></tr></thead>
              <tbody>
                {hosts.map((h) => (
                  <tr key={h.name}>
                    <td><span className={`dot ${hostState(h)}`} />{h.name}<span className="sub">{h.source === "extra" ? "added by you" : h.source === "tunnel" ? "tunnel" : "proxied record"}</span></td>
                    <td>{h.pending ? "…" : h.dns?.ok ? "ok" : h.dns?.error ?? "failed"}</td>
                    <td>{h.pending ? "checking…" : h.https?.ok ? `HTTP ${h.https.status}` : h.https?.error ?? "failed"}</td>
                    <td className="num">{h.https?.ms != null ? `${h.https.ms} ms` : ""}</td>
                    <td className="num">{h.cert ? <span className={h.cert.daysLeft <= 3 ? "bad" : h.cert.daysLeft <= 14 ? "warn" : ""}>{h.cert.daysLeft < 0 ? "expired" : `${h.cert.daysLeft} days`}</span> : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {days.length > 0 && (
        <div className="subpanel">
          <div className="panel-head"><h2 style={{ fontSize: 15 }}>Traffic, last {days.length} days{d?.zone?.name ? ` · ${d.zone.name}` : ""}</h2></div>
          <div className="cf-stats">
            <span>{big(week.requests)} requests</span>
            <span>{size(week.bytes)} sent</span>
            <span>{week.requests ? Math.round((week.cached / week.requests) * 100) : 0}% cached</span>
            <span className={week.threats ? "warn" : ""}>{week.threats} threats blocked</span>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 56, marginTop: 8 }} aria-label="Requests per day">
            {days.map((x) => <div key={x.date} title={`${x.date}: ${x.requests} requests`} style={{ flex: 1, minWidth: 6, height: `${Math.max(4, (x.requests / peak) * 100)}%`, background: "var(--accent)", borderRadius: 3, opacity: 0.85 }} />)}
          </div>
        </div>
      )}

      {d?.ddns && (
        <div className="subpanel">
          <div className="panel-head"><h2 style={{ fontSize: 15 }}>Dynamic DNS</h2><span className="meta">{d.ddns.ip ? `public IP ${d.ddns.ip}` : "public IP unknown"}</span></div>
          {d.ddns.hosts.map((h) => (
            <div key={h.name} className="sub"><span className={`dot ${h.status === "ok" || h.status === "updated" ? "connected" : "degraded"}`} />{h.name} · {h.status === "updated" ? "updated just now" : h.status === "ok" ? "up to date" : h.detail}</div>
          ))}
        </div>
      )}

      {d?.zone && d.records && (
        <div className="subpanel">
          <div className="panel-head"><h2 style={{ fontSize: 15 }}>DNS records</h2><span className="meta">{d.records.length} in {d.zone.name ?? "the zone"}</span></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Type</th><th>Name</th><th>Content</th><th>Proxy</th>{can.admin && <th className="num">Actions</th>}</tr></thead>
              <tbody>
                {d.records.map((r) => (
                  <tr key={r.id}>
                    <td>{r.type}</td>
                    <td>{r.name}</td>
                    <td className="sub">{r.content || "hidden"}</td>
                    <td>{r.type === "TXT" || r.type === "MX" ? "" : r.proxied ? "on" : "off"}</td>
                    {can.admin && <td><div className="actions">
                      <button className="btn sm" disabled={!!pending} onClick={() => {
                        const content = prompt(`New content for ${r.name} (${r.type})`, r.content);
                        if (content && content !== r.content) void run("dns-edit", { id: r.id, content }, `Updated ${r.name}`);
                      }}>Edit</button>
                      {(r.type === "A" || r.type === "AAAA" || r.type === "CNAME") && <button className="btn sm" disabled={!!pending} onClick={() => void run("dns-edit", { id: r.id, proxied: !r.proxied }, `${r.name}: proxy ${r.proxied ? "off" : "on"}`)}>{r.proxied ? "Proxy off" : "Proxy on"}</button>}
                      <button className="btn sm danger" disabled={!!pending} onClick={() => { if (confirm(`Delete the ${r.type} record ${r.name}?${r.tunnel ? " It points at a tunnel, so that hostname will stop working." : ""}`)) void run("dns-remove", { id: r.id }, `Deleted ${r.name}`); }}>Delete</button>
                    </div></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {can.admin && <form className="inline-add" style={{ gridTemplateColumns: "auto 1fr 1.4fr auto auto" }} onSubmit={(e) => void addRecord(e)}>
            <select value={rec.type} onChange={(e) => setRec({ ...rec, type: e.target.value })}>{["A", "AAAA", "CNAME", "TXT"].map((t) => <option key={t}>{t}</option>)}</select>
            <input placeholder="name.example.com" value={rec.name} onChange={(e) => setRec({ ...rec, name: e.target.value })} />
            <input placeholder={rec.type === "A" ? "203.0.113.10" : rec.type === "CNAME" ? "target.example.com" : "content"} value={rec.content} onChange={(e) => setRec({ ...rec, content: e.target.value })} />
            <label className="sub" style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" disabled={rec.type === "TXT"} checked={rec.proxied && rec.type !== "TXT"} onChange={(e) => setRec({ ...rec, proxied: e.target.checked })} />proxy</label>
            <button className="btn sm primary" disabled={!!pending}>Add record</button>
          </form>}
        </div>
      )}

      {d?.access && (
        <div className="subpanel">
          <div className="panel-head"><h2 style={{ fontSize: 15 }}>Access logins</h2><span className={`meta ${d.access.denied1h ? "warn" : ""}`}>{d.access.denied1h} refused in the last hour</span></div>
          {d.access.entries.length === 0 ? <div className="sub">Signed-in details are shown to admins only.</div> : (
            <div className="table-wrap"><table>
              <thead><tr><th>When</th><th>Who</th><th>Application</th><th>Result</th><th>From</th></tr></thead>
              <tbody>{d.access.entries.slice(0, 10).map((e, i) => (
                <tr key={i}><td>{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td><td>{e.email}</td><td className="sub">{e.app}</td><td className={e.allowed ? "" : "bad"}>{e.allowed ? "allowed" : "refused"}</td><td className="sub">{e.ip}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      )}

      {Object.entries(notes).filter(([k]) => NEEDS[k]).map(([k, v]) => <div key={k} className="sub" title={v}>{NEEDS[k]}</div>)}
    </CardShell>
  );
}
