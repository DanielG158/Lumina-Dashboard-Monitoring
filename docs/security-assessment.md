# Lumina security assessment

Scope: the Lumina server and web UI as deployed on `Lumina-Monitoring` (Debian 13 LXC), its installer and service configuration,
dependencies, and the host it runs on. Method: dependency audit, code review, a scripted attack suite against throw-away HTTPS
copies of the server (36 checks, including a permission matrix generated from the real route list and an XSS payload rendered in a
real browser), probes against the live service, and a host configuration review. Not covered: Proxmox/iLO/Cloudflare themselves,
denial-of-service, the untested Docker image.

## Fixed during the assessment

| Severity | Finding | Fix |
|---|---|---|
| High | `@fastify/static` 8.3.0 had 4 advisories (one high: route-guard bypass via path traversal) | Upgraded to 10.1.5; `pnpm audit` is clean |
| High | On a fresh install the first visitor could claim the admin account | One-time setup code, printed by the installer and required to create the first admin, skip setup, or restore |
| Medium | Anonymous viewers could see logs, serial numbers, MAC addresses, internal URLs and raw error text | Redacted for anonymous HTTP and websocket clients |
| Medium | TLS to self-signed devices (Proxmox, iLO, Kuma) was unverified, allowing LAN impersonation | Optional certificate pinning with a "Detect from the device" button |
| Medium | Service ran with broad privileges | Dedicated `lumina` user, root-owned code, strict sandbox: `systemd-analyze security` 5.3 MEDIUM to 1.5 OK |
| Medium | Module credentials were stored in plaintext | AES-256-GCM at rest (key file 0600); passwords hashed with scrypt |
| Low | Database and key could be world-readable on non-systemd installs | Server forces umask 077 |
| Low | API responses cacheable; `/health` revealed counts; no server-side cross-site check; sign-in check keyed on raw URL text | `Cache-Control: no-store`; minimal `/health`; cross-origin state changes refused; check also uses the matched route |

## Verified as working

Encoded-path and traversal bypass attempts (16 variants on admin routes, 11 on the static server), SQL injection, prototype
pollution, stored XSS (rendered as text, no execution), cross-site POST and form-style content types, request size limits,
error/stack leakage, cookie flags (`HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS), brute-force lockout, logout, websocket
origin checks, TLS 1.2/1.3 only (RSA 2048, SHA-256), HTTP-to-HTTPS redirect with hostile `Host` headers, no passwords or tokens in
logs, correct 401/403 on all 36 API routes for anonymous and operator users.

## Open items for you to decide

| Severity | Item | Suggested action |
|---|---|---|
| Medium | Host SSH allows root login with a password on all interfaces; firewall policy is accept-all; 44 packages upgradable; no unattended upgrades | Key-only SSH (`PermitRootLogin prohibit-password`, `PasswordAuthentication no`), a firewall allowing only 22/80/443 from your LAN, `apt upgrade`, install `unattended-upgrades` |
| Medium | The Proxmox token has the broad `PVEAdmin` role at `/` | Use `PVEVMAdmin` on `/vms` plus `PVEAuditor` at `/` (or `PVEAuditor` alone for read-only) |
| Medium | Lumina logs into iLO as `Administrator` | Create a dedicated iLO user with only login and Virtual Power and Reset |
| Low | Old plaintext database copies remain (`/root/lumina/packages/core/lumina.db*`, set to 0600) | Delete them once you are happy with the new install |
| Low | Public viewing is on by default | Turn it off (Settings, General) if Lumina is ever reachable from the internet; put Cloudflare Access in front of a tunnel |
| Low | The first admin password was shared in a chat | Change it (Settings, My account) |
| Info | "Open access" (skip setup) lets anyone on the network control everything | Create an admin account; open access then ends automatically |
| Info | No 2FA or LDAP yet | Planned |
