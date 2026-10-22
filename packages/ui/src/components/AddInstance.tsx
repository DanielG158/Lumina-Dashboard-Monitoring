import { useEffect, useState, type FormEvent } from "react";
import { ChecksEditor } from "./ChecksEditor";
import { api, type ConfigField, type ModuleInfo } from "../api";

interface Props {
  modules: ModuleInfo[];
  editing?: string;
  onDone: (message: string) => void;
  onClose: () => void;
}

type Values = Record<string, string | boolean>;

function defaults(fields: ConfigField[]): Values {
  return Object.fromEntries(
    fields.map((f) => [f.key, f.type === "boolean" ? Boolean(f.default) : f.default !== undefined ? String(f.default) : ""]),
  );
}

export function AddInstance({ modules, editing, onDone, onClose }: Props) {
  const [moduleId, setModuleId] = useState(modules[0]?.id ?? "");
  const mod = modules.find((m) => m.id === moduleId);
  const [instanceId, setInstanceId] = useState(editing ?? "");
  const [values, setValues] = useState<Values>(() => defaults(mod?.fields ?? []));
  const [pollSec, setPollSec] = useState("");
  const [loading, setLoading] = useState(Boolean(editing));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checksErrors, setChecksErrors] = useState<string[]>([]);

  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    api.getConfig(editing)
      .then(({ moduleId: mid, config, pollIntervalSec }) => {
        if (cancelled) return;
        const fields = modules.find((m) => m.id === mid)?.fields ?? [];
        const next = defaults(fields);
        for (const f of fields) {
          if (f.type === "password" || config[f.key] === undefined) continue;
          next[f.key] = f.type === "boolean" ? Boolean(config[f.key]) : String(config[f.key]);
        }
        setModuleId(mid);
        setValues(next);
        setPollSec(pollIntervalSec ? String(pollIntervalSec) : "");
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [editing, modules]);

  function pickModule(id: string) {
    setModuleId(id);
    setValues(defaults(modules.find((m) => m.id === id)?.fields ?? []));
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!mod) return;
    if (mod.id === "netcheck") {
      if (checksErrors.length > 0) { setError(`Fix the highlighted checks first: ${checksErrors[0]}`); return; }
      if (!String(values.targets ?? "").trim()) { setError("Add at least one check."); return; }
    }
    const config: Record<string, unknown> = {};
    for (const f of mod.fields) {
      const v = values[f.key];
      if (f.type === "boolean") config[f.key] = Boolean(v);
      else if (typeof v === "string" && v.trim() !== "") config[f.key] = f.type === "number" ? Number(v) : v.trim();
    }
    const poll = pollSec.trim() === "" ? null : Number(pollSec);
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        const newName = instanceId.trim();
        let current = editing;
        // The name is changed first (history, alerts and schedules follow it), then the settings are saved under the new name.
        if (newName && newName !== editing) { await api.renameInstance(editing, newName); current = newName; }
        await api.updateInstance(current, config, poll);
        onDone(current === editing ? `${editing} updated` : `Renamed to ${current} and updated`);
      } else {
        await api.addInstance(mod.id, instanceId.trim(), config, poll);
        onDone("Instance added");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{editing ? `Edit ${editing}` : "Add module instance"}</h2>
        <button className="btn sm" type="button" onClick={onClose}>Cancel</button>
      </div>
      {loading ? (
        <div className="empty">Loading settings…</div>
      ) : (
        <form className="add" onSubmit={submit}>
          <label>
            Module
            <select value={moduleId} disabled={Boolean(editing)} onChange={(e) => pickModule(e.target.value)}>
              {modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label>
            Instance name
            <input required maxLength={64} value={instanceId} placeholder={mod?.id ?? ""} onChange={(e) => setInstanceId(e.target.value)} />
            {editing && instanceId.trim() !== editing && <small>Renaming keeps its history, alerts, schedules and maintenance windows.</small>}
          </label>
          {mod && <div className="full hint">{mod.description}</div>}
          {mod?.fields.map((f) =>
            f.type === "boolean" ? (
              <label key={f.key} className="check">
                <span>
                  <input type="checkbox" checked={Boolean(values[f.key])} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })} /> {f.label}
                </span>
                {f.help && <small>{f.help}</small>}
              </label>
            ) : (
              <label key={f.key}>
                {f.label}
                {f.type === "textarea" && moduleId === "netcheck" && f.key === "targets" ? (
                  <ChecksEditor key={`${moduleId}:${editing ?? "new"}:${loading}`} value={String(values[f.key] ?? "")} onChange={(text, errors) => { setValues((v) => (v[f.key] === text ? v : { ...v, [f.key]: text })); setChecksErrors(errors); }} />
                ) : f.type === "textarea" ? (
                  <textarea
                    required={f.required}
                    rows={6}
                    spellCheck={false}
                    style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}
                    value={String(values[f.key] ?? "")}
                    placeholder={f.placeholder}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  />
                ) : (
                <input
                  required={f.required && !(editing && f.type === "password")}
                  type={f.type === "password" ? "password" : f.type === "number" ? "number" : "text"}
                  autoComplete="off"
                  value={String(values[f.key] ?? "")}
                  placeholder={editing && f.type === "password" ? "unchanged — leave blank to keep" : f.placeholder}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
                )}
                {f.help && <small>{f.help}</small>}
                {f.key === "fingerprint" && (
                  <button
                    type="button"
                    className="btn sm"
                    style={{ justifySelf: "start" }}
                    onClick={async () => {
                      const url = String(values.host ?? values.url ?? "").trim();
                      setError(null);
                      try {
                        const { fingerprint } = await api.probeFingerprint(url);
                        setValues((v) => ({ ...v, fingerprint }));
                      } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
                    }}
                  >Detect from the device</button>
                )}
              </label>
            ),
          )}
          {mod && (
            <label>
              Refresh every (seconds)
              <input
                type="number"
                min={Math.ceil(mod.minPollIntervalMs / 1000)}
                max={3600}
                step={1}
                value={pollSec}
                placeholder={`default ${Math.round(mod.pollIntervalMs / 1000)}`}
                onChange={(e) => setPollSec(e.target.value)}
              />
              <small>Leave blank for the default. Lowest allowed: {Math.ceil(mod.minPollIntervalMs / 1000)} s. Slow devices like iLO are gentler at 15 s or more.</small>
            </label>
          )}
          <div className="full">
            <button className="btn primary" disabled={busy || !instanceId.trim()}>{busy ? "Saving…" : editing ? "Save changes" : "Add instance"}</button>
            {error && <div className="error">{error}</div>}
          </div>
        </form>
      )}
      {loading && error && <div className="error">{error}</div>}
    </section>
  );
}
