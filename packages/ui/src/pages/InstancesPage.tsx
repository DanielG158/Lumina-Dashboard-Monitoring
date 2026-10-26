import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { AddInstance } from "../components/AddInstance";
import { CardShell, setAllCards, type CardProps } from "../components/CardShell";
import { CloudflareCard } from "../components/CloudflareCard";
import { IloCard } from "../components/IloCard";
import { KumaCard } from "../components/KumaCard";
import { ProxmoxCard } from "../components/ProxmoxCard";
import { NetCheckCard } from "../components/NetCheckCard";
import { TplinkRouterCard } from "../components/TplinkRouterCard";
import { IloSnmpCard } from "../components/IloSnmpCard";
import { OmadaCard } from "../components/OmadaCard";
import { SnmpCard } from "../components/SnmpCard";
import { RemoteCard } from "../components/RemoteCard";
import { UpsCard } from "../components/UpsCard";
import { useLumina } from "../context";

const CARDS: Record<string, (props: CardProps) => ReactElement> = {
  proxmox: ProxmoxCard,
  apcupsd: UpsCard,
  ilo4: IloCard,
  "ilo-snmp": IloSnmpCard,
  cloudflare: CloudflareCard,
  "uptime-kuma": KumaCard,
  lumina: RemoteCard,
  netcheck: NetCheckCard,
  snmp: SnmpCard,
  omada: OmadaCard,
  "tplink-router": TplinkRouterCard,
};

interface Props {
  adding: boolean;
  editing: string | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}

export function InstancesPage({ adding, editing, onClose, onDone }: Props) {
  const open = adding || Boolean(editing);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    document.body.classList.add("modal-open");
    return () => { document.removeEventListener("keydown", key); document.body.classList.remove("modal-open"); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const L = useLumina();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");
  const [problems, setProblems] = useState(false);
  const modName = (id: string) => L.modules.find((m) => m.id === id)?.name ?? id;
  const kinds = [...new Set(L.instances.map((i) => i.moduleId))];
  const sick = (i: (typeof L.instances)[number]) => i.enabled && (i.status !== "connected" || L.alertsFor(i.instanceId).length > 0);
  const shown = L.instances.filter((i) =>
    (kind === "all" || i.moduleId === kind) &&
    (!problems || sick(i)) &&
    (!q.trim() || `${i.instanceId} ${modName(i.moduleId)}`.toLowerCase().includes(q.trim().toLowerCase())));
  const filtering = q.trim() !== "" || kind !== "all" || problems;
  return (
    <div>
      <div className="page-title">
        <h1>Instances</h1>
        <span className="grow" />
        {L.can.admin && !adding && !editing && <button className="btn primary" onClick={L.startAdding}>+ Add module</button>}
      </div>

      {(adding || editing) && L.can.admin && (
        // A popup over the page: the list behind keeps its scroll position, so editing a card at the bottom does not throw you to the top.
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-modal="true" aria-label={editing ? `Edit ${editing}` : "Add module"}>
          <div className="modal-sheet">
            <AddInstance key={editing ?? "new"} modules={L.modules} editing={editing ?? undefined} onClose={onClose} onDone={onDone} />
          </div>
        </div>
      )}

      {L.instances.length === 0 && !adding && (
        <div className="panel empty">
          No module instances yet.{" "}
          {L.can.admin ? <>Click <b>Add module</b> to connect Proxmox, a UPS, iLO, Cloudflare or Uptime Kuma.</> : "An admin can add them after signing in."}
        </div>
      )}

      {L.instances.length >= 4 && (
        <div className="filterbar" role="search">
          <input type="search" className="field" placeholder="Find an instance…" aria-label="Find an instance" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="chips">
            <button className={`chip ${kind === "all" ? "on" : ""}`} onClick={() => setKind("all")}>All {L.instances.length}</button>
            {kinds.length > 1 && kinds.map((k) => (
              <button key={k} className={`chip ${kind === k ? "on" : ""}`} onClick={() => setKind(kind === k ? "all" : k)}>{modName(k)} {L.instances.filter((i) => i.moduleId === k).length}</button>
            ))}
            <button className={`chip ${problems ? "on" : ""}`} onClick={() => setProblems(!problems)}>Needs attention {L.instances.filter(sick).length}</button>
          </div>
          <span className="grow" />
          <button className="btn sm" onClick={() => setAllCards(false)}>Collapse all</button>
          <button className="btn sm" onClick={() => setAllCards(true)}>Expand all</button>
        </div>
      )}
      {filtering && <div className="sub" style={{ margin: "0 0 8px" }}>Showing {shown.length} of {L.instances.length}. Moving a card up or down moves it in the full list.{" "}<button className="btn sm" onClick={() => { setQ(""); setKind("all"); setProblems(false); }}>Show everything</button></div>}
      {filtering && shown.length === 0 && <div className="panel empty">Nothing matches.</div>}

      {shown.map((i) => {
        const Card = CARDS[i.moduleId];
        return Card ? (
          <Card key={i.instanceId} instance={i} />
        ) : (
          <CardShell key={i.instanceId} instance={i} tag={i.moduleId}>
            <pre style={{ fontSize: 12, overflow: "auto" }}>{JSON.stringify(i.data, null, 2)}</pre>
          </CardShell>
        );
      })}
    </div>
  );
}
