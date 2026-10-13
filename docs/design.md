# Lumina — Design Document

Version 0.2 — September 2026

## 1. Overview

Lumina is an open-source, modular homelab dashboard built with Node.js and React. It provides a centralized control plane for monitoring and managing homelab infrastructure, with a plugin/module system that allows users to add or remove integrations based on their own setup. Lumina is universal — not locked to any specific hardware, hypervisor, or UPS brand.

## 2. Goals

- Unified monitoring for all homelab components from a single dashboard
- Modular plugin architecture — not locked to any specific hardware or software
- Full action/control capability, not read-only
- Open source on GitHub, community-friendly
- Easy deployment via Docker Compose or installer script
- Works from outside local network (Cloudflare Tunnel or reverse proxy)
- Mobile-first notifications — push alerts to iOS and Android

## 3. Features

### 3.1 Monitoring
- UPS: load %, battery %, runtime remaining, last self-test result
- Proxmox: VM/CT list, status, CPU %, RAM %, storage usage — multi-node
- iLO4: power (W), fan PWM %, temperature sensors
- Uptime Kuma: monitor up/down, response time
- Cloudflared: tunnel status per endpoint
- Raspberry Pi: CPU temp, RAM, disk usage
- SMART disk health

### 3.2 Actions
- Start / stop / reboot VM/CT
- iLO4 fan speed adjustment
- Trigger UPS self-test and battery calibration
- Trigger on-demand Proxmox backup
- Restart cloudflared service

### 3.3 Cloudflare Management
- View all active tunnel endpoints
- Add / remove / edit tunnel endpoints via Cloudflare API
- Restart cloudflared service

### 3.4 Access — SSH & RDP
Lumina acts as a connection broker, proxying SSH and RDP so users can reach internal VMs from outside the LAN. Credentials are never exposed to the user.

- Generate downloadable `.rdp` and `.ssh` config files pointing at the Lumina public endpoint
- Lumina proxies traffic to internal VMs (192.168.11.x)
- Ephemeral credentials — temp keypairs/passwords that expire after N minutes
- Works outside LAN via Cloudflare Tunnel

PAM modes:
- **With PAM (JumpServer):** Lumina hits JumpServer API, gets session token, generates files
- **Without PAM (Guacamole):** Lumina uses Apache Guacamole as connection backend

### 3.5 Notifications
- Email alerts for service/monitor down
- UPS battery low warning
- Push to iOS and Android (FCM + APNs)
- Webhooks — Telegram, Discord, Slack
- Native notification-bar popup on mobile

### 3.6 Authentication
- LDAP
- Email/password
- Local accounts
- Rate limiting on login attempts
- Session timeout

### 3.7 Theming
- Built-in: Dark (default), Light, Catppuccin, Nord
- Custom accent color picker
- Custom wallpaper/background upload
- Community theme import

### 3.8 Security & Audit
- All credentials encrypted in SQLite (never plaintext)
- API key rotation for module credentials
- Audit log — who logged in, who accessed which server, when
- Rate limiting on all endpoints
- Session management with timeout

### 3.9 Observability
- Self health-check endpoint (`/health`, monitorable by Uptime Kuma)
- Per-module error logging
- Module connection status indicator in UI

## 4. Module System

Each integration is a standalone package implementing the `@lumina/sdk` interface: a zod config schema, `create()` returning `poll()`, `status()` and `actions[]`. Modules are enabled/disabled from the UI; multiple instances of one module are supported (e.g. two Proxmox nodes).

| Module | Method | Library | Data / Actions |
|---|---|---|---|
| proxmox | REST API :8006 | native fetch | VM status, CPU, RAM, storage, start/stop/reboot, backup. Multi-node. |
| apcupsd | NIS port 3551 | apcaccess | Load%, battery%, runtime, self-test, calibration |
| nut | NUT port 3493 | nut-client | Universal UPS — APC, Eaton, CyberPower, etc. |
| ilo4 | HTTPS XML API | python-hpilo (Python microservice) | Power (W), fan PWM%, temps, fan speed adjust |
| cloudflare | Cloudflare REST API | cloudflare (official) | Tunnel status, add/remove/edit endpoints |
| uptime-kuma | REST API | uptime-kuma-api | Monitor up/down, response time |
| jumpserver | JumpServer API | fetch | Session token, asset list (PAM mode) |
| guacamole | Guacamole API | fetch | Connection proxy — RDP & SSH (non-PAM) |

### 4.1 UPS — multi-backend
| Backend | For | Library |
|---|---|---|
| apcupsd | APC UPS with apcupsd daemon | apcaccess |
| nut | Any brand (APC, Eaton, CyberPower, …) | nut-client |
| manual | UPS without monitoring software | Manual input in UI |

### 4.2 Proxmox — multi-node
Multiple hosts as separate instances; unified dashboard view with per-node drill-down.

## 5. Connection Proxy Architecture

```
User (outside network)
    ↓ HTTPS / SSH
lumina.bronghummy.homes (Cloudflare Tunnel)
    ↓
Lumina Core (connection broker)
    ↓ forward
VM internal (192.168.11.x)
```

| Protocol | Technology | File generated |
|---|---|---|
| RDP | rdpgw / Apache Guacamole | `.rdp` pointing at lumina.bronghummy.homes |
| SSH | sshpiper / ssh2 | `.ssh` config + ephemeral keypair |

## 6. Mobile App

| Aspect | Decision |
|---|---|
| Framework | React Native (iOS + Android) |
| Scope | Monitoring + quick actions only (no SSH/RDP) |
| Push | FCM (Android) + APNs (iOS) |
| Notification types | Service down, VM stopped unexpectedly, UPS battery low |
| Auth | Same as web (LDAP / email / local) |

## 7. Architecture

pnpm-workspaces monorepo:

```
lumina/
  packages/
    sdk/               — Module interface (ModuleDefinition, defineModule)
    core/              — Node.js backend (Fastify + Socket.io + SQLite)
    ui/                — React frontend (Vite)
    mobile/            — React Native app
    modules/
      proxmox/ apcupsd/ nut/ ilo4/ cloudflare/ uptime-kuma/ jumpserver/ guacamole/
  docs/                — VitePress documentation
  docker-compose.yml
  Dockerfile
  install.sh           — One-line installer
```

## 8. Tech Stack

| Layer | Technology | Reason |
|---|---|---|
| Frontend | React + TypeScript | Largest ecosystem |
| UI Components | shadcn/ui | Modern, accessible, customizable |
| Backend | Node.js + TypeScript | One language across the stack |
| API | Fastify | Fast, schema-based, TS-first |
| Realtime | Socket.io | Live status updates |
| Database | SQLite (better-sqlite3) | Zero setup, file-based |
| Mobile | React Native | iOS + Android, shared logic |
| Push | FCM + APNs | Native push |
| Monorepo | pnpm workspaces | Fast, module isolation |
| Deploy | Docker Compose | One-command deploy |
| Docs | VitePress | Markdown-based |
| iLO4 bridge | Python + python-hpilo | Microservice for iLO4 XML API |

## 9. Deployment

- Target: Proxmox LXC (Debian 13)
- Domain: lumina.bronghummy.homes via Cloudflare Tunnel
- External: `docker compose up -d`
- One-liner: `curl -fsSL lumina.sh | bash`
- First-run setup wizard in UI (credentials, modules, notifications)
- Auto-update mechanism

## 10. Open Source

- MIT license
- VitePress docs
- Community modules via the SDK; community themes importable

## 11. Roadmap

1. ~~Init monorepo~~ (done)
2. ~~Core backend + Proxmox module (proof of concept)~~ (scaffolded)
3. React frontend with WebSocket — replace JSON dump with real cards
4. Modules one by one: apcupsd/NUT, iLO4, Cloudflare, Uptime Kuma
5. Auth (LDAP, email, local) + encrypted credential storage
6. Connection proxy — SSH & RDP
7. Notifications (email, push, webhook)
8. Theming
9. React Native mobile app
10. Docker Compose packaging + installer polish
11. Docs & GitHub release
