# Lumina

**A modular dashboard for your homelab, made to stay on a screen all day.** One page shows whether Proxmox, your server's iLO, your UPS, Uptime Kuma and Cloudflare are healthy, raises alerts when they are not, and lets signed-in users do the everyday things (start a VM, power a server on, take a snapshot) without opening five different tools.

[![CI](https://github.com/DanielG158/Lumina-Dashboard-Monitoring/actions/workflows/ci.yml/badge.svg)](https://github.com/DanielG158/Lumina-Dashboard-Monitoring/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What it does

- **Wall display.** The Overview fits one screen with no scrolling at any size, text scales to fill it, and **TV mode** keeps the screen awake. Cards move every 15 seconds to prevent burn-in. If the connection to Lumina drops, the screen greys out and says so instead of showing old numbers.
- **Proxmox.** Nodes, VMs and containers, storage, disks, backup jobs, tasks. Start, stop, reboot, **Snapshot**, **Back up now** and a **Console** link for each guest. Warns when a guest has no recent backup, and forecasts when a storage volume will fill up.
- **HP iLO 4.** Power, temperatures, fans (with 24-hour charts), power supplies, drives, memory, logs, and power on/off buttons.
- **Network monitoring.** Ping, TCP, DNS and web checks with latency and packet-loss history, an optional internet speed test, and SNMP link status and traffic for pfSense, OPNsense, OpenWrt and managed switches.
- **Several sites.** Add **Another Lumina** to see a second site's devices and alerts here, using a read-only access token, with no VPN session needed.
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

## First steps after installing

1. Open `https://<your-server>/` (accept the certificate warning once, see below).
2. Enter the **setup code** the installer printed (it is also in `/var/lib/lumina/setup-code` until you finish). Choose a username and a password of at least 8 characters. This is your **admin** account. To move from another Lumina instead, choose **Restore from backup**.
3. Go to **Instances → Add**, pick a type and fill in the form (each section below tells you what to enter).
4. Optional but recommended: **Settings → General → Name shown next to the logo** (for example "Office"), the **Theme** menu (colours, burn-in protection, network speed units, and **Overview detail**: *Easy to read* shows big counts and only the VMs and monitors that need a look, *Everything* lists every one by name), **Settings → Notifications** (so problems reach your phone), **Settings → Users** (an operator account for day-to-day use), and press **TV mode** on the screen you want to leave on.

Every instance has its own **refresh rate** and name (Instances → **Edit**, which opens as a popup so the page does not jump; renaming keeps its history, alerts, schedules and maintenance windows) and shows its warnings on its own card. You can add more than one of most types (two Proxmox servers, several iLOs, and so on).

## Connecting your devices

Use a dedicated, least-privilege account or token for Lumina on every device, never your own admin login.

### Proxmox VE

1. In Proxmox, go to **Datacenter → Permissions → Users → Add**. Create a user such as `lumina` in the `pve` realm (no password needed, it is only for the token).
2. **Datacenter → Permissions → API Tokens → Add**. Pick that user, name it `lumina`, and decide about **Privilege Separation**:
   - Leave it **ticked** (safer) and give the *token* its own permissions in step 3; or
   - **Untick** it, and the token has exactly the user's permissions.
   Copy the **Token ID** (`lumina@pve!lumina`) and the **Secret**. The secret is shown only once.
3. **Datacenter → Permissions → Add → User Permission** (or *API Token Permission* if privilege separation is on). Path `/`, tick **Propagate**, and choose:
   - **View only:** role `PVEAuditor`.
   - **View and start/stop/reboot/snapshot:** `PVEAuditor` plus `PVEVMAdmin`.
   - **Also "Back up now":** the role also needs `Datastore.AllocateSpace` and `VM.Backup` (the built-in `PVEVMAdmin` and `PVEDatastoreUser` roles together cover it).
4. In Lumina: **Add → Proxmox VE**. Host URL `https://<proxmox-ip>:8006`, the Token ID and the Secret.
5. Proxmox uses a self-signed certificate by default. Leave **Verify TLS certificate** off and press **Detect** next to *Certificate fingerprint* to pin it. Lumina then talks only to that exact certificate.

Optional: *Warn when a guest's last backup is older than* (default 8 days; set 0 to turn off) and *Guests that don't need backups* (IDs to skip).
If the card shows blanks or "no permissions", the token is missing the permission at `/` with Propagate (and the token itself needs it when privilege separation is on).

### HPE iLO (iLO 4 and iLO 5)

Works with ProLiant Gen8/Gen9 (iLO 4, firmware 2.30 or newer) and Gen10 (iLO 5). iLO 4 is used daily by the author; **iLO 5 support is newer and less tested**, so please report anything that looks wrong.

1. In the iLO web page: **Administration → User Administration → New**. Create a user such as `lumina`.
2. Privileges: **Login** is enough to look. Add **Virtual Power and Reset** if you want the power buttons (power on, shut down, hard reset, force off).
3. In Lumina: **Add → HPE iLO**. URL `https://<ilo-ip>`, the user and the password.
4. As with Proxmox, leave **Verify TLS** off and use **Detect** to pin the certificate.

The first load of drives, memory and logs takes about 30 seconds. Parts the iLO will not give are listed on the card and appear in the Alerts page as low-priority "Could not read ..." entries. Fan speed cannot be changed (iLO does not allow it), so the cooling view is read-only. The iLO also does not like many simultaneous connections, so use a refresh rate of 15 seconds or slower.

### UPS (apcupsd)

Lumina reads the UPS from the machine it is plugged into (a Raspberry Pi, a server) through apcupsd's network port. This is read-only: Lumina cannot start a self-test or switch the UPS off.

1. Install and configure `apcupsd` on that machine so that `apcaccess status` works.
2. In `/etc/apcupsd/apcupsd.conf` set:
   ```
   NETSERVER on
   NISIP 0.0.0.0
   NISPORT 3551
   ```
   `0.0.0.0` listens on every address. A more careful choice is the machine's own LAN address. Restart: `sudo systemctl restart apcupsd`.
3. Allow TCP 3551 from the Lumina machine (firewall, and any router between subnets).
4. Check from the Lumina machine: `nc -vz <ups-host> 3551`.
5. In Lumina: **Add → UPS (apcupsd)**, the host and port 3551.

To let the energy page use the UPS as a power meter, nothing more is needed: the load percentage and the UPS's rated power are read automatically.

### Uptime Kuma

1. In Uptime Kuma: **Settings → API Keys → Add API Key**. Copy the key.
2. In Lumina: **Add → Uptime Kuma**. URL `http://<kuma-ip>:3001` (use `https://` only if Kuma itself is on HTTPS) and the key.
3. **To see what your Push monitors send** (a temperature, a message): in Kuma create a **Status Page**, add the push monitors to it, and put its name (the last part of `/status/<name>`) in Lumina's *Status page name* field. Without it Lumina can only tell whether a push arrived.

### Cloudflare tunnels

1. In Cloudflare: **My Profile → API Tokens → Create Token → Custom**. Permissions: **Account → Cloudflare Tunnel → Edit**. To let Lumina also create DNS records for hostnames, add **Zone → DNS → Edit**.
2. Copy the **Account ID** (on the account's overview page) and, optionally, the **Zone ID** of your domain.
3. In Lumina: **Add → Cloudflare**, the token and IDs. Only admins can change hostnames. The Cloudflare module has not been tried against a real account by the author, so test it on something unimportant first.

### Network checks (ping, ports, DNS, web)

No device setup is needed. **Add → Network checks**, then build the list in the form (nothing to type in a special format):

1. Press **+ Add a check**, or pick one from **+ Add a common check…** (internet ping, public DNS, a web page, a port on the internet).
2. Give it a **name**, choose the **type**, and fill in the address:
   - **Ping**: a host name or IP address, for example your router `192.168.1.1`.
   - **TCP port**: a host and a port, for example `192.168.1.10` and `8006`.
   - **DNS lookup**: a name such as `example.com` and, optionally, the DNS server to ask.
   - **Web page**: a full address such as `https://example.com`.
3. Mistakes are shown in red under the row, and Save stays off until they are fixed.

You can change the list at any time on the **Network** tab: **Edit checks** (admins) shows every check with a dot for whether it answers right now, lets you add, remove and re-order them, and set how often to check, how many pings to send, and when to warn.

Lumina records latency, jitter and packet loss, charts them, and raises alerts when a check stops answering, loses 20% of its packets or is slower than 150 ms (both limits are adjustable).

- **Pings need permission.** The installer allows it. If a check says "not allowed to send pings" (some containers refuse), run the command shown on the card once, as root: `echo "net.ipv4.ping_group_range = 0 2147483647" > /etc/sysctl.d/90-lumina-ping.conf && sysctl --system`. TCP, DNS and web checks work without it.
- **Internet speed test (off by default).** Open the **Network** tab. Under *Internet speed* press **Speed test settings** (admins), tick *Run internet speed tests automatically*, and set how often (default every 6 hours), the test size and an optional minimum download speed. It downloads and uploads test data (Cloudflare's public test by default), so it uses your connection and tells that service your address. Operators can press **Run speed test now** at any time. The page keeps every result for two years, draws download and upload over time (24 hours, 7 days, 30 days or everything), lists them in a table and exports them as CSV.
- **Mbit/s or MB/s.** Every network speed can be shown as megabits per second (how links and internet plans are sold) or megabytes per second (how downloads show): use the switch on the Network page, on the SNMP card, or in the Theme menu. It is remembered per browser.

### Router or switch (SNMP)

Works with anything that speaks SNMP: pfSense, OPNsense, OpenWrt, managed switches, firewalls, many NAS boxes. Unmanaged switches have no SNMP; ping them instead.

1. Switch SNMP on at the device (menu names vary by version):
   - **pfSense:** Services → SNMP. Enable it, set a community, bind it to the LAN interface and keep the *MibII* module on.
   - **OPNsense:** System → Firmware → Plugins, install `os-net-snmp`; then Services → Net-SNMP, enable it, set the community, listen on LAN.
   - **OpenWrt:** `opkg update && opkg install snmpd`, set the community in `/etc/config/snmpd` (or the LuCI page), then `/etc/init.d/snmpd restart`.
   Allow only the Lumina machine's address to ask. Use **SNMP v3** (user, authentication and encryption keys) where the device offers it, because v2c sends its community in clear text.
2. In Lumina: **Add → Router / switch (SNMP)**. Address, version, and the community (v2c) or the v3 user and keys.
3. **If it will not connect, press "Test the SNMP settings"** on the instance's card (admins). Lumina tries the usual authentication and encryption combinations with the user and keys you entered, and tells you which one the device accepts, so you can set the instance to exactly that. A device that ignores wrong keys silently shows as "no answer"; one that answers with *authorizationError* accepted the login but hides data from that user.
4. Under *Interfaces to alert on*, list the links that matter, such as `igb0, wan`. They raise a critical alert when the link goes down. Unused down ports are hidden.

### TP-Link Omada (routers, switches and access points)

Lumina reads an **Omada controller**: the software controller or the OC200 / OC300 hardware controllers, version 5.1 or newer. It shows every site's routers (gateways), switches and access points with online status, Wi-Fi clients per access point, CPU and memory, uptime and firmware updates. It is read-only.

1. In the Omada controller, create a **separate account for Lumina with the Viewer role** (Settings, Admin; the menu names differ between versions), limited to the sites you want shown.
2. In Lumina: **Add → TP-Link Omada Controller**. Address is what you open in the browser (for example `https://192.168.1.2:8043`; hardware controllers use 443), then the username and password. *Site name* is optional (empty shows every site the account can see).
3. The controller's certificate is usually self-signed: leave **Verify TLS** off and press **Detect** to pin it.

Lumina raises a critical alert when a device goes offline, a warning when one stops answering the controller or is isolated, and informational notes for a device waiting to be adopted or a firmware update. Devices that are not managed by a controller are covered below.

**TP-Link Archer routers without a controller (AX12, AX10, AX20, AX23, AX50, C6U and similar).** Add **TP-Link Archer router**. Lumina signs in to the router's admin page the same way a browser does, reads its status page and signs out again. It shows whether the router has an internet connection and its internet address and uptime, CPU and memory use, the number of wired, Wi-Fi and guest clients (signed-in operators also see the list of devices), and the router's model and firmware. It only reads and changes nothing.

1. Use the router's **local password** (the one you type on the admin page at `tplinkwifi.net` or `192.168.0.1`), not your TP-Link ID. If your router signs in with a TP-Link ID, switch it to a local password in the router's settings first.
2. Add the instance with the router's address (for example `http://192.168.0.1`) and the password. The username is normally `admin`.
3. Readings are taken once a minute by default and never faster than every 30 seconds. These routers allow only one admin session, so while Lumina is signed in (a second or two) the admin page is busy. Lumina signs out straight afterwards, and if you are using the admin page when a reading is due it skips that reading and keeps the last one. If the password is wrong, Lumina tries once and then waits 10 minutes, so it can never lock the router's login.
4. Lumina raises a critical alert when the router has no internet address, and warnings for a very busy CPU or memory.

It follows the protocol that the open-source project [TP-Link-Archer-C6U](https://github.com/AlexandrErohin/TP-Link-Archer-C6U) documents for these routers, and its supported list includes the Archer AX12. It has been tested against a fake router that behaves that way, **not yet against a real AX12**. If it cannot sign in, the card shows what the router answered; please open an issue with that text.

**Other TP-Link devices.** Deco mesh systems and some other models use a different admin interface and are not supported; watch them with **Network checks** (a *Ping* check and a *TCP port* check on the web port, 80 or 443). Business models in standalone mode (Omada gateways and access points, JetStream switches) often support **SNMP**; if yours does, add it as **Router / switch (SNMP)** for link status and traffic.

### Another Lumina (a second site)

To see an office or a second home from this one without a VPN session:

1. On the **other** Lumina: **Settings → Access tokens → New token**. Copy it; it is shown once.
2. On **this** Lumina: **Add → Another Lumina**. Its address, a name for its alerts (for example "Office"), and the token.

You see its devices and alerts here, and its alerts are raised here too, so your notifications cover both. The token is read-only and sees only what an anonymous viewer sees. This Lumina must be able to reach the other one: over a VPN, a Cloudflare Tunnel, or a reverse proxy with HTTPS. Do not forward a plain HTTP port to the internet; if you expose it, switch off public viewing on that Lumina and rely on the token.

## Notifications

**Settings → Notifications → Add**, then **Send test** to check it works. Each channel has a minimum severity so you can send only critical problems to your phone.

| Channel | What to do |
|---|---|
| Discord | Channel settings → Integrations → Webhooks → New Webhook → Copy URL |
| Slack | Create an *Incoming Webhook* for the workspace and copy its URL |
| Telegram | Talk to `@BotFather`, send `/newbot`, copy the bot token. Send your bot a message, then open `https://api.telegram.org/bot<token>/getUpdates` to find your chat ID |
| ntfy (phone push) | Install the ntfy app, subscribe to a hard-to-guess topic, enter the same topic in Lumina (leave the server empty to use ntfy.sh, or enter your own) |
| Webhook | Any URL; Lumina posts JSON, with an optional Authorization header |

A problem must persist for a couple of polls before it is raised (adjustable under Settings → General), so a single dropped reading does not wake you up. Resolved alerts send a "resolved" message too.

## Who can do what

- **Anyone** who can reach the page can view it, with sensitive details (serial numbers, addresses, logs) hidden. You can turn this off under Settings → General, and everyone then has to sign in.
- **Operators** sign in to start, stop, reboot, snapshot and back up guests, use the iLO power buttons, refresh, mute alerts and start maintenance. Make one under Settings → Users.
- **Admins** also add, edit and remove instances, manage users, notifications, settings, tokens, backups, and see the audit log.

If you lose the admin password, run `sudo -u lumina LUMINA_DATA=/var/lib/lumina node /opt/lumina/scripts/reset-password.mjs admin`.

## Planned work and maintenance

- **Maintenance windows** (Maintenance tab): during a window alerts for the chosen instances are recorded but not sent, and anything still broken afterwards is reported then. Shutting down an iLO server from Lumina opens a 30-minute window automatically.
- **Scheduled actions**: snapshot, backup, start, stop or reboot a guest, or power on/shut down an iLO server, once or on a repeat. Hard resets cannot be scheduled.

## Electricity cost

**Energy → Prices and settings.** Enter your tariff (one flat price, time-of-day prices, or progressive blocks), currency, tax, the day your billing cycle starts and an optional monthly budget. Lumina uses the iLO's power reading when there is one and the UPS load otherwise. A UPS reading is an estimate (about plus or minus 10%): use *Calibrate against your meter* with two readings from your electricity meter to correct it, or add *Extra watts* for equipment Lumina cannot see.

## Backups and moving to another machine

**Settings → Backup and restore**: choose a passphrase and download the file. It holds your instances, credentials, users, notification channels, settings and the encryption key, encrypted with that passphrase. On a new installation choose **Restore from backup** on the first screen. Everything lives in `/var/lib/lumina`; the only thing you need to keep safe besides the backup file is the passphrase.

## HTTPS and certificates

The installer creates a self-signed certificate, so the browser warns on the first visit. Under **Settings → Server and HTTPS** you can paste your own certificate and key, change the ports, or switch to plain HTTP. If you use Cloudflare Tunnel or a reverse proxy, point it at Lumina and let it provide the trusted certificate.

## Updating

Run the install command again. Your data stays. To update from a copy of the repository: `sudo ./install.sh`.

## If something does not work

| Symptom | Try |
|---|---|
| Card says "Can't reach this service" | The message under the title is the real error. Check the address, the credentials, and that Lumina's machine can reach the device (firewall, subnet) |
| Proxmox card is empty or shows NaN | Token permissions: see the Proxmox section |
| iLO card shows "Some data could not be read" | Each line says which part and why. Often a missing iLO privilege or a very slow iLO; try a slower refresh rate |
| UPS "connection refused" | `NETSERVER on` and `NISIP` in `apcupsd.conf`, and a firewall rule for TCP 3551 |
| Ping checks say "not allowed" | The `ping_group_range` command in the Network checks section |
| Page is blank after an update | Hard-refresh the browser (Ctrl+Shift+R) |
| Logs | `journalctl -u lumina -n 100` |

Still stuck? Open an issue with the card's error text (remove passwords and addresses you do not want public).

## Develop

```bash
pnpm install
pnpm build
pnpm test:fast     # backend tests, no browser needed
pnpm test          # everything (needs Chromium: npx playwright-core install chromium)
```

Lumina is a TypeScript monorepo: `packages/core` (Fastify, Socket.io, SQLite), `packages/ui` (React, Vite), `packages/sdk` (the module contract) and `packages/modules/*` (one folder per device type). Adding a new device type means writing one module file; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Status

Lumina is young, and was written for and tested on one homelab. Proxmox, iLO 4, apcupsd and Uptime Kuma have run daily against real hardware. These have only been tested against automated fakes or briefly: **iLO 5 (Gen10), the Network checks, SNMP, TP-Link Omada and TP-Link Archer modules, watching another Lumina, the Cloudflare module and the Docker image**, and the scheduled actions and power buttons have never been run against real devices. Please read [the security notes](docs/security-assessment.md) before exposing it beyond your home network, and open an issue if something does not work.

Not built yet: NUT support, email notifications, LDAP or two-factor sign-in, a mobile app, auto-update, device discovery.

## License

[MIT](LICENSE) © DanielG158
