import { useEffect, useState, type FormEvent } from "react";
import { api, type AppSettings, type Channel, type ChannelType, type ServerInfo, type UserInfo } from "../api";
import { readJsonFile, waitForServer } from "../components/AuthDialogs";
import { useLumina } from "../context";

type Section = "general" | "server" | "notifications" | "users" | "tokens" | "backup" | "account";
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return <label className="stack" style={{ gap: 4 }}><span>{label}</span>{children}{help && <span className="hint">{help}</span>}</label>;
}

function General() {
  const { notify, reloadAuth } = useLumina();
  const [s, setS] = useState<AppSettings | null>(null);
  useEffect(() => { api.settings().then(setS).catch((e) => notify(err(e), true)); }, [notify]);
  if (!s) return <div className="empty">Loading…</div>;
  const num = (k: "sessionIdleMinutes" | "alertConfirmPolls" | "metricsRetentionDays" | "forecastWarnDays" | "eventRetentionDays") => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) });
  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api.saveSettings({ sessionIdleMinutes: s!.sessionIdleMinutes, alertConfirmPolls: s!.alertConfirmPolls, metricsRetentionDays: s!.metricsRetentionDays, forecastWarnDays: s!.forecastWarnDays, eventRetentionDays: s!.eventRetentionDays, siteName: s!.siteName ?? "", publicView: s!.publicView });
      notify("Settings saved");
      await reloadAuth();
    } catch (x) { notify(err(x), true); }
  }
  return (
    <form className="stack" onSubmit={save} style={{ maxWidth: 560 }}>
      <Field label="Public viewing" help="On: anyone who can reach this page can look at the dashboard without signing in (they can't change anything). Turn off to require a sign-in for everything — recommended if Lumina is reachable from the internet.">
        <label className="row"><input type="checkbox" checked={s.publicView} onChange={(e) => setS({ ...s, publicView: e.target.checked })} /> Let anyone view the dashboard</label>
      </Field>
      <Field label="Sign-in timeout (minutes of inactivity)" help="Operators and admins are signed out after this long without activity.">
        <input className="field" type="number" min={5} max={10080} value={s.sessionIdleMinutes} onChange={num("sessionIdleMinutes")} />
      </Field>
      <Field label="Alert confirmation (polls)" help="A problem must be seen this many times in a row before an alert is raised. Higher means fewer false alarms but slower alerts.">
        <input className="field" type="number" min={1} max={10} value={s.alertConfirmPolls} onChange={num("alertConfirmPolls")} />
      </Field>
      <Field label="Keep history for (days)" help="Charts use this history. Longer uses more disk.">
        <input className="field" type="number" min={1} max={365} value={s.metricsRetentionDays} onChange={num("metricsRetentionDays")} />
      </Field>
      <Field label="Name shown next to the logo (optional)" help="For example the name of the site this Lumina watches (Office, Home). Leave it empty to show just Lumina.">
        <input className="field" maxLength={40} value={s.siteName ?? ""} placeholder="no name" onChange={(e) => setS({ ...s, siteName: e.target.value })} />
      </Field>
      <Field label="Keep alert history for (days)" help="The Alerts page keeps every alert that long, with search and filters. Alerts that are still active are never removed.">
        <input className="field" type="number" min={7} max={3650} value={s.eventRetentionDays} onChange={num("eventRetentionDays")} />
      </Field>
      <Field label="Warn when a storage volume will be full within (days)" help="Lumina predicts when each volume fills up from its recent history, and raises an alert when that is closer than this.">
        <input className="field" type="number" min={1} max={365} value={s.forecastWarnDays} onChange={num("forecastWarnDays")} />
      </Field>
      <div><button className="btn primary">Save</button></div>
    </form>
  );
}

function Server() {
  const { notify } = useLumina();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [cfg, setCfg] = useState<ServerInfo["config"] | null>(null);
  const [names, setNames] = useState("");
  const [cert, setCert] = useState("");
  const [key, setKey] = useState("");
  const [next, setNext] = useState<{ url: string } | null>(null);
  const load = () => api.server().then((i) => { setInfo(i); setCfg(i.config); setNames(i.config.names.join(", ")); }).catch((e) => notify(err(e), true));
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!info || !cfg) return <div className="empty">Loading…</div>;
  const locked = (k: string) => info.overridden.includes(k);
  const scheme = info.running.https ? "https" : "http";

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await api.saveServer({ ...cfg!, names: names.split(",").map((s) => s.trim()).filter(Boolean) });
      setNext({ url: res.url });
      notify("Saved — restart Lumina to apply");
    } catch (x) { notify(err(x), true); }
  }
  async function upload() {
    try {
      const r = await api.uploadCertificate(cert, key);
      notify(`Certificate saved (valid until ${r.certificate.validTo})`);
      setCert(""); setKey("");
      await load();
      setNext({ url: `https://${location.hostname}${cfg!.port === 443 ? "" : `:${cfg!.port}`}/` });
    } catch (x) { notify(err(x), true); }
  }
  async function restart() {
    if (!confirm("Restart Lumina now? The page will reconnect automatically.")) return;
    try { await api.restart(); notify("Restarting…"); await waitForServer(next?.url); } catch (x) { notify(err(x), true); }
  }

  return (
    <div className="stack" style={{ maxWidth: 680 }}>
      <div className="kv">
        <span className="sub">Version</span><span>{info.version}</span>
        <span className="sub">Listening</span><span>{scheme.toUpperCase()} on port {info.running.port}{info.running.redirectPort ? `, port ${info.running.redirectPort} redirects to HTTPS` : ""}</span>
        <span className="sub">Data folder</span><span><code>{info.dataDir}</code></span>
        {info.certificate && <><span className="sub">Certificate</span><span>{info.running.selfSigned ? "Self-signed" : "Custom"} · valid until {info.certificate.validTo}</span></>}
        {info.restoredFrom && <><span className="sub">Last restore</span><span className="sub">previous data kept in {info.restoredFrom}</span></>}
      </div>
      {info.running.https && info.running.selfSigned && <div className="hint">Browsers warn about self-signed certificates the first time. Choose "Advanced → continue", or upload a certificate your devices already trust.</div>}

      <form className="stack" onSubmit={save}>
        <h3 style={{ margin: 0 }}>Network</h3>
        <Field label="HTTPS" help="Automatic creates and renews a self-signed certificate for this machine's names and IPs.">
          <select className="field" disabled={locked("tls")} value={cfg.tls} onChange={(e) => setCfg({ ...cfg, tls: e.target.value as "off" | "auto" | "custom" })}>
            <option value="off">Off (plain HTTP)</option>
            <option value="auto">Automatic (self-signed)</option>
            <option value="custom">My own certificate</option>
          </select>
        </Field>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <Field label="Port" help={cfg.tls === "off" ? "80 or 3000 are typical for HTTP." : "443 is the HTTPS default."}>
            <input className="field" type="number" min={1} max={65535} disabled={locked("port")} value={cfg.port} onChange={(e) => setCfg({ ...cfg, port: Number(e.target.value) })} />
          </Field>
          <Field label="Redirect from HTTP port" help="e.g. 80 → sends http:// visitors to https://. 0 = off.">
            <input className="field" type="number" min={0} max={65535} disabled={locked("httpRedirectPort") || cfg.tls === "off"} value={cfg.httpRedirectPort} onChange={(e) => setCfg({ ...cfg, httpRedirectPort: Number(e.target.value) })} />
          </Field>
        </div>
        {cfg.tls === "auto" && (
          <Field label="Extra names for the certificate" help="Comma-separated hostnames or IPs people use to reach Lumina, e.g. lumina.home.lan">
            <input className="field" disabled={locked("names")} value={names} onChange={(e) => setNames(e.target.value)} />
          </Field>
        )}
        {cfg.tls !== "off" && (
          <label className="row"><input type="checkbox" disabled={locked("hsts")} checked={cfg.hsts} onChange={(e) => setCfg({ ...cfg, hsts: e.target.checked })} /> Send HSTS (only with a certificate browsers trust — it stops them letting you bypass certificate warnings)</label>
        )}
        {info.overridden.length > 0 && <div className="hint">Locked by environment variables on the server: {info.overridden.join(", ")}.</div>}
        <div className="row"><button className="btn primary">Save network settings</button></div>
      </form>

      <div className="stack">
        <h3 style={{ margin: 0 }}>Use my own certificate</h3>
        <div className="hint">Paste the certificate (PEM, include any intermediates) and its unencrypted private key. Saving selects "My own certificate".</div>
        <textarea className="field" rows={5} placeholder="-----BEGIN CERTIFICATE-----" value={cert} onChange={(e) => setCert(e.target.value)} />
        <textarea className="field" rows={4} placeholder="-----BEGIN PRIVATE KEY-----" value={key} onChange={(e) => setKey(e.target.value)} />
        <div><button className="btn" disabled={!cert || !key} onClick={() => void upload()}>Upload certificate</button></div>
      </div>

      {next && (
        <div className="panel">
          <b>Restart needed.</b> After restarting, Lumina will be at <a href={next.url}>{next.url}</a>.
          <div className="row" style={{ marginTop: 8 }}>
            {info.restartSupported ? <button className="btn primary" onClick={() => void restart()}>Restart now</button> : <span className="sub">Lumina can't restart itself here — restart the service from the host (e.g. <code>systemctl restart lumina</code>).</span>}
          </div>
        </div>
      )}
      {!next && info.restartSupported && <div><button className="btn" onClick={() => void restart()}>Restart Lumina</button></div>}
    </div>
  );
}

function Notifications() {
  const { notify } = useLumina();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [types, setTypes] = useState<ChannelType[]>([]);
  const [form, setForm] = useState<{ id?: number; type: string; name: string; minSeverity: string; enabled: boolean; config: Record<string, string>; secretsSet: string[] } | null>(null);
  const load = () => Promise.all([api.channels(), api.channelTypes()]).then(([c, t]) => { setChannels(c); setTypes(t); }).catch((e) => notify(err(e), true));
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const def = types.find((t) => t.id === form?.type);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    const body = { name: form.name, type: form.type, enabled: form.enabled, minSeverity: form.minSeverity, config: form.config };
    try {
      if (form.id) await api.updateChannel(form.id, body); else await api.addChannel(body);
      setForm(null);
      notify("Channel saved");
      await load();
    } catch (x) { notify(err(x), true); }
  }
  async function test(c: Channel) {
    try {
      const r = await api.testChannel(c.id);
      notify(r.ok ? `Test sent to ${c.name}` : `Test failed: ${r.error}`, !r.ok);
      await load();
    } catch (x) { notify(err(x), true); }
  }

  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="hint">When an alert is raised or resolved, Lumina sends a message to every enabled channel whose minimum severity it meets. Use <b>ntfy</b> for push notifications to an iOS or Android phone.</div>
      {channels?.length === 0 && <div className="empty">No channels yet.</div>}
      {channels?.map((c) => (
        <div key={c.id} className="subpanel row" style={{ marginTop: 0 }}>
          <span className={`dot ${c.lastError ? "down" : c.enabled ? "up" : "unknown"}`} />
          <div style={{ flex: 1, minWidth: 180 }}>
            <b>{c.name}</b> <span className="tag">{types.find((t) => t.id === c.type)?.name ?? c.type}</span> <span className="tag">{c.minSeverity}+</span>
            {!c.enabled && <span className="tag">off</span>}
            {c.lastError && <div className="error" style={{ marginTop: 2 }}>Last send failed: {c.lastError}</div>}
          </div>
          <button className="btn sm" onClick={() => void test(c)}>Send test</button>
          <button className="btn sm" onClick={() => setForm({ id: c.id, type: c.type, name: c.name, minSeverity: c.minSeverity, enabled: c.enabled, config: { ...c.config }, secretsSet: c.secretsSet })}>Edit</button>
          <button className="btn sm danger" onClick={async () => { if (confirm(`Delete channel "${c.name}"?`)) { await api.deleteChannel(c.id).catch((x) => notify(err(x), true)); await load(); } }}>Delete</button>
        </div>
      ))}
      {!form && <div><button className="btn primary" onClick={() => setForm({ type: types[0]?.id ?? "discord", name: "", minSeverity: "warning", enabled: true, config: {}, secretsSet: [] })}>+ Add channel</button></div>}
      {form && def && (
        <form className="panel stack" onSubmit={save}>
          <h3 style={{ margin: 0 }}>{form.id ? "Edit channel" : "New channel"}</h3>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <Field label="Type"><select className="field" disabled={!!form.id} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, config: {}, secretsSet: [] })}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
            <Field label="Name"><input className="field" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Send"><select className="field" value={form.minSeverity} onChange={(e) => setForm({ ...form, minSeverity: e.target.value })}><option value="info">Everything</option><option value="warning">Warnings and critical</option><option value="critical">Critical only</option></select></Field>
          </div>
          {def.fields.map((f) => (
            <Field key={f.key} label={f.label} help={f.help}>
              <input className="field" type={f.type === "password" ? "password" : "text"} autoComplete="off" required={f.required && !form.secretsSet.includes(f.key)}
                placeholder={form.secretsSet.includes(f.key) ? "unchanged — leave blank to keep" : f.placeholder}
                value={form.config[f.key] ?? ""} onChange={(e) => setForm({ ...form, config: { ...form.config, [f.key]: e.target.value } })} />
            </Field>
          ))}
          <label className="row"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</label>
          <div className="row"><button className="btn primary">Save</button><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button></div>
        </form>
      )}
    </div>
  );
}

function Tokens() {
  const { notify } = useLumina();
  const [list, setList] = useState<Awaited<ReturnType<typeof api.tokens>> | null>(null);
  const [name, setName] = useState("");
  const [detail, setDetail] = useState(false);
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const load = () => api.tokens().then(setList).catch((e) => notify(err(e), true));
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function create(e: FormEvent) {
    e.preventDefault();
    try { const t = await api.createToken(name.trim(), detail); setFresh({ name: t.name, token: t.token }); setName(""); setDetail(false); await load(); } catch (x) { notify(err(x), true); }
  }
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="hint">An access token lets <b>another Lumina</b> (say, one at a second site) read this dashboard's devices and alerts, even when public viewing is off. It is read-only and, unless it is made with <b>Full detail</b>, sees exactly what an anonymous visitor sees: no logs, serial numbers or addresses, and it cannot change anything. On the other Lumina, add an instance of type <b>Another Lumina</b> and paste the token there. Make one token per Lumina so you can revoke them separately.</div>
      {fresh && (
        <div className="panel stack" style={{ borderColor: "var(--accent)" }}>
          <b>Token for "{fresh.name}"</b>
          <code style={{ wordBreak: "break-all", userSelect: "all" }}>{fresh.token}</code>
          <div className="hint">Copy it now. It is shown only once; Lumina keeps only a fingerprint of it.</div>
          <div className="row"><button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(fresh.token).then(() => notify("Copied"), () => notify("Select the token and copy it by hand", true)); }}>Copy</button><button className="btn sm" onClick={() => setFresh(null)}>I have saved it</button></div>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th className="num">Actions</th></tr></thead>
          <tbody>
            {list?.map((t) => (
              <tr key={t.id}>
                <td>{t.name}{t.detail && <span className="tag" style={{ marginLeft: 6 }} title="Can read everything a signed-in user sees (read-only)">full detail</span>}</td>
                <td className="sub">{new Date(t.createdAt * 1000).toLocaleDateString()}{t.createdBy ? ` · ${t.createdBy}` : ""}</td>
                <td className="sub">{t.lastUsed ? new Date(t.lastUsed * 1000).toLocaleString() : "never"}</td>
                <td><div className="actions"><button className="btn sm danger" onClick={async () => { if (confirm(`Revoke "${t.name}"? Whatever uses it stops working immediately.`)) { try { await api.deleteToken(t.id); await load(); } catch (x) { notify(err(x), true); } } }}>Revoke</button></div></td>
              </tr>
            ))}
            {list?.length === 0 && <tr><td colSpan={4} className="sub">No tokens yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <form className="panel stack" onSubmit={create}>
        <h3 style={{ margin: 0 }}>New token</h3>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <Field label="Name" help="Who or what will use it, for example Home Lumina."><input className="field" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <button className="btn primary">Create</button>
        </div>
        <label className="row" style={{ alignItems: "flex-start", gap: 8 }}>
          <input type="checkbox" checked={detail} onChange={(e) => setDetail(e.target.checked)} />
          <span><b>Full detail</b> — lets the other Lumina show each device here like on this one (drives, guests, logs, addresses, serial numbers). It is still read-only, but it sees what a signed-in user sees, not just what an anonymous visitor sees. Leave it off if a summary is enough.</span>
        </label>
      </form>
    </div>
  );
}

function Users() {
  const { notify, auth } = useLumina();
  const [users, setUsers] = useState<UserInfo[] | null>(null);
  const [form, setForm] = useState({ username: "", password: "", role: "operator" });
  const load = () => api.users().then(setUsers).catch((e) => notify(err(e), true));
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    try { await api.addUser(form.username.trim(), form.password, form.role); setForm({ username: "", password: "", role: "operator" }); notify("User added"); await load(); } catch (x) { notify(err(x), true); }
  }
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="hint"><b>Operators</b> can start, stop and restart VMs and servers, refresh, and mute alerts. <b>Admins</b> can also add, edit and remove modules, manage users, notifications, settings and backups. Anyone can view the dashboard without an account (unless you turn public viewing off).</div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>User</th><th>Role</th><th>Last sign-in</th><th className="num">Actions</th></tr></thead>
          <tbody>
            {users?.map((u) => (
              <tr key={u.id}>
                <td>{u.username}{u.id === auth?.user?.id && <span className="tag" style={{ marginLeft: 6 }}>you</span>}</td>
                <td>
                  <select className="field" style={{ padding: "3px 6px" }} value={u.role} onChange={async (e) => { try { await api.updateUser(u.id, { role: e.target.value }); await load(); } catch (x) { notify(err(x), true); } }}>
                    <option value="operator">Operator</option><option value="admin">Admin</option>
                  </select>
                </td>
                <td className="sub">{u.lastLogin ? new Date(u.lastLogin * 1000).toLocaleString() : "never"}</td>
                <td><div className="actions">
                  <button className="btn sm" onClick={async () => { const p = prompt(`New password for ${u.username} (min 8 characters):`); if (p) { try { await api.updateUser(u.id, { password: p }); notify("Password reset"); } catch (x) { notify(err(x), true); } } }}>Reset password</button>
                  <button className="btn sm danger" disabled={u.id === auth?.user?.id} onClick={async () => { if (confirm(`Delete ${u.username}?`)) { try { await api.deleteUser(u.id); await load(); } catch (x) { notify(err(x), true); } } }}>Delete</button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="panel stack" onSubmit={add}>
        <h3 style={{ margin: 0 }}>Add user</h3>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <Field label="Username"><input className="field" required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
          <Field label="Password"><input className="field" type="password" required minLength={8} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label="Role"><select className="field" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="operator">Operator</option><option value="admin">Admin</option></select></Field>
          <button className="btn primary">Add</button>
        </div>
      </form>
    </div>
  );
}

function Backup() {
  const { notify } = useLumina();
  const [pass, setPass] = useState("");
  const [history, setHistory] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [rpass, setRpass] = useState("");
  const [staged, setStaged] = useState(false);
  const [restartable, setRestartable] = useState(false);
  useEffect(() => { api.server().then((s) => setRestartable(s.restartSupported)).catch(() => undefined); }, []);

  async function download() {
    try {
      const blob = await api.backup(pass, history);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `lumina-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      notify("Backup downloaded — keep the passphrase safe, it can't be recovered");
    } catch (x) { notify(err(x), true); }
  }
  async function restore() {
    if (!file || !confirm("Replace ALL current settings, users and credentials with this backup? The current data is kept in the data folder under backups/ and can be put back by hand.")) return;
    try { await api.restore(await readJsonFile(file), rpass); setStaged(true); notify("Backup accepted — restart Lumina to apply it"); } catch (x) { notify(err(x), true); }
  }

  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <div className="hint">A backup is one file holding your modules, credentials, users, notification channels and settings, encrypted with a passphrase you choose. To move Lumina to another machine: install it there, open the page, choose “Restore from backup”, and pick this file.</div>
      <div className="panel stack">
        <h3 style={{ margin: 0 }}>Download a backup</h3>
        <Field label="Passphrase" help="At least 8 characters. You need it to restore, and it can't be recovered."><input className="field" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} /></Field>
        <label className="row"><input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> Include chart history (larger file)</label>
        <div><button className="btn primary" disabled={pass.length < 8} onClick={() => void download()}>Download backup</button></div>
      </div>
      <div className="panel stack">
        <h3 style={{ margin: 0 }}>Restore a backup</h3>
        <input className="field" type="file" accept=".json,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <Field label="Backup passphrase"><input className="field" type="password" autoComplete="off" value={rpass} onChange={(e) => setRpass(e.target.value)} /></Field>
        <div className="row">
          <button className="btn danger" disabled={!file || !rpass} onClick={() => void restore()}>Restore</button>
          {staged && (restartable
            ? <button className="btn primary" onClick={async () => { try { await api.restart(); await waitForServer(); } catch (x) { notify(err(x), true); } }}>Restart now to apply</button>
            : <span className="sub">Restart the service from the host to apply it.</span>)}
        </div>
      </div>
    </div>
  );
}

function Account() {
  const { auth, notify, reloadAuth } = useLumina();
  if (!auth?.user) return <div className="hint">Open access is on, so there is no account to manage. Create an admin account under <b>Users</b> — that turns open access off and asks for a sign-in from then on.</div>;
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  async function change(e: FormEvent) {
    e.preventDefault();
    try { await api.changePassword(cur, next); setCur(""); setNext(""); notify("Password changed"); } catch (x) { notify(err(x), true); }
  }
  return (
    <div className="stack" style={{ maxWidth: 420 }}>
      <div>Signed in as <b>{auth?.user?.username}</b> <span className="tag">{auth?.user?.role}</span></div>
      <form className="stack" onSubmit={change}>
        <h3 style={{ margin: 0 }}>Change password</h3>
        <Field label="Current password"><input className="field" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
        <Field label="New password (at least 8 characters)"><input className="field" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <div><button className="btn primary" disabled={!cur || next.length < 8}>Change password</button></div>
      </form>
      <div><button className="btn" onClick={async () => { await api.logout().catch(() => undefined); await reloadAuth(); }}>Sign out</button></div>
    </div>
  );
}

export function SettingsPage() {
  const L = useLumina();
  const sections: [Section, string][] = L.can.admin
    ? [["general", "General"], ["server", "Server & HTTPS"], ["notifications", "Notifications"], ["users", "Users"], ["tokens", "Access tokens"], ["backup", "Backup & restore"], ["account", "My account"]]
    : [["account", "My account"]];
  const [section, setSection] = useState<Section>(sections[0][0]);
  return (
    <div className="stack">
      <div className="page-title"><h1>Settings</h1></div>
      <div className="seg" style={{ alignSelf: "start", flexWrap: "wrap", maxWidth: "100%" }}>
        {sections.map(([id, label]) => <button key={id} className={id === section ? "on" : ""} onClick={() => setSection(id)}>{label}</button>)}
      </div>
      <section className="panel">
        {section === "general" && <General />}
        {section === "server" && <Server />}
        {section === "notifications" && <Notifications />}
        {section === "users" && <Users />}
        {section === "tokens" && <Tokens />}
        {section === "backup" && <Backup />}
        {section === "account" && <Account />}
      </section>
    </div>
  );
}
