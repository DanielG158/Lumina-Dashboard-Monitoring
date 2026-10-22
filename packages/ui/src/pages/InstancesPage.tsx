import type { ReactElement } from "react";
import { AddInstance } from "../components/AddInstance";
import { CardShell, type CardProps } from "../components/CardShell";
import { CloudflareCard } from "../components/CloudflareCard";
import { IloCard } from "../components/IloCard";
import { KumaCard } from "../components/KumaCard";
import { ProxmoxCard } from "../components/ProxmoxCard";
import { NetCheckCard } from "../components/NetCheckCard";
import { SnmpCard } from "../components/SnmpCard";
import { RemoteCard } from "../components/RemoteCard";
import { UpsCard } from "../components/UpsCard";
import { useLumina } from "../context";

const CARDS: Record<string, (props: CardProps) => ReactElement> = {
  proxmox: ProxmoxCard,
  apcupsd: UpsCard,
  ilo4: IloCard,
  cloudflare: CloudflareCard,
  "uptime-kuma": KumaCard,
  lumina: RemoteCard,
  netcheck: NetCheckCard,
  snmp: SnmpCard,
};

interface Props {
  adding: boolean;
  editing: string | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}

export function InstancesPage({ adding, editing, onClose, onDone }: Props) {
  const L = useLumina();
  return (
    <div>
      <div className="page-title">
        <h1>Instances</h1>
        <span className="grow" />
        {L.can.admin && !adding && !editing && <button className="btn primary" onClick={L.startAdding}>+ Add module</button>}
      </div>

      {(adding || editing) && L.can.admin && (
        <AddInstance key={editing ?? "new"} modules={L.modules} editing={editing ?? undefined} onClose={onClose} onDone={onDone} />
      )}

      {L.instances.length === 0 && !adding && (
        <div className="panel empty">
          No module instances yet.{" "}
          {L.can.admin ? <>Click <b>Add module</b> to connect Proxmox, a UPS, iLO, Cloudflare or Uptime Kuma.</> : "An admin can add them after signing in."}
        </div>
      )}

      {L.instances.map((i) => {
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
