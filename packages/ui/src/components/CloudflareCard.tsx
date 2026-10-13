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
interface CfData { tunnels: TunnelData[]; dnsManaged: boolean }

const dotFor = (s: string) => (s === "healthy" ? "connected" : s === "degraded" ? "degraded" : s === "inactive" ? "unknown" : "disconnected");

export function CloudflareCard(props: CardProps) {
  const { instance } = props;
  const { notify, can } = useLumina();
  const d = instance.data as CfData | null;
  const [pending, setPending] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { hostname: string; service: string }>>({});

  async function run(action: string, input: Record<string, string>, label: string) {
    setPending(`${action}:${input.tunnelId}:${input.hostname}`);
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
    </CardShell>
  );
}
