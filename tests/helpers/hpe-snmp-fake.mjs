// A fake HPE iLO SNMP agent serving the CPQ (enterprise 232) health tables, built from a plain description of the server.
import { createRequire } from "node:module";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const snmp = createRequire(ROOT + "/packages/modules/snmp/")("net-snmp");
const E = "1.3.6.1.4.1.232";

export function startFakeHpe(port, server, { community = "public" } = {}) {
  const agent = snmp.createAgent({ port, address: "127.0.0.1" }, () => undefined);
  agent.getAuthorizer().addCommunity(community);
  const mib = agent.getMib();
  const T = snmp.ObjectType;
  const ro = snmp.MaxAccess["read-only"];
  const scalar = (name, oid, type, value) => { if (value === undefined) return; mib.registerProvider({ name, type: snmp.MibProviderType.Scalar, oid, scalarType: type, maxAccess: ro }); mib.setScalarValue(name, value); };
  const sc = server.scalars ?? {};
  scalar("sysName", "1.3.6.1.2.1.1.5", T.OctetString, sc.sysName);
  scalar("sysDescr", "1.3.6.1.2.1.1.1", T.OctetString, sc.sysDescr);
  scalar("overall", `${E}.6.1.3`, T.Integer, sc.overall);
  scalar("thermal", `${E}.6.2.6.1`, T.Integer, sc.thermal);
  scalar("power", `${E}.6.2.9.1`, T.Integer, sc.power);
  scalar("cpu", `${E}.1.2.2.4`, T.Integer, sc.cpu);
  scalar("memory", `${E}.6.2.14.4`, T.Integer, sc.memory);
  scalar("meter", `${E}.6.2.15.3`, T.Integer, sc.meter);
  scalar("product", `${E}.2.2.4.2`, T.OctetString, sc.product);
  scalar("serial", `${E}.2.2.2.1`, T.OctetString, sc.serial);
  scalar("iloModel", `${E}.9.2.2.21`, T.OctetString, sc.iloModel);

  // columns: [number, type]; the first columns listed with index:true form the row index
  const table = (name, entryOid, cols, indexCols, rows) => {
    if (!rows) return;
    mib.registerProvider({
      name, type: snmp.MibProviderType.Table, oid: entryOid, maxAccess: snmp.MaxAccess["not-accessible"],
      tableColumns: cols.map(([number, type]) => ({ number, name: `${name}${number}`, type, maxAccess: ro })),
      tableIndex: indexCols.map((n) => ({ columnName: `${name}${n}` })),
    });
    for (const r of rows) mib.addTableRow(name, r);
  };
  const I = T.Integer, S = T.OctetString;
  table("temps", `${E}.6.2.6.8.1`, [[1, I], [2, I], [3, I], [4, I], [5, I], [6, I]], [1, 2], server.temps?.map((t, i) => [1, i + 1, t[0], t[1], t[2], t[3]]));
  table("fans", `${E}.6.2.6.7.1`, [[1, I], [2, I], [3, I], [4, I], [9, I], [12, I]], [1, 2], server.fans?.map((f, i) => [1, i + 1, f[0], f[1], f[2], f[3]]));
  table("psu", `${E}.6.2.9.3.1`, [[1, I], [2, I], [3, I], [4, I], [6, I], [7, I], [8, I]], [1, 2], server.supplies?.map((p, i) => [1, i + 1, p[0], p[1], p[2], p[3], p[4]]));
  table("cpus", `${E}.1.2.2.1.1`, [[1, I], [2, I], [3, S], [4, I], [6, I]], [1], server.cpus?.map((c, i) => [i + 1, i, c[0], c[1], c[2]]));
  table("dimms", `${E}.2.2.4.5.1`, [[1, I], [2, I], [3, I], [11, I], [12, S], [13, I]], [1, 2], server.dimms?.map((d, i) => [1, i + 1, d[0], d[1], d[2], d[3]]));
  table("ctrl", `${E}.3.2.2.1.1`, [[1, I], [2, S], [5, I], [6, I]], [1], server.controllers?.map((c, i) => [i + 1, c[0], c[1], c[2]]));
  table("logical", `${E}.3.2.3.1.1`, [[1, I], [2, I], [3, I], [4, I], [9, I], [11, I]], [1, 2], server.logical?.map((l, i) => [1, i + 1, l[0], l[1], l[2], l[3]]));
  table("phys", `${E}.3.2.5.1.1`, [[1, I], [2, I], [3, S], [5, I], [6, I], [37, I], [45, I], [64, S], [69, I], [70, I], [71, I], [74, I]], [1, 2], server.drives?.map((d, i) => [1, i + 1, d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8], d[9]]));
  return { agent, close: () => { try { agent.close(() => undefined); } catch { /* ignore */ } } };
}

/** A DL380 Gen9 with trouble: a failed drive, a degraded controller, a hot drive and a memory module with too many corrected errors. */
export const GEN9_WITH_TROUBLE = {
  scalars: { sysName: "ilo-prox1", sysDescr: "Integrated Lights-Out 4 2.80", overall: 3, thermal: 2, power: 2, cpu: 2, memory: 3, meter: 231, product: "ProLiant DL380 Gen9", serial: "CZ1234567X", iloModel: "iLO 4" },
  temps: [[11, 26, 42, 2], [6, 60, 70, 2], [6, 74, 70, 3], [7, -99, 0, 1], [8, 40, 60, 2]],
  fans: [[3, 3, 2, 3100], [3, 3, 2, 3150], [3, 3, 4, 0], [3, 2, 1, 0]],
  supplies: [[3, 2, 230, 130, 500], [3, 2, 231, 101, 500], [2, 1, 0, 0, 0]],
  cpus: [["Intel(R) Xeon(R) CPU E5-2660 v4", 2000, 2], ["Intel(R) Xeon(R) CPU E5-2660 v4", 2000, 2]],
  dimms: [[16777216, 2, "PROC 1 DIMM 1", 2133], [16777216, 3, "PROC 1 DIMM 2", 2133], [0, 1, "PROC 1 DIMM 3", 0]],
  controllers: [["Smart Array P440ar Controller", 0, 3]],
  logical: [[6, 5, 1171456, 3]],
  drives: [["AL14SEB120N", 1, 2, 2, 1144641, "Port 1I Box 1 Bay 1", 2, 34, 60, 9000], ["AL14SEB120N", 4, 3, 4, 1144641, "Port 1I Box 1 Bay 4", 2, 33, 60, 9100], ["H101812SFSUN1.2T", 6, 2, 2, 1144641, "Port 2I Box 3 Bay 6", 2, 56, 60, 2000]],
};
