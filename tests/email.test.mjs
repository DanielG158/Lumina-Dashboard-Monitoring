// Email channel: a new problem is mailed at once, a problem still there a day later is mailed again every day, a fixed one is mailed as fixed.
import { fileURLToPath as __f } from "node:url";
const ROOT = __f(new URL("..", import.meta.url)).replace(/\/$/, "");
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const E = await import(ROOT + "/packages/core/dist/email.js");

let ok = true;
const check = (n, c, x = "") => { if (!c) ok = false; console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  -> " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(300); } return false; };

// a mail server that only records what it is given
const mails = [];
const smtp = net.createServer((sock) => {
  let buf = "", data = null;
  const say = (l) => sock.write(l + "\r\n");
  say("220 fake ESMTP");
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    for (;;) {
      if (data !== null) {
        const i = buf.indexOf("\r\n.\r\n");
        if (i < 0) return;
        mails.push(buf.slice(0, i)); buf = buf.slice(i + 5); data = null; say("250 queued"); continue;
      }
      const i = buf.indexOf("\r\n");
      if (i < 0) return;
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (/^EHLO/i.test(line)) say("250-fake\r\n250 8BITMIME");
      else if (/^(MAIL|RCPT|RSET|NOOP)/i.test(line)) say("250 OK");
      else if (/^DATA/i.test(line)) { say("354 go on"); data = ""; }
      else if (/^QUIT/i.test(line)) { say("221 bye"); sock.end(); return; }
      else say("250 OK");
    }
  });
  sock.on("error", () => {});
});
await new Promise((r) => smtp.listen(0, "127.0.0.1", r));
const smtpPort = smtp.address().port;
const decoded = (m) => m.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const subject = (m) => /^Subject: (.*)$/m.exec(m)?.[1] ?? "";

// 1. wording
const items = [{ severity: "critical", title: "Drive 1I:3:2 (AL14SEB120N) is Failed", detail: "Prox-1", since: Date.now() / 1000 - 3 * 86400, instanceId: "Prox-1" }, { severity: "warning", title: "Drive 2I:3:5 is hot", detail: "55°C", since: Date.now() / 1000 - 90000, instanceId: "Prox-1" }];
const fresh = E.renderEmail({ severity: "critical", resolved: false, kind: "new", instanceId: "Prox-1", title: items[0].title, lines: [], items: [items[0]] }, "https://lumina.example");
check("a new problem has the severity and the name in the subject", fresh.subject === "[Lumina] CRITICAL: Drive 1I:3:2 (AL14SEB120N) is Failed (Prox-1)", fresh.subject);
check("the email has a link back to Lumina, in both parts", fresh.text.includes("https://lumina.example") && fresh.html.includes('href="https://lumina.example"'));
const fixed = E.renderEmail({ severity: "critical", resolved: true, kind: "resolved", instanceId: "Prox-1", title: items[0].title, lines: [], items: [items[0]] });
check("a fixed problem says it is fixed and how long it took", /Fixed: Drive 1I:3:2/.test(fixed.subject) && /after 3 days/.test(fixed.text), fixed.subject + " | " + fixed.text.split("\n")[0]);
const rem = E.renderEmail({ severity: "critical", resolved: false, kind: "reminder", instanceId: "lumina", title: "x", lines: [], items });
check("the daily reminder counts the problems and says how long each has been there", /2 problems \(1 critical, 1 warning\)/.test(rem.subject) && /since 3 days ago/.test(rem.text), rem.subject);
check("text that came from a device cannot inject markup", !E.renderEmail({ severity: "warning", resolved: false, instanceId: "a", title: "<script>alert(1)</script>", lines: [] }).html.includes("<script>"));

// 2. the daily rule
check("reminder time parsing", E.parseRemindAt(undefined) === 480 && E.parseRemindAt("07:30") === 450 && E.parseRemindAt("off") === null && E.parseRemindAt("25:00") === null);
const at = new Date(2026, 9, 31, 9, 0), before = new Date(2026, 9, 31, 7, 0);
check("a reminder is due once per day, from the chosen time", E.reminderDue(at, 480, null) && !E.reminderDue(before, 480, null) && !E.reminderDue(at, 480, E.localDay(at)) && E.reminderDue(at, 480, "2026-10-30"));
const act = (sev, hoursAgo, extra = {}) => ({ id: 1, instanceId: "Prox-1", key: "k", severity: sev, title: "t", detail: null, since: Date.now() / 1000 - hoursAgo * 3600, suppressed: false, maintenance: null, ...extra });
check("only problems that are still there a day later are repeated", E.persisting([act("critical", 30), act("critical", 2), act("warning", 30), act("critical", 30, { suppressed: true })], "critical", Date.now()).length === 1);
check("a channel set to warnings includes warnings too", E.persisting([act("critical", 30), act("warning", 30), act("info", 30)], "warning", Date.now()).length === 2);

// 3. the reminder runs once a day, against the mail server
const sent = {};
const channel = { id: 7, name: "Mail", type: "email", enabled: true, minSeverity: "critical", config: { host: "127.0.0.1", port: String(smtpPort), security: "none", from: "lumina@test", to: "a@test, b@test", remindAt: "08:00" } };
const store = { channels: { list: () => [channel], recordResult: () => {} }, settings: { get: (k, d) => sent[k] ?? d, set: (k, v) => { sent[k] = v; } } };
const run = E.createReminders(store, () => [act("critical", 30), act("warning", 30)], { warn: () => {} });
await run(before); check("before the chosen time nothing is sent", mails.length === 0);
await run(at); check("at the chosen time one email goes out, with only what the channel asked for", mails.length === 1 && /1 problem/.test(subject(mails[0])), mails.map(subject).join(" | "));
check("it goes to every address", /^To: .*a@test.*b@test/m.test(mails[0]) || /a@test/.test(mails[0]) && /b@test/.test(mails[0]));
await run(new Date(2026, 9, 31, 12, 0)); check("not again the same day", mails.length === 1);
await run(new Date(2026, 10, 1, 8, 5)); check("and again the next day while it is still not fixed", mails.length === 2);
const none = createNone();
function createNone() { return E.createReminders({ ...store, settings: { get: () => null, set: () => {} } }, () => [], { warn: () => {} }); }
mails.length = 0; await none(new Date(2026, 10, 2, 9, 0)); check("nothing to report means no email", mails.length === 0);

// 4. a real server mails a new problem at once
const dir = mkdtempSync(join(tmpdir(), "lumina-mail-"));
const child = spawn("node", [ROOT + "/packages/core/dist/index.js"], { env: { ...process.env, PORT: "3982", LUMINA_DATA: dir, LUMINA_TLS: "off", LOG_LEVEL: "error", LUMINA_STARTUP_GRACE_SECONDS: "0" }, stdio: "ignore" });
const base = "http://127.0.0.1:3982";
try {
  await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 20000);
  let cookie = "";
  const api = async (method, path, b) => {
    const res = await fetch(base + path, { method, headers: { ...(b ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const sc = res.headers.get("set-cookie"); if (sc && !sc.startsWith("lumina_session=;")) cookie = sc.split(";")[0];
    let d = null; try { d = await res.json(); } catch { /* empty */ }
    return { status: res.status, data: d };
  };
  await api("POST", "/api/auth/setup", { username: "boss", password: "correct horse battery", setupCode: readFileSync(join(dir, "setup-code"), "utf8").trim() });
  const types = (await api("GET", "/api/channel-types")).data;
  check("email is offered as a channel type", types.some((t) => t.id === "email"));
  mails.length = 0;
  const made = await api("POST", "/api/channels", { name: "Office mail", type: "email", minSeverity: "critical", enabled: true, config: { host: "127.0.0.1", port: String(smtpPort), security: "none", from: "lumina@test", to: "ops@test", remindAt: "off" } });
  check("the channel is saved", made.status === 201, JSON.stringify(made.data));
  const t = await api("POST", `/api/channels/${made.data.id}/test`);
  check("the test button sends a real email", t.data?.ok === true && mails.length === 1 && /Test notification/.test(subject(mails[0])), JSON.stringify(t.data));
  mails.length = 0;
  await api("POST", "/api/instances", { moduleId: "apcupsd", instanceId: "Gone", config: { host: "127.0.0.1", port: 1 }, pollIntervalSec: 5 });
  check("a device that cannot be reached is mailed at once, as critical", await until(async () => mails.some((m) => /CRITICAL/.test(subject(m)) && /Gone/.test(decoded(m))), 40000), mails.map(subject).join(" | "));
} finally { child.kill(); smtp.close(); }
process.exit(ok ? 0 : 1);
