// The Cloudflare module against a fake API: tunnels, hostname checks, certificate dates, reconnect churn, DNS records, dynamic DNS, analytics and Access logs.
import { fileURLToPath as __f } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import { startFakeCloudflare } from "./helpers/cloudflare-fake.mjs";

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const modFile = await import(ROOT + "/packages/modules/cloudflare/dist/index.js");
const mod = modFile.default;
const { checkHostname, churnBuckets } = modFile;
const { redactState } = await import(ROOT + "/packages/core/dist/redact.js");
const log = { info() {}, warn() {}, error() {} };

// two local HTTPS servers with self-signed certificates: one valid for 10 days, one for 2
const dir = mkdtempSync(join(tmpdir(), "cf-test-"));
const cert = (name, days) => {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/${name}.key`, "-out", `${dir}/${name}.crt`, "-days", String(days), "-subj", "/CN=localhost"], { stdio: "ignore" });
  return { key: readFileSync(`${dir}/${name}.key`), cert: readFileSync(`${dir}/${name}.crt`) };
};
const web = async (opts, status) => {
  const s = createServer(opts, (_q, r) => { r.writeHead(status); r.end(); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { port: s.address().port, close: () => s.close() };
};
const good = await web(cert("good", 10), 200);
const soon = await web(cert("soon", 2), 200);
const broken = await web(cert("broken", 90), 503);

// ---- hostname checks on their own ----
let h = await checkHostname("localhost", { port: good.port });
check("a hostname that answers is up, with its speed and certificate dates", h.dns.ok && h.https.ok && h.https.status === 200 && typeof h.https.ms === "number" && h.cert.daysLeft >= 9 && h.cert.daysLeft <= 10, JSON.stringify(h.cert));
check("a certificate nobody trusts is said to be untrusted", h.cert.trusted === false);
h = await checkHostname("localhost", { port: broken.port });
check("an HTTP error is reported with its status", h.https.ok && h.https.status === 503);
h = await checkHostname("localhost", { port: 9 });
check("nothing listening is reported", !h.https.ok && /ECONNREFUSED/.test(h.https.error ?? ""), h.https.error);
h = await checkHostname("no-such-host.invalid");
check("a name that does not resolve is reported as DNS", !h.dns.ok && h.https.ok === false && h.cert === null);

// ---- churn ----
// start well inside a 2-minute bucket, or a burst that begins just before a boundary would be counted twice
const t0 = Math.floor(Date.now() / 120_000) * 120_000 + 20_000;
check("one burst of new connections is one stretch, steady churn is many", churnBuckets([t0, t0 + 1000, t0 + 5000], t0 + 6000) === 1 && churnBuckets([t0 - 600_000, t0 - 400_000, t0 - 200_000, t0], t0) === 4 && churnBuckets([t0 - 3_600_000], t0) === 0);

// ---- the module ----
const fake = await startFakeCloudflare();
const { state } = fake;
process.env.LUMINA_CLOUDFLARE_API = fake.base;
process.env.LUMINA_CLOUDFLARE_CHECK_PORT = String(good.port);
const make = (extra = {}) => mod.create(mod.configSchema.parse({ apiToken: "good-token", accountId: "acc", zoneId: "zone", extraHostnames: "localhost", ...extra }), { log });
const settle = async (inst) => { let d; for (let i = 0; i < 20; i++) { d = await inst.poll(); if (!d.hostnames.some((x) => x.pending)) return d; await new Promise((r) => setTimeout(r, 300)); } return d; };

let inst = await make();
let d = await settle(inst);
check("tunnels, zone and DNS records are read", d.tunnels.length === 1 && d.tunnels[0].connections === 4 && d.zone.name === "example.test" && d.records.length === 4 && d.records[0].tunnel === true, JSON.stringify(d.zone));
check("hostnames come from tunnel records, proxied records and the typed list", ["app.example.test", "blog.example.test", "localhost"].every((n) => d.hostnames.some((x) => x.name === n)) && !d.hostnames.some((x) => x.name === "home.example.test") && d.hostnames.find((x) => x.name === "app.example.test").source === "tunnel" && d.hostnames.find((x) => x.name === "localhost").source === "extra");
check("analytics give the last days with totals", d.analytics.length === 3 && d.analytics[2].requests === 3000 && d.analytics[2].threats === 2);
check("Access logs give entries and the refused count", d.access.entries.length === 12 && d.access.denied1h === 11);
let al = inst.alerts(d);
check("a hostname that does not resolve raises a warning", al.some((a) => a.key === "host-dns:app.example.test" && a.severity === "warning"));
check("many refused Access logins raise a warning", al.some((a) => a.key === "access-denied"));
check("a healthy tunnel with a steady connection list raises nothing about reconnects", !al.some((a) => a.key.startsWith("flap:")));
check("a certificate with 10 days left raises a warning", al.some((a) => a.key === "cert:localhost" && a.severity === "warning"), al.map((a) => a.key).join());
let mt = inst.metrics(d);
check("history keeps hostname counts, the soonest certificate and refused logins", mt["hostnames:total"] === 3 && mt["hostnames:up"] === 1 && mt["cert:min-days"] <= 10 && mt["access:denied1h"] === 11, JSON.stringify(mt));

// connections replaced once: one stretch, no alert
state.tunnels[0].connections = state.tunnels[0].connections.map((c, i) => ({ ...c, uuid: `n${i}` }));
d = await inst.poll();
check("a single reconnect is counted but does not raise an alert", d.tunnels[0].churn === 1 && !inst.alerts(d).some((a) => a.key.startsWith("flap:")));
check("steady reconnecting raises a warning", inst.alerts({ ...d, tunnels: [{ ...d.tunnels[0], churn: 3 }] }).some((a) => a.key === "flap:homelab" && a.severity === "warning"));

// certificate nearly out, server errors, connection refused
process.env.LUMINA_CLOUDFLARE_CHECK_PORT = String(soon.port);
let inst2 = await make({ zoneId: undefined });
d = await settle(inst2);
check("a certificate with under 3 days left is critical", inst2.alerts(d).some((a) => a.key === "cert:localhost" && a.severity === "critical"));
check("without a Zone ID there are no records and only the typed hostnames", d.records === null && d.hostnames.length === 1);
process.env.LUMINA_CLOUDFLARE_CHECK_PORT = String(broken.port);
d = await settle(await make());
check("an HTTP 503 raises a warning", (await make()).alerts(d).some((a) => a.key === "host-down:localhost" && a.severity === "warning"));
process.env.LUMINA_CLOUDFLARE_CHECK_PORT = "9";
d = await settle(await make());
check("no answer at all is critical", (await make()).alerts(d).some((a) => a.key === "host-down:localhost" && a.severity === "critical"));
process.env.LUMINA_CLOUDFLARE_CHECK_PORT = String(good.port);

// ---- missing permissions do not break the rest ----
state.analyticsDenied = true; state.accessDenied = true;
inst = await make();
d = await settle(inst);
check("a missing permission is reported next to its section and the rest still works", /does not have access/.test(d.notes.analytics ?? "") && /not enabled/.test(d.notes.access ?? "") && d.analytics === null && d.access === null && d.tunnels.length === 1 && d.records.length === 4, JSON.stringify(d.notes));
state.analyticsDenied = false; state.accessDenied = false;

// ---- dynamic DNS ----
inst = await make({ dynamicDns: "home.example.test\nnothere.example.test" });
d = await settle(inst);
check("a changed public IP rewrites the A record", d.ddns.ip === "198.51.100.99" && d.ddns.hosts.find((x) => x.name === "home.example.test").status === "updated" && state.records.find((r) => r.id === "r2").content === "198.51.100.99");
check("a hostname without a record is reported, not created", d.ddns.hosts.find((x) => x.name === "nothere.example.test").status === "missing" && !state.records.some((r) => r.name === "nothere.example.test") && inst.alerts(d).some((a) => a.key === "ddns:nothere.example.test"));
await new Promise((r) => setTimeout(r, 100));
const writes = state.calls.filter((c) => c.startsWith("PATCH")).length;
d = await inst.poll();
check("when the IP has not changed nothing is written again", d.ddns.hosts.find((x) => x.name === "home.example.test").status === "ok" && state.calls.filter((c) => c.startsWith("PATCH")).length === writes);
inst = await make();
d = await settle(inst);
check("dynamic DNS stays off when nothing is typed", d.ddns === null);

// ---- DNS actions ----
const act = (id) => inst.actions.find((a) => a.id === id);
let e = null; try { act("dns-add").input.parse({ type: "A", name: "x.example.test", content: "not-an-ip" }); } catch (x) { e = x.message; }
check("an A record with something other than an IPv4 address is refused", /IPv4/.test(e ?? ""));
await act("dns-add").run(act("dns-add").input.parse({ type: "A", name: "new.example.test", content: "203.0.113.20", proxied: true }));
check("a DNS record can be added", state.records.some((r) => r.name === "new.example.test" && r.proxied === true));
const id = state.records.find((r) => r.name === "new.example.test").id;
await act("dns-edit").run(act("dns-edit").input.parse({ id, proxied: false, content: "203.0.113.21" }));
check("a DNS record can be edited", state.records.find((r) => r.id === id).content === "203.0.113.21" && state.records.find((r) => r.id === id).proxied === false);
e = null; try { await act("dns-edit").run({ id }); } catch (x) { e = x.message; }
check("an edit with nothing to change is refused", /Nothing to change/.test(e ?? ""));
await act("dns-remove").run({ id });
check("a DNS record can be removed", !state.records.some((r) => r.id === id));
check("the DNS actions are admin only and removing is marked dangerous", ["dns-add", "dns-edit", "dns-remove"].every((n) => act(n).minRole === "admin") && act("dns-remove").dangerous === true);
const noZone = await make({ zoneId: undefined });
e = null; try { await noZone.actions.find((a) => a.id === "dns-add").run({ type: "A", name: "a.example.test", content: "203.0.113.1" }); } catch (x) { e = x.message; }
check("DNS actions without a Zone ID say what to set", /Zone ID/.test(e ?? ""));

// ---- bad token, anonymous view ----
state.token = "other";
let err = null; try { await (await make()).poll(); } catch (x) { err = x.message; }
check("a token Cloudflare rejects is reported", /Authentication error/.test(err ?? ""), err);
state.token = "good-token";
d = await settle(await make({ dynamicDns: "home.example.test" }));
const red = redactState({ instanceId: "C", moduleId: "cloudflare", status: "connected", enabled: true, error: null, data: d });
const text = JSON.stringify(red.data);
check("anonymous viewers see hostnames and states but no record contents, addresses, e-mails or IPs", red.data.records.every((r) => r.content === "") && red.data.access.entries.length === 0 && red.data.access.denied1h === 11 && red.data.ddns.ip === null && !text.includes("me@example.test") && !text.includes("203.0.113.9") && !text.includes("198.51.100.99") && red.data.hostnames.some((x) => x.name === "localhost"));
check("the API token is never part of the data", !JSON.stringify(d).includes("good-token"));

fake.close(); good.close(); soon.close(); broken.close();
process.exit(ok ? 0 : 1);
