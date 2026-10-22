# Lumina

**A modular dashboard for your homelab, made to stay on a screen all day.** One page shows whether Proxmox, your server's iLO, your UPS, Uptime Kuma and Cloudflare are healthy, raises alerts when they are not, and lets signed-in users do the everyday things (start a VM, power a server on, take a snapshot) without opening five different tools.

[![CI](https://github.com/DanielG158/Lumina-Dashboard-Monitoring/actions/workflows/ci.yml/badge.svg)](https://github.com/DanielG158/Lumina-Dashboard-Monitoring/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What it does

- **Wall display.** The Overview fits one screen with no scrolling at any size, text scales to fill it, and **TV mode** keeps the screen awake. Cards move every 15 seconds to prevent burn-in. If the connection to Lumina drops, the screen greys out and says so instead of showing old numbers.
- **Proxmox.** Nodes, VMs and containers, storage, disks, backup jobs, tasks. Start, stop, reboot, **Snapshot**, **Back up now** and a **Console** link for each guest. Warns when a guest has no recent backup, and forecasts when a storage volume will fill up.
- **HPE iLO 4 and 5.** Power, temperatures, fans (with 24-hour charts), power supplies, drives, memory, logs, and power on/off buttons.
- **UPS (apcupsd), Uptime Kuma, Cloudflare tunnels.** Status, history, alerts. Cloudflare hostnames can be added and removed.
- **Energy and cost.** Turns the UPS or iLO power reading into kWh and money for any day, range or billing cycle. Fully adjustable tariff (flat, time-of-day, progressive blocks), currency, tax, billing day and budget. Shows the cost per VM and container, projects the month, and has a helper to calibrate against your electricity meter.
- **Alerts.** Every module reports warnings on its own card. Notifications to Discord, Slack, Telegram, ntfy or any webhook. Maintenance windows and scheduled actions (snapshot at 2 a.m., power on at 7 a.m.) keep planned work from raising false alarms.
- **Access levels.** Anyone on your network can *view* without logging in. **Operators** sign in to start and stop things. **Admins** add, edit and remove everything else. Sensitive details are hidden from anonymous viewers.
- **Secure by default.** HTTPS with an automatic certificate, credentials encrypted at rest, hashed passwords, lockout, audit log, sandboxed service. See [docs/security-assessment.md](docs/security-assessment.md).
- **Easy to move.** Everything is configured in the web UI. Back up to a passphrase-protected file and restore it on a new machine.

## Install

Debian or Ubuntu (a VM or an LXC container is fine). You need root and an internet connection:

```bash
curl -fsSL https://raw.githubusercontent.com/DanielG158/Lumina-Dashboard-Monitoring/main/install.sh | sudo bash
```

It installs Node.js, builds Lumina, creates an unprivileged `lumina` user and a sandboxed systemd service, and serves **HTTPS on port 443** (port 80 redirects) with a self-signed certificate. When it finishes it prints a **one-time setup code**.

Open `https://<your-server>/`, enter the setup code and create the admin account (or choose **Restore from backup** to move from another Lumina). Then add your devices under **Instances**.

Other ways: `sudo ./install.sh --http` (plain HTTP on 8080), `sudo ./install.sh --import-db old.db`, or `docker compose up -d`. Upgrade by running the installer again; your data is kept in `/var/lib/lumina`.

> **Your browser will warn about the certificate** the first time, because Lumina makes its own. You can install your own certificate in Settings.

## Connecting your devices

| Device | What you need |
|---|---|
| Proxmox VE | An API token (Datacenter → Permissions → API Tokens). `PVEAuditor` is enough to look; add `PVEVMAdmin` to use the buttons. |
| HP iLO 4 | An iLO user. Lumina uses the Redfish API. |
| UPS | `apcupsd` running on the machine the UPS is connected to, with its network port (3551) reachable. |
| Uptime Kuma | An API key (Settings → API Keys). |
| Cloudflare | An API token with Tunnel and (optionally) DNS permissions. |

The UI explains each field. More detail is in [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md).

## Develop

```bash
pnpm install
pnpm build
pnpm test:fast     # backend tests, no browser needed
pnpm test          # everything (needs Chromium: npx playwright-core install chromium)
```

Lumina is a TypeScript monorepo: `packages/core` (Fastify, Socket.io, SQLite), `packages/ui` (React, Vite), `packages/sdk` (the module contract) and `packages/modules/*` (one folder per device type). Adding a new device type means writing one module file; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Status

Lumina is young, and written for and tested on one homelab. Proxmox, iLO 4, apcupsd and Uptime Kuma are used daily. The **Cloudflare module and the Docker image have not been tested against real accounts or in production**, and the scheduled actions and power buttons are covered by automated tests with fake devices only. Please read [the security notes](docs/security-assessment.md) before exposing it beyond your home network, and open an issue if something does not work.

Not built yet: NUT support, email notifications, LDAP or two-factor sign-in, a mobile app, auto-update.

## License

[MIT](LICENSE) © DanielG158
