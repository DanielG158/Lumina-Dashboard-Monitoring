import { useState, type FormEvent } from "react";
import { api } from "../api";
import { LuminaMark } from "./Icons";

export function LoginDialog({ onClose, onDone, notice }: { onClose: () => void; onDone: () => void; notice?: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username.trim(), password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <form className="dialog stack" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div>
          <div style={{ marginBottom: 10 }}><LuminaMark size={40} /></div>
          <h2>Sign in</h2>
          <div className="sub">{notice ?? "Anyone can look at the dashboard. Signing in lets you control things."}</div>
        </div>
        <input className="field" autoFocus placeholder="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input className="field" type="password" placeholder="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="error">{error}</div>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !username || !password}>{busy ? "Signing in…" : "Sign in"}</button>
        </div>
      </form>
    </div>
  );
}

/** Waits for the server to come back after a restart, then reloads (optionally at a new address). */
export async function waitForServer(target?: string) {
  const base = target ?? "";
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/health`, { mode: target ? "no-cors" : "same-origin" });
      if (target || res.ok) break;
    } catch { /* still restarting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (target) window.location.href = target;
  else window.location.reload();
}

export function readJsonFile(file: File): Promise<unknown> {
  return file.text().then((t) => {
    try { return JSON.parse(t); } catch { throw new Error("That file isn't a Lumina backup (could not read it as JSON)"); }
  });
}

/** First run: create the admin account, or bring everything over from another Lumina's backup. */
export function SetupScreen({ onDone, codeRequired }: { onDone: () => void; codeRequired: boolean }) {
  const [code, setCode] = useState("");
  async function skip() {
    if (!window.confirm("Run Lumina without any accounts?\n\nUntil you create an account, ANYONE who can reach this page can control everything: stop VMs, power the server off, change settings. That's fine on a private network you trust, and you can create an admin account at any time (Settings → Users) to lock it down.")) return;
    try { await api.skipSetup(code); onDone(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }
  const [mode, setMode] = useState<"new" | "restore">("new");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("The two passwords don't match");
    setBusy(true);
    setError(null);
    try {
      await api.setup(username.trim(), password, code);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function restore(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.restoreFirstRun(await readJsonFile(file), pass, code);
      setNote(res.restarting ? "Backup accepted. Lumina is restarting with your restored settings…" : "Backup accepted. Restart Lumina to finish restoring, then reload this page.");
      if (res.restarting) await waitForServer();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="authscreen">
      <div className="dialog stack" style={{ width: "min(480px, 100%)" }}>
        <div>
          <div style={{ marginBottom: 10 }}><LuminaMark size={44} /></div>
          <h2>Welcome to Lumina</h2>
          <div className="sub">Set up this installation. Looking at the dashboard never needs an account — accounts are for controlling things and changing settings.</div>
        </div>
        {codeRequired && (
          <label className="stack" style={{ gap: 4 }}>
            <span className="sub">Setup code — shown when Lumina was installed (or run <code>cat /var/lib/lumina/setup-code</code> on the server)</span>
            <input className="field" placeholder="XXXX-XXXX" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        )}
        <div className="seg" role="tablist">
          <button className={mode === "new" ? "on" : ""} onClick={() => setMode("new")}>New installation</button>
          <button className={mode === "restore" ? "on" : ""} onClick={() => setMode("restore")}>Restore from backup</button>
        </div>

        {mode === "new" ? (
          <form className="stack" onSubmit={create}>
            <label className="stack" style={{ gap: 4 }}><span className="sub">Admin username</span>
              <input className="field" value={username} autoComplete="username" onChange={(e) => setUsername(e.target.value)} /></label>
            <label className="stack" style={{ gap: 4 }}><span className="sub">Password (at least 8 characters)</span>
              <input className="field" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <label className="stack" style={{ gap: 4 }}><span className="sub">Repeat password</span>
              <input className="field" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
            {error && <div className="error">{error}</div>}
            <button className="btn primary" disabled={busy || !username || password.length < 8}>{busy ? "Creating…" : "Create admin account"}</button>
          </form>
        ) : (
          <form className="stack" onSubmit={restore}>
            <div className="sub">Choose the backup file you downloaded from another Lumina (Settings → Backup &amp; restore) and enter its passphrase. Your modules, users, notification channels and credentials come across.</div>
            <input className="field" type="file" accept=".json,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <input className="field" type="password" placeholder="Backup passphrase" value={pass} onChange={(e) => setPass(e.target.value)} />
            {error && <div className="error">{error}</div>}
            {note && <div className="ok-text">{note}</div>}
            <button className="btn primary" disabled={busy || !file || !pass}>{busy ? "Restoring…" : "Restore"}</button>
          </form>
        )}
        <button className="btn" style={{ background: "none", border: 0, textDecoration: "underline", color: "var(--muted)" }} onClick={() => void skip()}>Skip — don't use accounts for now</button>
      </div>
    </div>
  );
}
