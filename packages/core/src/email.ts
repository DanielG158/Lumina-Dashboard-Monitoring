import nodemailer from "nodemailer";
import type { ActiveAlert } from "./alerts.js";
import type { ChannelRow, Store } from "./db.js";
import type { Notification, Severity } from "./notify.js";

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
const COLOR: Record<Severity, string> = { info: "#3b82f6", warning: "#d99a1c", critical: "#d6393f" };
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]);

/** "12 min", "3 h 5 min", "2 days" */
export function duration(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

/** " (Prox-1)" unless the title already says it or the message is about Lumina itself */
const at = (inst: string | undefined, title: string) => (!inst || inst === "lumina" || title.includes(inst) ? "" : ` (${inst})`);
const worst = (items: { severity: Severity }[]): Severity => items.reduce<Severity>((w, i) => (RANK[i.severity] > RANK[w] ? i.severity : w), "info");
const count = (items: { severity: Severity }[]) => {
  const c = items.filter((i) => i.severity === "critical").length;
  const w = items.filter((i) => i.severity === "warning").length;
  return [c ? `${c} critical` : "", w ? `${w} warning${w === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
};

export interface Mail { subject: string; text: string; html: string }

/** The subject and body of an email for one notification: a new alert, a daily reminder, or a resolved one. */
export function renderEmail(n: Notification, link?: string): Mail {
  const nowS = Date.now() / 1000;
  const items = n.items?.length ? n.items : [{ severity: n.severity, title: n.title, detail: n.lines.join(" ") || null, since: undefined as number | undefined, instanceId: n.instanceId }];
  let subject: string;
  let heading: string;
  if (n.kind === "reminder") {
    subject = `[Lumina] Still not fixed: ${items.length} problem${items.length === 1 ? "" : "s"} (${count(items)})`;
    heading = `${items.length} problem${items.length === 1 ? " is" : "s are"} still not fixed`;
  } else if (n.resolved) {
    const first = items[0];
    const took = first?.since ? ` after ${duration(nowS - first.since)}` : "";
    subject = items.length === 1 ? `[Lumina] Fixed: ${first.title}${at(first.instanceId ?? n.instanceId, first.title)}` : `[Lumina] Fixed: ${items.length} problems on ${n.instanceId}`;
    heading = items.length === 1 ? `Fixed${took}` : `${items.length} problems are fixed`;
  } else if (items.length === 1) {
    subject = `[Lumina] ${n.severity.toUpperCase()}: ${n.title}${at(n.instanceId, n.title)}`;
    heading = n.severity === "critical" ? "Needs attention now" : n.severity === "warning" ? "Needs attention" : "For your information";
  } else {
    subject = `[Lumina] ${items.length} new problems on ${n.instanceId} (${count(items)})`;
    heading = `${items.length} new problems`;
  }

  const age = (since?: number) => (since && n.kind === "reminder" ? `, since ${duration(nowS - since)} ago` : "");
  const where = (i: { instanceId?: string }) => (i.instanceId && i.instanceId !== "lumina" ? i.instanceId : "");
  const text = [
    heading,
    "",
    ...items.map((i) => `${n.resolved ? "[fixed]" : `[${i.severity.toUpperCase()}]`} ${i.title}${where(i) ? ` - ${where(i)}` : ""}${i.detail ? ` (${i.detail})` : ""}${age(i.since)}`),
    ...(link ? ["", `Open Lumina: ${link}`] : []),
  ].join("\n");

  const accent = n.resolved ? "#2f9e6b" : COLOR[worst(items)];
  const rows = items
    .map((i) => {
      const c = n.resolved ? "#2f9e6b" : COLOR[i.severity];
      return `<tr><td style="padding:8px 12px;border-top:1px solid #e5e7eb;vertical-align:top"><span style="display:inline-block;min-width:62px;padding:2px 8px;border-radius:10px;background:${c};color:#fff;font-size:11px;text-align:center">${n.resolved ? "FIXED" : i.severity.toUpperCase()}</span></td>`
        + `<td style="padding:8px 12px;border-top:1px solid #e5e7eb"><div style="font-size:14px;color:#111827">${esc(i.title)}</div>`
        + `<div style="font-size:12px;color:#6b7280">${[where(i), i.detail ?? "", i.since && n.kind === "reminder" ? `active for ${duration(nowS - i.since)}` : ""].filter(Boolean).map(esc).join(" &middot; ")}</div></td></tr>`;
    })
    .join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">`
    + `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">`
    + `<tr><td style="background:${accent};padding:14px 16px;color:#fff;font-size:16px;font-weight:600">${esc(heading)}</td></tr>`
    + `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>`
    + `<tr><td style="padding:12px 16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">${link ? `<a href="${esc(link)}" style="color:#2563eb">Open Lumina</a> &middot; ` : ""}Sent by Lumina</td></tr>`
    + `</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

const list = (s: string | undefined) => (s ?? "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

export async function sendEmail(c: Record<string, string>, n: Notification): Promise<void> {
  const security = (c.security || "starttls").toLowerCase();
  if (!["starttls", "tls", "none"].includes(security)) throw new Error(`Security must be starttls, tls or none (not "${c.security}")`);
  const to = list(c.to);
  if (!to.length) throw new Error("No recipient address");
  const transport = nodemailer.createTransport({
    host: c.host,
    port: Number(c.port) || (security === "tls" ? 465 : security === "none" ? 25 : 587),
    secure: security === "tls",
    requireTLS: security === "starttls",
    ignoreTLS: security === "none",
    auth: c.username ? { user: c.username, pass: c.password ?? "" } : undefined,
    tls: { rejectUnauthorized: (c.verifyTls || "yes").toLowerCase() !== "no" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    const m = renderEmail(n, c.url || undefined);
    await transport.sendMail({ from: c.from, to, subject: m.subject, text: m.text, html: m.html });
  } finally {
    transport.close();
  }
}

// ---- daily reminders ----------------------------------------------------------------------------------------------

const REMIND_AFTER_MS = 20 * 3600_000;

export const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** "08:00" -> minutes after midnight; null when reminders are switched off or the value makes no sense. */
export function parseRemindAt(v: string | undefined): number | null {
  const s = (v ?? "08:00").trim();
  if (/^(off|no|none|never|0)$/i.test(s)) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** True once per day, from the chosen time on. */
export function reminderDue(now: Date, at: number, lastDay: string | null): boolean {
  return now.getHours() * 60 + now.getMinutes() >= at && lastDay !== localDay(now);
}

/** Problems that have already been announced and are still there a day later. */
export function persisting(active: ActiveAlert[], minSeverity: Severity, nowMs: number): ActiveAlert[] {
  return active.filter((a) => !a.suppressed && RANK[a.severity] >= RANK[minSeverity] && a.since * 1000 <= nowMs - REMIND_AFTER_MS);
}

/** Once a day (at the time set on each email channel) mails whatever is still not fixed. */
export function createReminders(store: Store, active: () => ActiveAlert[], log: { warn: (o: object, m: string) => void }) {
  return async function run(now = new Date()) {
    for (const ch of store.channels.list() as ChannelRow[]) {
      if (ch.type !== "email" || !ch.enabled) continue;
      const at = parseRemindAt(ch.config.remindAt);
      if (at === null) continue;
      const key = `reminder:${ch.id}`;
      if (!reminderDue(now, at, store.settings.get<string | null>(key, null))) continue;
      // Mark the day first: a send that fails is not retried every minute, and a restart never repeats the mail.
      store.settings.set(key, localDay(now));
      const items = persisting(active(), ch.minSeverity, now.getTime());
      if (!items.length) continue;
      const critical = worst(items);
      try {
        await sendEmail(ch.config, {
          severity: critical, resolved: false, kind: "reminder", instanceId: "lumina", title: `${items.length} problems still not fixed`, lines: [],
          items: items.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.since - b.since).map((a) => ({ severity: a.severity, title: a.title, detail: a.detail, since: a.since, instanceId: a.instanceId })),
        });
        store.channels.recordResult(ch.id, null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.channels.recordResult(ch.id, message);
        log.warn({ channel: ch.name, err: message }, "daily reminder failed");
      }
    }
  };
}
