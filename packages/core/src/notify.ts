import { httpRequestRaw } from "@lumina/sdk";
import type { ChannelRow, Store } from "./db.js";

export type Severity = "info" | "warning" | "critical";
const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export interface Notification {
  severity: Severity;
  resolved: boolean;
  title: string;
  lines: string[];
  instanceId: string;
}

export interface ChannelType {
  id: string;
  name: string;
  fields: { key: string; label: string; type: "text" | "password"; required?: boolean; placeholder?: string; help?: string }[];
}

export const CHANNEL_TYPES: ChannelType[] = [
  {
    id: "discord", name: "Discord",
    fields: [{ key: "url", label: "Webhook URL", type: "password", required: true, placeholder: "https://discord.com/api/webhooks/..." }],
  },
  {
    id: "slack", name: "Slack",
    fields: [{ key: "url", label: "Incoming webhook URL", type: "password", required: true, placeholder: "https://hooks.slack.com/services/..." }],
  },
  {
    id: "telegram", name: "Telegram",
    fields: [
      { key: "botToken", label: "Bot token", type: "password", required: true, help: "From @BotFather" },
      { key: "chatId", label: "Chat ID", type: "text", required: true, help: "Your user or group chat ID" },
    ],
  },
  {
    id: "ntfy", name: "ntfy (phone push)",
    fields: [
      { key: "server", label: "Server", type: "text", placeholder: "https://ntfy.sh", help: "Leave empty for ntfy.sh. Install the ntfy app on iOS/Android and subscribe to the topic." },
      { key: "topic", label: "Topic", type: "text", required: true, help: "Pick something hard to guess" },
      { key: "token", label: "Access token (optional)", type: "password" },
    ],
  },
  {
    id: "webhook", name: "Generic webhook (JSON)",
    fields: [
      { key: "url", label: "URL", type: "password", required: true },
      { key: "secret", label: "Authorization header (optional)", type: "password", help: "Sent as-is, e.g. Bearer abc123" },
    ],
  },
];

const COLORS: Record<Severity, number> = { info: 0x3b82f6, warning: 0xf5b740, critical: 0xf2555a };

function headline(n: Notification) {
  return n.resolved ? `RESOLVED: ${n.title}` : `${n.severity.toUpperCase()}: ${n.title}`;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await httpRequestRaw(url, { method: "POST", body, headers, timeoutMs: 10_000 });
  if (res.status >= 300) throw new Error(`HTTP ${res.status} ${res.statusText} ${res.body.slice(0, 160)}`.trim());
}

export async function deliver(ch: Pick<ChannelRow, "type" | "config">, n: Notification): Promise<void> {
  const c = ch.config;
  const text = [headline(n), ...n.lines].join("\n");
  switch (ch.type) {
    case "discord":
      return post(c.url, {
        username: "Lumina",
        embeds: [{ title: headline(n).slice(0, 250), description: n.lines.join("\n").slice(0, 3800) || undefined, color: n.resolved ? 0x3ecf8e : COLORS[n.severity], footer: { text: n.instanceId } }],
      });
    case "slack":
      return post(c.url, { text: `*${headline(n)}*\n${n.lines.join("\n")}`.slice(0, 3500) });
    case "telegram":
      return post(`https://api.telegram.org/bot${c.botToken}/sendMessage`, { chat_id: c.chatId, text: text.slice(0, 4000) });
    case "ntfy": {
      const base = (c.server || "https://ntfy.sh").replace(/\/+$/, "");
      const res = await httpRequestRaw(`${base}/${encodeURIComponent(c.topic)}`, {
        method: "POST",
        body: n.lines.join("\n") || headline(n),
        headers: {
          Title: headline(n).replace(/[^\x20-\x7e]/g, ""),
          Priority: n.resolved ? "default" : n.severity === "critical" ? "urgent" : n.severity === "warning" ? "high" : "default",
          Tags: n.resolved ? "white_check_mark" : n.severity === "critical" ? "rotating_light" : "warning",
          "content-type": "text/plain",
          ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}),
        },
        timeoutMs: 10_000,
      });
      if (res.status >= 300) throw new Error(`HTTP ${res.status} ${res.statusText} ${res.body.slice(0, 160)}`.trim());
      return;
    }
    case "webhook":
      return post(c.url, { source: "lumina", state: n.resolved ? "resolved" : "firing", severity: n.severity, title: n.title, instance: n.instanceId, lines: n.lines, time: new Date().toISOString() }, c.secret ? { Authorization: c.secret } : {});
    default:
      throw new Error(`unknown channel type: ${ch.type}`);
  }
}

export function createNotifier(store: Store, log: { warn: (o: object, m: string) => void }) {
  return {
    async send(n: Notification) {
      for (const ch of store.channels.list()) {
        if (!ch.enabled || RANK[n.severity] < RANK[ch.minSeverity]) continue;
        try {
          await deliver(ch, n);
          store.channels.recordResult(ch.id, null);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          store.channels.recordResult(ch.id, message);
          log.warn({ channel: ch.name, err: message }, "notification failed");
        }
      }
    },
  };
}
