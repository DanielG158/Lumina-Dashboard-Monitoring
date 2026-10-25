import type { InstanceState } from "./registry.js";

type Obj = Record<string, any>;

/**
 * What an anonymous viewer is allowed to see. Status and numbers stay; anything that identifies hardware, internal addresses
 * or who did what (logs, serials, MACs, URLs, raw error text) is removed. Shapes are kept so the UI never breaks on missing fields.
 */
function redactData(moduleId: string, d: Obj): Obj {
  switch (moduleId) {
    case "proxmox":
      return {
        ...d,
        guests: (d.guests ?? []).map((g: Obj) => ({ ...g, consoleUrl: null })),
        nodes: (d.nodes ?? []).map((n: Obj) => ({ ...n, ssl_fingerprint: undefined, details: n.details && { ...n.details, kernel: null } })),
        disks: (d.disks ?? []).map((k: Obj) => ({ ...k, serial: null })),
        network: [],
        tasks: [],
        log: [],
        backups: (d.backups ?? []).map((b: Obj) => ({ ...b, target: "", comment: null })),
        warnings: [],
      };
    case "ilo4":
      return {
        ...d,
        serial: null,
        hostOs: null,
        supplies: (d.supplies ?? []).map((s: Obj) => ({ ...s, serial: null })),
        ilo: d.ilo && { ...d.ilo, ip: null, mac: null, hostName: null, ipOrigin: null },
        storage: d.storage && {
          ...d.storage,
          controllers: d.storage.controllers.map((c: Obj) => ({ ...c, serial: null })),
          drives: d.storage.drives.map((x: Obj) => ({ ...x, serial: null })),
        },
        network: d.network && d.network.map((a: Obj) => ({ ...a, ports: a.ports.map((p: Obj) => ({ ...p, mac: null, ips: [], team: null })) })),
        logs: { iml: null, iel: null },
        warnings: [],
      };
    case "netcheck":
      return { ...d, targets: (d.targets ?? []).map((t: Obj) => ({ ...t, target: "" })) };
    case "omada":
      return { ...d, controller: d.controller && { ...d.controller, user: null }, sites: (d.sites ?? []).map((s: Obj) => ({ ...s, devices: (s.devices ?? []).map((x: Obj) => ({ ...x, mac: "", ip: "" })) })) };
    case "tplink-router":
      return { ...d, list: [], wan: d.wan && { ...d.wan, ip: "", gateway: "" }, lan: d.lan && { ...d.lan, ip: "" } };
    case "ilo-snmp":
      return { ...d, serial: null, ilo: d.ilo && { ...d.ilo, name: null, description: null }, warnings: [] };
    case "snmp":
      return { ...d, sysDescr: null, interfaces: (d.interfaces ?? []).map((i: Obj) => ({ ...i, alias: null })) };
    case "uptime-kuma":
      return { ...d, monitors: (d.monitors ?? []).map((m: Obj) => ({ ...m, target: "" })) };
    case "cloudflare":
      return {
        ...d,
        tunnels: (d.tunnels ?? []).map((t: Obj) => ({ ...t, ingress: (t.ingress ?? []).map((r: Obj) => ({ ...r, service: "" })) })),
        records: d.records ? (d.records as Obj[]).map((r) => ({ ...r, content: "" })) : d.records,
        hostnames: (d.hostnames ?? []).map((h: Obj) => ({ ...h, dns: h.dns ? { ...h.dns, addresses: [] } : h.dns })),
        access: d.access ? { entries: [], denied1h: d.access.denied1h } : d.access,
        ddns: d.ddns ? { ip: null, hosts: (d.ddns.hosts ?? []).map((h: Obj) => ({ ...h, detail: "" })) } : d.ddns,
      };
    default:
      return d;
  }
}

export function redactState(s: InstanceState): InstanceState {
  return {
    ...s,
    data: s.data && typeof s.data === "object" ? redactData(s.moduleId, s.data as Obj) : s.data,
    error: s.error ? "unreachable" : null,
  };
}
