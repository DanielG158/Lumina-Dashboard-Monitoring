# Lumina documentation

Lumina is a homelab dashboard: one screen that shows whether everything is up, with alerts, history charts and a few safe controls.
This document describes what has been built, how it works, how to run and troubleshoot it, and what is still missing.
The original plan is in [design.md](design.md); the security review is in [security-assessment.md](security-assessment.md).

Contents: [1 Status](#1-status-against-the-original-plan) · [2 Architecture](#2-architecture) · [3 Modules](#3-modules) · [4 Alerts and notifications](#4-alerts-and-notifications) · [4b Maintenance, schedules, backups, forecast](#4b-maintenance-scheduled-actions-backup-age-and-storage-forecast) · [4c Energy and cost](#4c-energy-and-cost) · [4e Network](#4e-network-monitoring) · [5 History](#5-history-charts) · [6 Access and security](#6-access-and-security-model) · [7 Using the UI](#7-using-the-web-ui) · [8 Install and operate](#8-install-and-operate) · [9 Configuration](#9-configuration-reference) · [10 API](#10-api-reference) · [11 Troubleshooting](#11-troubleshooting) · [12 Testing](#12-what-was-tested) · [13 Not done](#13-not-done-yet)

---

## 1. Status against the original plan

| Area | Plan | Built |
|---|---|---|
| Proxmox | VM/CT status, CPU/RAM/storage, multi-node, start/stop/reboot | Done, plus node details, storage, disks (SMART health), network, backup jobs, tasks, cluster log, HA, pools, and per-guest **Snapshot** and **Back up now** buttons |
| UPS | apcupsd, NUT, manual | apcupsd done (read-only). NUT and manual are not built, so UPS self-test and calibration are not possible |
| iLO 4 | Power, fans, temperatures, fan control | Done via the Redfish API (no Python bridge needed): power, temperatures, fans, PSUs, RAID drives, CPUs, DIMMs, NICs, firmware, logs. Added power on/off/reset buttons. Fan control is not possible (iLO 4 has no supported API) |
| Uptime Kuma | Monitor status and response time | Done through Kuma's `/metrics` endpoint with an API key |
| Cloudflare | Tunnel status, add/remove/edit hostnames | Done: tunnels, hostname and certificate checks, DNS records, traffic, dynamic DNS, Access logins (section 4h). Only the tunnel part has run against a real account |
| SSH/RDP broker (JumpServer/Guacamole) | Planned | Not started |
| Notifications | Email, FCM/APNs push, Telegram/Discord/Slack | Email (SMTP), Discord, Slack, Telegram, ntfy (phone push) and generic webhook. No FCM or APNs |
| Authentication | LDAP, email, local, rate limiting, timeout | Local accounts with roles, lockout, idle timeout. No LDAP |
| Theming | 4 themes, accent, wallpaper, community themes | 4 themes and accent colour. No wallpaper or theme import |
| Security | Encrypted credentials, audit log, rate limits | All done (see section 6) |
| Observability | Health endpoint, per-module errors, status indicator | Done |
| Mobile app | React Native | Not started; the web UI is responsive instead |
| Deployment | LXC, Docker, installer, setup wizard, auto-update | Installer, systemd service, first-run wizard and Docker files done. No auto-update (re-run the installer) |

Added beyond the plan: a wall-display Overview with auto-fit text and TV mode, alert engine with history, metric history charts, per-instance refresh rate, pause/resume, three access levels with public viewing, HTTPS management in the UI, certificate pinning, passphrase-protected backup and restore, a one-time setup code, and redaction of sensitive details for anonymous viewers.

## 2. Architecture

```
Browser (React UI) ── HTTPS + WebSocket ──▶ Lumina core (Node.js, Fastify, Socket.io, SQLite)
                                                │
                       module registry ─────────┼──▶ Proxmox  (REST API :8006)
                       one poll loop per        ├──▶ iLO 4    (Redfish HTTPS)
                       instance                 ├──▶ apcupsd  (NIS TCP :3551)
                                                ├──▶ Uptime Kuma (/metrics)
                                                └──▶ Cloudflare (REST API)
```

**Flow.** Each configured instance of a module is polled on its own timer. Every poll returns data, the module's current alert conditions
and a few numbers for charts. The core stores the numbers, runs the alert engine, and pushes the update to every open browser over a
WebSocket. Signed-in browsers get full data; anonymous viewers get a redacted copy.

**Repository layout** (pnpm monorepo, TypeScript throughout)

| Path | Purpose |
|---|---|
| `packages/sdk` | The contract every module implements (`defineModule`), plus an HTTP helper with certificate pinning |
| `packages/core` | The server: `index.ts` (routes, hooks), `registry.ts` (poll loops), `alerts.ts`, `notify.ts`, `metrics.ts`, `auth.ts`, `db.ts` (SQLite), `crypto.ts`, `redact.ts`, `config.ts`, `tls.ts`, `backup.ts`, `setup-code.ts` |
| `packages/modules/*` | `proxmox`, `apcupsd`, `ilo4`, `cloudflare`, `uptime-kuma` |
| `packages/ui` | The React web UI (Vite). `pages/` (Overview, Instances, Alerts, Settings, Audit) and `components/` |
| `install.sh` | Installer and upgrader for Debian/Ubuntu |
| `scripts/` | `deploy-local.sh` (developer deploy), `reset-password.mjs` |
| `Dockerfile`, `docker-compose.yml` | Container deployment (not tested here) |

**Writing a module.** Export `defineModule({ id, name, fields, configSchema, pollIntervalMs, create })`. `create()` returns `poll()`,
`status()`, `actions[]` and optionally `alerts(data)` and `metrics(data)`. `fields` describes the add/edit form, so the UI builds it
automatically. An action can set `minRole: "admin"`. `alerts()` may return `{ conditions, unknown }` to say which alert keys it cannot
judge yet (for example data still loading), so those are left alone instead of being resolved.

## 3. Modules

Refresh rates: default and the lowest an admin may choose. Each instance can override its rate (Instances, Edit).

| Module | Default / minimum | Needs |
|---|---|---|
| Proxmox VE | 10 s / 5 s | Host URL, API token ID and secret, optional certificate fingerprint |
| apcupsd | 10 s / 2 s | Host and port 3551; `NETSERVER on` and a suitable `NISIP` in `apcupsd.conf` |
| HP iLO 4 | 15 s / 10 s | iLO URL, username, password (firmware 2.30 or newer for Redfish) |
| Uptime Kuma | 15 s / 5 s | URL and an API key (Settings, API Keys) |
| Cloudflare | 30 s / 10 s | API token (Account, Cloudflare Tunnel, Edit; more permissions for the optional parts, see 4h), account ID, optional zone ID |

**Proxmox.** Reads nodes, guests, storage, disks with SMART health, network, backup jobs, recent tasks, cluster log, HA and pools; each
endpoint is read separately so a missing permission only hides that section. Actions: start, stop, reboot, **snapshot** and **back up now** for each VM and container (not templates). Snapshot asks for an optional name (otherwise `lumina-<date>-<time>`) and description; for VMs the running memory is not included. Back up now asks for a backup-capable storage (shown with its usage and free space, with a warning at 90% full) and a mode: snapshot (no downtime, the default), suspend or stop. Backups use zstd compression. Progress and results appear under Recent tasks, and a failed backup raises an alert. Proxmox's own error text is shown when something is refused (for example a duplicate snapshot name). The token needs a
role on `/` for the user and, if privilege separation is on, for the token too.

**iLO 4.** The iLO web server drops overlapping connections, so all requests go through one queue with retries. Slow data (drives,
CPUs, DIMMs, NICs, firmware, logs) loads in the background and is cached, so the live poll stays quick. Actions: Power on, Shut down
(a power-button press, so the OS shuts itself down), Hard reset, Force off. Each action checks the current power state first, and
commands are never retried.

**apcupsd.** Speaks the NIS protocol directly. Reports status, battery, load, runtime, voltages and last self-test result.

**Uptime Kuma.** Parses the Prometheus metrics (status, response time, certificate days).

**Cloudflare.** Lists tunnels and their public hostnames; admins can add, edit and remove hostnames (and the matching DNS record when a zone ID is set). See section 4h for hostname checks, DNS records, traffic, dynamic DNS and Access logins.

### Alert conditions and chart metrics per module

| Module | Alerts | Chart metrics |
|---|---|---|
| Proxmox | node offline, node memory over 95%, quorum lost, storage over 90% / 97% or unavailable, disk SMART failing, SSD worn out, a guest that was running stops unexpectedly, backup failed or warned in the last day | CPU, memory and root disk per node, running/total guests, storage use |
| iLO | server health not OK, powered off, CPU/memory health, temperature at 90% / 100% of its limit, fan or PSU fault, RAID controller or drive fault or over 55 degrees, a RAID volume that is degraded, failed or rebuilding (with the percentage when the iLO gives one), DIMM fault, iLO self-test failed, warning/critical hardware log entries in the last 3 days | power draw, hottest and inlet temperature, average fan speed, hottest drive |
| apcupsd | communication lost, on battery, battery low, replace battery, load 85% or more, self-test failed | load, battery, runtime, input voltage, estimated watts |
| Uptime Kuma | monitor down, certificate expiring or expired | monitors up/down, average and per-monitor response time |
| Cloudflare | tunnel down, degraded or reconnecting again and again; a hostname not resolving, answering with HTTP 5xx or not answering; a certificate expiring (14 and 3 days); dynamic DNS failing; 10 or more refused Access logins in an hour | healthy/total tunnels, connections per tunnel, hostnames up, days until the soonest certificate expires, refused Access logins |

Every instance also gets an **unreachable** alert after 3 failed polls in a row. A stop you trigger from Lumina is not "unexpected".

## 4. Alerts and notifications

- An alert is raised when a condition is seen on **2 polls in a row** (adjustable, Settings, General) and resolved when it has gone for 2.
- Alerts that were active survive a restart without re-notifying. Disabling or removing an instance closes its alerts quietly.
- Several alerts from one poll go out as one message. **Mute** (operator or admin) stops raising and notifying a given alert; unmute in the Alerts tab.
- Active alerts show on the instance card, the Overview ("Needs attention"), the Alerts tab (with history) and in the browser tab title, e.g. `(2) Lumina`.

Notification channels (Settings, Notifications, admin only): **Email (SMTP)**, **Discord**, **Slack**, **Telegram**, **ntfy** (push to the ntfy phone app,
iOS and Android), and a **generic webhook** (JSON). Each channel has a minimum severity (everything, warnings and up, critical only),
a "Send test" button, and shows its last error. Webhook URLs and tokens are stored encrypted and never sent back to the browser.

**Email.** Fields: SMTP server, port, security (`starttls` default, `tls` or `none`), optional username and password, from address, one or more
recipients, the daily reminder time, an optional link to Lumina and whether to check the server certificate. A new problem is mailed as soon as
it is confirmed (after the usual number of polls); a message groups the problems of one device. A problem that is still there at least 20 hours
later is mailed again once a day at the reminder time, as one email listing everything still not fixed with how long each has lasted, and
nothing is sent on days when nothing is outstanding. When a problem is fixed a "Fixed" email says how long it took. The reminder day is stored,
so a restart never repeats the email. The minimum severity of the channel decides what is mailed (choose *Critical only* to hear only about
failed parts). Problems inside a maintenance window are left out of the reminder. The SMTP password is stored encrypted.

## 4b. Maintenance, scheduled actions, backup age and storage forecast

**Maintenance windows** (Maintenance tab). While a window covers an instance (or everything), its alerts are still recorded and shown, marked "in maintenance", but **nobody is notified**. When a window ends, anything still wrong is reported then ("still active after maintenance"), so nothing is lost; a problem that comes and goes entirely inside a window sends nothing. Operators can start a window now (15 min to a custom length) and end it early. Admins can schedule one-off or repeating (daily or weekly) windows. Ending a repeating window early skips only that occurrence. Repeating windows repeat every 24 hours or 7 days from their first start, so a daylight-saving change would shift them by an hour. Shutting down, or hard-resetting, the server from the iLO card automatically opens a 30-minute window for everything.

**Scheduled actions** (Maintenance tab, admins). Run an action at a time or on a repeat: snapshot, backup, start, stop or reboot a VM or container, or iLO power on or a graceful shutdown. Hard resets cannot be scheduled. Each run is recorded (result, or Proxmox's reason for failing), written to the audit log as "scheduler", and a failure sends a notification. A run that is more than 30 minutes late (1 hour for one-offs), for example because Lumina was restarting, is skipped, not made up later.

**Backup age.** The Proxmox card has a "Last backup" column read from your backup storages (cached 10 minutes). The Overview shows a "Backups fresh" tile. Two settings per Proxmox instance: the age that counts as stale (default 8 days, 0 turns it off) and guest IDs that need no backups. A warning is raised for a guest whose newest backup is older than the limit, or that is in a backup job but has no backup file. Guests not in any job are shown as "not in a job" and do not raise alerts. Admins can switch the whole check off or on with the button above the guest list (it sets the age to 0 or back to 8); the open stale/missing-backup alerts of that server are closed without a "fixed" message for each, and failed backup jobs are still reported.

**Storage forecast.** From each volume's history (last 14 days, hourly averages) Lumina fits a straight line and estimates when it will be full. It is shown on the Overview ("full in ~N days") and in the Proxmox storage table, and raises a warning when it is within 14 days (adjustable in Settings, General), critical within 3. It needs about two days of history, and it says "no clear trend" when usage goes up and down (a weekly backup volume that fills and is pruned fits a line poorly).

## 4c. Energy and cost

The Energy tab turns the power readings Lumina already records into kWh and money.

**Sources.** The UPS reports its load as a percentage; Lumina multiplies it by the rated power to get watts. It covers everything plugged into the UPS, but it is an estimate (typically ±10%) and leaves out the UPS's own losses. The iLO reads the server's power supplies directly (accurate to a few percent) but covers only the server. "Automatic" prefers the UPS; you can pick either. When both exist, the page shows how much of the total is the server and how much is everything else on the UPS.

**Accuracy.** Readings are taken every few seconds, averaged per minute and kept as 30-minute averages for years (long after the minute-by-minute history is purged). That is accurate for energy. The largest error is missing data (Lumina or the device offline), so the page shows how much was actually measured. Gaps shorter than a limit (48 hours by default) are estimated from the typical power for that hour of day and labelled as estimated; you can turn that off. Two adjustments fix the rest: a **calibration factor** and **extra watts** for equipment Lumina cannot see. The **Calibrate against your meter** helper compares Lumina's measurement over a few days with two readings of your electricity meter and suggests the factor.

**Prices** (Energy, Prices and settings, admins). Everything is adjustable and nothing is hard-coded:
- **Tariff:** one flat price per kWh (default Rp 1,661); **time-of-day** rules (days, start and end time, price, overnight rules supported, first match wins, plus a default price); or **progressive blocks** per billing cycle (for example the first 900 kWh at one price, the rest at another).
- **Fixed monthly charge**, **tax or levy %** (applied to energy plus the fixed charge), **billing cycle start day** (1 to 28) and an optional **monthly budget** that raises an alert when exceeded or on course to be.
- **Currency:** symbol, code, number format (for example id-ID or en-US), decimals and symbol position.
- **Time zone** (decides when a day starts and which hours are night). It is set from your browser the first time an admin opens the page.
- **Preview** shows what the usage would have cost with unsaved settings, next to the saved settings, without saving.

Periods: today, yesterday, 7 days, 30 days, this billing cycle (with a month-end projection) and last cycle. The monthly fee and tax appear only in billing-cycle views.

## 4d. Watching another Lumina (two sites)

If you run Lumina in more than one place (say, home and an office), one of them can show the other, so you do not need a VPN session just to see whether things are healthy.

1. On the **remote** Lumina (the office), open **Settings → Access tokens → New token**, name it (for example "Home Lumina") and copy the token. It is shown once.
2. On **this** Lumina (home), **Instances → Add → Another Lumina**. Enter the office address (for example `https://192.168.0.171`), a name for its alerts (for example "Office"), and the token. Use **Detect** to pin its certificate if it uses a self-signed one.
3. The card lists the office's devices with their status and the office's active alerts. Those alerts are also raised here, with the name in front ("Office: Drive 1I:3:4 is Critical"), so your notification channels cover both sites. If the office cannot be reached, you get an "unreachable" alert.

**What a token allows:** reading what an anonymous visitor could see (device status and numbers, alerts, history), even when public viewing is off. It cannot change anything and cannot read users, logs, settings, serial numbers or addresses. Revoke it at any time; the other Lumina stops working immediately. Tokens are stored only as a hash.

**Network:** this Lumina must be able to reach the other one. A site-to-site VPN, a Cloudflare Tunnel (put the tunnel's address in step 2), or a reverse proxy with HTTPS all work. If you expose it to the internet, turn off public viewing on that Lumina and rely on the token. Do not forward a plain-HTTP port to the internet.

Two Luminas can watch each other: devices and alerts that came from another Lumina are never passed on again, so alerts do not bounce back and forth.

## 4e. Network monitoring

Two modules, both added under **Instances → Add**:

**Network checks** (`netcheck`). Build the list in a form (name, type, address, and a port or DNS server where needed), on the Add dialog or later under **Network → Edit checks**. Underneath it is stored as one line per check, `Name | type | address`, which is what the examples below show:

```
Gateway      | ping | 192.168.1.1
Internet     | ping | 1.1.1.1
DNS          | dns  | example.com @192.168.1.1
Proxmox web  | tcp  | 192.168.1.10:8006
Website      | http | https://example.com
```

Each poll sends a few pings (default 4) and records the average latency, jitter and **packet loss**; TCP, DNS and web checks record how long they took. History charts, a "recent loss" figure over the last 20 polls, and alerts for a target that stops answering, loses packets (default 20% or more) or is slow (default 150 ms or more) come with it. Pick a check interval per instance (10 seconds up to minutes).

*Internet speed test (optional, off by default).* Tick it and Lumina downloads and uploads test data every few hours (default 6) to the addresses you set (the defaults use Cloudflare's public speed test), keeps a history, and can warn when the download falls below a limit you choose. It uses your internet connection and tells that service your address, which is why it is opt-in. Operators get a **Run speed test now** button.

*The Network tab.* One page for everything network: a summary (checks up, average latency and loss, last speed test, links up), the **Internet speed** panel with its settings, chart, results table and a *Run speed test now* button, the latency and packet-loss table with trends, and the SNMP links. Speeds can be shown in Mbit/s or MB/s with the switch at the top.

*Pings and permissions.* Lumina sends pings as an unprivileged user. The installer allows that (`net.ipv4.ping_group_range`). If the card says pings are not allowed (some containers refuse the setting), it shows the one command to run; TCP, DNS and web checks work regardless.

**Router / switch (SNMP)** (`snmp`). Reads any device that speaks SNMP: per-interface status, speed, traffic in and out (from the 64-bit counters, so fast links are accurate), errors, plus uptime and, where the device offers it, load and memory. Name the links that matter under *Interfaces to alert on* (for example `igb0, wan`): those raise a critical alert when the link goes down, and unused down ports are hidden. A link above 90% of its speed raises a warning. SNMP version 3 (authenticated and encrypted) is supported and preferred; version 2c sends its community in clear text, so allow only this Lumina's address on the device.

Switching SNMP on (menu names vary by version):

- **pfSense:** Services → SNMP. Enable, set a community, bind to the LAN interface, keep "MibII" on.
- **OPNsense:** System → Firmware → Plugins, install `os-net-snmp`; then Services → Net-SNMP: enable, set the community, listen on LAN.
- **OpenWrt:** `opkg update && opkg install snmpd`, then set the community in `/etc/config/snmpd` (or the LuCI SNMP page) and restart `snmpd`.
- **Unmanaged switches** have no SNMP. Use ping checks for them, and read the router port they connect to.

## 4f. TP-Link Omada

The `omada` module logs in to an Omada controller's web interface (the same login the browser uses: a session cookie plus a CSRF token) with a Viewer account and reads the sites the account can see, and each site's device list. It was written against the behaviour of controller versions 5.1 to 6.x as documented by the open-source `tplink-omada-client` project, and tested here against a fake controller that behaves that way, not yet against a real one. It re-logs in by itself when the controller drops the session. Not covered yet: gateway WAN throughput, per-port switch status and the controller's own alert list; the Omada OpenAPI (client-credentials) login is not used yet.

## 4g. TP-Link Archer routers

The `tplink-router` module signs in to the admin page of a TP-Link Archer router (AX and C series with the "luci" interface), reads `admin/status?form=all` (internet address, CPU and memory, connected devices) and the firmware page, then signs out. Two firmware generations are handled and chosen automatically: an RSA-encrypted password with an AES-encrypted, signed conversation, and the newer RSA-only variant with JSON bodies. Safety rules: it never tries a wrong password more than once per 10 minutes; it signs out after every reading so the router's single admin session is free; if someone else is signed in it keeps the last reading. Not read: per-client traffic, Wi-Fi settings, anything that changes the router.

## 4h. Cloudflare

The `cloudflare` module talks to the Cloudflare API with one API token. Each part below needs its own token permission and has its own cache, so a missing permission is shown on the card as a one-line note and never stops the rest.

| Part | Token permission | Needs | Cache |
|---|---|---|---|
| Tunnels, hostname editing | Account, Cloudflare Tunnel, Edit | account ID | every poll |
| DNS records (list, add, edit, proxy on/off, delete) | Zone, DNS, Edit (Read to only look) | zone ID | 60 s |
| Traffic for 7 days (GraphQL analytics) | Zone, Analytics, Read | zone ID | 5 min |
| Access logins | Account, Access: Audit Logs, Read | Zero Trust switched on | 2 min |
| Dynamic DNS | Zone, DNS, Edit | zone ID, existing A/AAAA record | public IP read every 2 min |

**Hostname checks.** Every 5 minutes Lumina checks up to 40 hostnames: those in the ingress rules of dashboard-managed tunnels, DNS records that point at a tunnel (this is how a locally managed tunnel's hostnames are found), other proxied A/AAAA/CNAME records, and the names typed into *Other hostnames to check*. Each check does a DNS lookup, one HTTPS `HEAD /` request (no redirects followed) and reads the certificate's end date. The certificate is not rejected when untrusted, so its dates can always be read; whether a trusted authority signed it is recorded separately. Checks run in the background: a poll waits at most 2.5 seconds for them.

**Alerts.** `tunnel:` down (critical) or degraded (warning); `flap:` a tunnel whose connection list gained new connections in three or more separate 2-minute stretches within 15 minutes (one `cloudflared` restart is one stretch); `host-dns:` name does not resolve (warning); `host-down:` no HTTPS answer (critical) or HTTP 5xx (warning); `cert:` 14 days or fewer left (warning), 3 or fewer or expired (critical); `ddns:` dynamic DNS could not update, or the record is missing (warning); `access-denied:` 10 or more refused Access logins in the last hour (warning).

**Dynamic DNS.** Off unless hostnames are typed into the second text field. The public IP comes from Cloudflare's own trace page (`/cdn-cgi/trace`). A record is rewritten only if it already exists, is of type A (or AAAA for an IPv6 address) and has a different address; Lumina never creates records this way. Behind a VPN or proxy the address found is not your home address, so leave this off there.

**Actions (admin only):** `add-endpoint`, `edit-endpoint`, `remove-endpoint` (tunnel hostnames), `dns-add`, `dns-edit` (content and/or proxy), `dns-remove` (marked dangerous). DNS content is checked before sending: an A record needs an IPv4 address, an AAAA an IPv6 one.

**Anonymous viewers** see tunnels, hostname results, traffic and the refused-login count. Record contents, resolved addresses, the public IP and Access log rows (e-mails, IPs) are removed.

**Chart metrics:** `tunnels:healthy`, `tunnels:total`, `connections:<tunnel>`, `hostnames:up`, `hostnames:total`, `cert:min-days`, `access:denied1h`.

**For the tests only:** the environment variables `LUMINA_CLOUDFLARE_API` and `LUMINA_CLOUDFLARE_CHECK_PORT` point the module at a fake API and a local HTTPS port. They are not meant for normal use.

## 5. History (charts)

One averaged sample per minute per metric is stored in SQLite and kept for 14 days (adjustable). Overview tiles show a trend line;
each instance card has a **History** section with a metric picker and 1 h / 6 h / 24 h / 7 d ranges, a hover read-out, and min / average / max.

## 6. Access and security model

| Who | Can |
|---|---|
| **Anyone** (no login) | View the dashboard, history and alerts, with sensitive details removed |
| **Operator** | Start, stop, reboot, snapshot and back up guests; iLO power buttons; refresh now; mute alerts; start and end maintenance; view scheduled actions; change own password |
| **Admin** | Everything: add, edit, pause, reorder and remove instances; Cloudflare hostnames; users; notification channels; settings; electricity prices; maintenance schedules and scheduled actions; HTTPS and certificates; backup and restore; audit log |

- **Public viewing** can be switched off (Settings, General); then every page needs a sign-in. Recommended if Lumina is reachable from the internet.
- Anonymous viewers do not see logs, tasks, serial numbers, MAC addresses, internal URLs or raw error text.
- **Open access** ("Skip" on the first-run screen) makes everyone an admin until the first account is created. A warning banner shows meanwhile.
- **First run:** a one-time setup code (printed by the installer, also in `/var/lib/lumina/setup-code` and the service log) is needed to create the first admin, skip setup, or restore. It is deleted once an account exists.
- **Passwords** are hashed with scrypt. Sign-in is limited (20/min per address; 5 failures per user or 10 per address locks for 10 minutes). Sessions are random tokens stored hashed, in an HttpOnly, SameSite cookie (Secure over HTTPS), with an idle timeout (default 8 h) and a 7-day maximum.
- **Credentials** for Proxmox, iLO and the rest are encrypted at rest (AES-256-GCM). The key is `lumina.key` in the data folder (mode 0600) or `LUMINA_SECRET_KEY`.
- **Certificate pinning:** for devices with self-signed certificates, paste (or "Detect") the certificate fingerprint and Lumina only talks to a device presenting exactly that certificate.
- **Audit log** (admin): sign-ins, failures, lockouts, every action, and every configuration change, with who and from where.
- Cross-site requests are refused, API responses are not cached, and a strict content-security policy is sent. See [security-assessment.md](security-assessment.md).

## 7. Using the web UI

| Tab | What it is |
|---|---|
| **Overview** | The wall display. A status banner, up to 8 key tiles (devices online, active alerts, guests running, host load, server power, UPS, monitors, tunnels, fullest storage), every VM and container as a chip, every monitor, storage bars, alerts, devices, recent activity. It fits one screen and picks the largest text size that fits |
| **Instances** | One card per module instance, collapsed to a single summary line. Open a card for full detail and history. Buttons (by role): refresh, pause/resume, move, edit, remove. Admins add modules here |
| **Alerts** | Active alerts, muted alerts, history |
| **Energy** | kWh and cost for today, yesterday, 7 and 30 days and the billing cycle, a bar chart, where the power goes, a typical day, and (admins) all the price settings |
| **Maintenance** | Start or schedule maintenance windows; scheduled actions |
| **Settings** | General (public viewing, timeout, alert confirmation, history length), Server and HTTPS, Notifications, Users, Backup and restore, My account |
| **Audit log** | Admin only |

- **TV mode** (header button, or open `#/tv`): fullscreen, no menus, keeps the screen awake. Press **Esc**, or hover the bottom-right corner and click "Exit TV mode", to leave.
- **Burn-in protection** (Theme menu, per browser): every 15 seconds (10, 15, 30 or 60) the Overview fades, rearranges and fades back in, so a screen left on all day never shows the same picture for long. It shuffles the status tiles, the order of the panels, which side the two columns are on, whether the banner is at the top or bottom, and nudges everything a few pixels. It never repeats the previous arrangement, and the text size re-fits after every change. Modes: TV mode only (default), Overview and TV mode, or Off.
- **Theme** (header): Dark, Light, Catppuccin, Nord, plus an accent colour. Saved in that browser.
- Works on phones: the layout stacks and scrolls normally on narrow screens.

### Several hosts and servers

Nothing is limited to one Proxmox node or one iLO.

- **Overview, Proxmox:** with two or more nodes the *Host load* tile shows the average and names the busiest node, and its colour follows the worst node, not the average. A **Hosts** panel lists each node with CPU, RAM and guests running. Stopped guests, and storage rows, name the node they belong to. A stopped guest only shows as a crash if its own host raised the alert, so two hosts that both have a VM 101 are not confused.
- **Overview, iLO:** with two or more servers the *Server power* tile adds up the draw and names any server that is unhealthy or off. A **Servers** panel lists each one (power, inlet temperature, health). Both iLO modules (Redfish and SNMP) count. With one server nothing changes.
- **On a small TV** the wall display still fits on one screen; the new panels give way last, after the text shrinks and the alert list is shortened.
- **Instances:** with four or more instances a bar appears with a search box, one chip per kind of module with its count, a *Needs attention* chip (an instance that is unreachable or has an alert), and *Collapse all* / *Expand all*. Moving a card up or down moves it in the full list even while a filter is on.
- **Adding:** a new instance starts with a free name ("HPE iLO (4 and 5)", then "... 2") so a second server is one click.

## 8. Install and operate

### Install

```bash
sudo ./install.sh                        # from a local copy of the repo
sudo LUMINA_SRC=/path/to/lumina ./install.sh
sudo ./install.sh --import-db old.db     # bring an existing database along
sudo ./install.sh --http                 # plain HTTP on 8080 instead of HTTPS on 443
```

The installer installs Node 22, builds Lumina in `/opt/lumina` (root-owned), creates the `lumina` system user, prepares
`/var/lib/lumina`, writes a sandboxed systemd service, and waits for it to answer. By default it serves **HTTPS on 443** with an
automatic self-signed certificate (covering the hostname and IP addresses) and redirects port 80. It prints the setup code.
Open the address, create the admin account (or choose **Restore from backup**), then add modules in the UI.

**Upgrade:** run the installer again; data is kept. **Developer shortcut:** `scripts/deploy-local.sh` builds and copies only the compiled output, then restarts.

### Where things are

| Item | Location |
|---|---|
| Code | `/opt/lumina` |
| Data folder | `/var/lib/lumina` (private to the `lumina` user) |
| Service | `lumina.service` (`systemctl status lumina`, `journalctl -u lumina -f`) |
| Database and key | `lumina.db`, `lumina.key` |
| Server settings | `config.json` (written by the UI) |
| Certificates | `tls/` (`lumina.crt`/`.key` automatic; `custom.crt`/`.key` uploaded) |
| Setup code | `setup-code` (only until the first account exists) |
| Restore staging and old data | `restore/`, `backups/before-restore-*` |

### Backup, restore and moving to another machine

- **Backup:** Settings, Backup and restore, choose a passphrase, download. The file holds modules, credentials, users, channels, settings and the encryption key, encrypted with that passphrase. Chart history is optional.
- **Restore:** upload the file and enter the passphrase, then restart. The previous data is kept in `backups/`.
- **New machine:** run the installer there, open the page, choose **Restore from backup** on the first screen (it asks for the setup code). Or copy `lumina.db` and `lumina.key` into the data folder before starting the service.

### HTTPS and ports

Settings, Server and HTTPS: choose Off, Automatic (self-signed) or your own certificate (paste PEM and key), set the port and the HTTP redirect port, then **Restart**. If the new settings stop Lumina from starting, they are moved to `config.json.failed` and it starts with defaults on the next attempt. Browsers warn about the self-signed certificate once; use your own certificate or a Cloudflare tunnel for a trusted address. Ports below 1024 work because the service has permission to bind them.

### Day-to-day

```bash
systemctl status lumina          # is it running
journalctl -u lumina -f          # live log
systemctl restart lumina
sudo -u lumina LUMINA_DATA=/var/lib/lumina node /opt/lumina/scripts/reset-password.mjs admin   # lost password
```

## 9. Configuration reference

Most settings are in the UI. Environment variables (e.g. in a systemd drop-in) override the file and lock that field in the UI.

| Variable | Meaning | Default |
|---|---|---|
| `LUMINA_DATA` | Data folder | `./data` (service: `/var/lib/lumina`) |
| `LUMINA_DB` | Database path (also sets the data folder if `LUMINA_DATA` is unset) | `<data>/lumina.db` |
| `PORT` | Listening port | 3000 (service: 443) |
| `LUMINA_TLS` | `auto`, `off`, `custom` | `off` (service: `auto`) |
| `LUMINA_TLS_CERT`, `LUMINA_TLS_KEY` | Paths to your own certificate and key | none |
| `LUMINA_TLS_NAMES` | Extra names/IPs for the automatic certificate | none |
| `LUMINA_HTTP_REDIRECT_PORT` | Port that redirects to HTTPS (0 = off) | 0 (service: 80) |
| `LUMINA_HSTS` | `1` to send HSTS (only with a trusted certificate) | off |
| `LUMINA_SECRET_KEY` | Encryption secret instead of the key file | key file |
| `LUMINA_UI_DIR` | Where the built UI is | `packages/ui/dist` |
| `LUMINA_TRUST_PROXY` | `1` to trust forwarded client addresses (behind a reverse proxy or tunnel) | off |
| `LUMINA_RESTART` | `1` if something restarts Lumina when it exits (enables the Restart button) | set by systemd |
| `LUMINA_STARTUP_GRACE_SECONDS` | After a boot, how long nothing is called "unreachable" (the network may not be up yet). 0 switches it off | 120 when the machine booted less than 10 minutes ago, otherwise 0 |
| `LOG_LEVEL` | `info`, `warn`, `debug` | `info` |

Settings stored in the database (Settings, General): public viewing (on), sign-in timeout (480 min), alert confirmation (2 polls), history length (14 days), storage-forecast warning (14 days). Electricity settings are stored separately (Energy, Prices and settings).

## 10. API reference

All paths are under the same address. `anon` = no sign-in needed (only while public viewing is on); `op` = operator or admin; `admin` = admin.
State-changing requests must be same-origin JSON.

| Method and path | Who | Purpose |
|---|---|---|
| `GET /health` | anyone | Liveness (`ok`, `uptime`) |
| `GET /api/auth/status` | anyone | Setup state, current user, public view |
| `POST /api/auth/setup`, `/skip-setup`, `/restore` | anyone, first run only, setup code | Create first admin, skip, restore |
| `POST /api/auth/login`, `/logout`, `/password` | anyone / signed in | Session handling |
| `GET /api/modules` | anon | Module list with form fields |
| `GET /api/instances` | anon (redacted) | All instances with live data |
| `POST /api/instances` | admin | Add an instance |
| `GET`/`PUT`/`DELETE /api/instances/:id` (`/config`) | admin | Read settings (secrets hidden), edit, remove |
| `POST /api/instances/:id/enabled` | admin | Pause or resume |
| `PUT /api/instances-order` | admin | Reorder |
| `POST /api/instances/:id/refresh` | op | Poll now |
| `POST /api/instances/:id/actions/:action` | op (some admin) | Run an action |
| `GET /api/instances/:id/metrics`, `/metric-keys` | anon | History |
| `GET /api/alerts`; `POST`/`DELETE /api/alerts/mute` | anon; op | Alerts and muting |
| `GET /api/maintenance` | anon (notes hidden) | Running and upcoming windows |
| `POST /api/maintenance/start`, `/api/maintenance/:id/end` | op | Start now, end early |
| `POST /api/maintenance`, `PUT`/`DELETE /api/maintenance/:id` | admin | Scheduled windows |
| `GET /api/schedules`; `GET /api/schedule-targets`; `POST /api/schedules`, `PUT`/`DELETE /api/schedules/:id`, `POST .../enabled`, `POST .../run-now` | op (read); admin | Scheduled actions |
| `GET /api/energy?range=` | anon | kWh and cost for a period |
| `GET`/`PUT /api/energy/settings`, `POST /api/energy/preview`, `POST /api/energy/calibrate` | admin | Prices, preview, meter calibration |
| `GET /api/forecast` | anon | Storage forecasts |
| `GET`/`POST /api/channels`, `PUT`/`DELETE /api/channels/:id`, `POST .../test`, `GET /api/channel-types` | admin | Notification channels |
| `GET`/`POST /api/users`, `PUT`/`DELETE /api/users/:id` | admin | Accounts |
| `GET`/`PUT /api/settings` | admin | General settings |
| `GET`/`PUT /api/server`, `POST /api/server/certificate`, `/restart` | admin | Ports, HTTPS, certificate, restart |
| `POST /api/backup`, `/api/restore` | admin | Backup and restore |
| `POST /api/probe-fingerprint` | admin | Read a device's certificate fingerprint |
| `GET /api/audit` | admin | Audit log |

Realtime: Socket.io on the same address sends `snapshot`, `module:update`, `alerts:changed` and `instances:reordered`.

## 11. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Many devices "unreachable" at the same minute, then fine again | Lumina's own network was gone: the router (often also the DNS server) restarted, or the machine Lumina runs on was just booted. Errors like `EAI_AGAIN` (DNS), `EHOSTUNREACH` and `ENETUNREACH` point at this. For two minutes after a boot nothing is called unreachable. For a router restart, check its uptime |
| **SNMP version 3: "outside the time window"** | The device restarted and its clock no longer matches the session's. Lumina starts a fresh session by itself; on an older copy, restart Lumina once |
| Card says "Can't reach this service" | The card shows the real error (admins). Check the address and credentials with Edit |
| **APCUPS: connection refused** on a different subnet | A firewall rejected it; allow Lumina's IP to the UPS host on TCP 3551. On the UPS host set `NETSERVER on` and `NISIP` to an address the dashboard can reach. If `NISIP` is its own IP, give that host a DHCP reservation |
| **Uptime Kuma: "wrong version number"** | The URL says `https://` but the port is plain HTTP; use `http://` |
| **Proxmox card shows "no permissions"** or NaN | Give the token's user a role at `/` with Propagate, and the token too if privilege separation is on |
| **Proxmox: 401** | Token ID must be `user@realm!tokenname` and the secret current |
| **iLO: "socket hang up"** | iLO 4 drops overlapping connections; Lumina queues and retries. If it persists, raise the refresh interval |
| Browser warns about the certificate | Expected with the automatic certificate. Accept once, upload your own, or use a tunnel |
| Locked out or forgot the admin password | `reset-password.mjs` (section 8). Or restore from a backup |
| Wrong port or HTTPS settings, cannot reach the page | The service falls back to defaults after a failed start; otherwise edit or remove `/var/lib/lumina/config.json` and restart |
| Lost the setup code | `cat /var/lib/lumina/setup-code` on the server |
| Restart button missing | Lumina found no service manager; restart it yourself (`systemctl restart lumina`) |
| An alert you do not care about | Mute it in the Alerts tab |

## 12. Tests

The tests live in `tests/` and run with `pnpm test` (everything, needs Chromium) or `pnpm test:fast` (no browser). They start a real Lumina against fake devices and a temporary data folder, so they never touch your own data.

- **api.test.mjs:** sign-in and roles, instance add/edit/remove, poll-rate limits, notifications arriving at a webhook, alerts firing and resolving, unreachable detection, metrics, lockout, public-viewing switch, audit log, encryption at rest.
- **features.test.mjs:** maintenance windows, scheduled actions, backup freshness, storage forecast, and the energy engine (tariffs, gap filling, billing cycles, calibration, custom date ranges).
- **guest-cost.test.mjs:** how the server's electricity is split between guests, with hand-calculated answers.
- **security.test.mjs:** setup code, a permission matrix over every API route, cross-site posts, injection payloads, size limits, error leakage, headers, redaction over HTTP and WebSocket, an XSS payload rendered in a real browser, file permissions, no secrets in logs.
- **cloudflare.test.mjs, cloudflare-ui.test.mjs:** the Cloudflare module against a fake API and local HTTPS servers (certificate dates, HTTP errors, refused connections, reconnect counting, DNS actions, dynamic DNS, missing permissions, redaction), and its card in a real browser as a viewer and as an admin.
- **multinode-ui.test.mjs:** two Proxmox hosts that both have a VM 101 and two iLOs: the Overview tiles and panels, the crash marker on the right host only, the TV wall fitting at 1920x1080 and 1366x768, the Instances filter bar and the suggested name.
- **features-ui.test.mjs, snapshot-backup-ui.test.mjs:** the Energy, Maintenance, Overview and Proxmox pages in a real browser, including TV mode fitting at 1920x1080 and 1366x768 with nothing cut off.

Modules were exercised against fake devices speaking their real protocols (including every iLO power command and its safety checks), and the Proxmox, apcupsd, iLO and Uptime Kuma modules have run against real hardware.

**Not tested:** the Docker image, the Cloudflare module's DNS, traffic, dynamic DNS and Access parts against a real account, iLO power commands and Proxmox start/stop/snapshot/backup buttons against real devices (deliberately), and scheduled actions against real devices.

## 13. Not done yet

UPS self-test (apcupsd cannot start one; needs NUT), iLO fan control (iLO 4 has no supported API), snapshot list/rollback/delete, automatic UPS-outage shutdown (apcupsd already handles this on the machine the UPS is attached to), SSH/RDP broker (JumpServer or Guacamole), LDAP and two-factor sign-in, email notifications, FCM/APNs and the mobile app, Raspberry Pi metrics, wallpaper and theme import, auto-update, a heartbeat to an outside service so you hear about it when the machine running Lumina dies.
