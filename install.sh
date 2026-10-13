#!/usr/bin/env bash
# Lumina installer for Debian/Ubuntu. Safe to re-run: running it again upgrades Lumina and keeps your data.
#
#   Fresh install from GitHub:   curl -fsSL https://raw.githubusercontent.com/DanielG158/Lumina-Dashboard-Monitoring/main/install.sh | sudo bash
#   Install from a local copy:   sudo LUMINA_SRC=/path/to/lumina ./install.sh
#   Bring an old database along: sudo ./install.sh --import-db /path/to/lumina.db
#   Plain HTTP instead of HTTPS: sudo ./install.sh --http          (port 8080)
#
# After it finishes, everything else (accounts, modules, HTTPS, backups) is done in the web UI.
set -euo pipefail

APP_DIR="${LUMINA_DIR:-/opt/lumina}"
DATA_DIR="${LUMINA_DATA:-/var/lib/lumina}"
REPO="${LUMINA_REPO:-https://github.com/DanielG158/Lumina-Dashboard-Monitoring.git}"
SRC="${LUMINA_SRC:-}"
IMPORT_DB=""
HTTP_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --import-db) IMPORT_DB="${2:?--import-db needs a file path}"; shift 2 ;;
    --http) HTTP_ONLY=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo)." >&2; exit 1; }
say() { printf '\n==> %s\n' "$*"; }

say "Installing prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates build-essential python3 openssl rsync >/dev/null

need_node=1
if command -v node >/dev/null 2>&1; then
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
corepack enable

say "Getting the code into $APP_DIR"
mkdir -p "$APP_DIR"
if [ -n "$SRC" ]; then
  rsync -a --delete \
    --exclude node_modules --exclude .git --exclude 'packages/*/dist' --exclude 'packages/modules/*/dist' \
    --exclude 'packages/core/data' --exclude '*.db' --exclude '*.db-wal' --exclude '*.db-shm' --exclude '*.key' \
    "$SRC"/ "$APP_DIR"/
elif [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  rm -rf "$APP_DIR"
  git clone --depth 1 "$REPO" "$APP_DIR"
fi

say "Building (this takes a minute or two)"
cd "$APP_DIR"
pnpm install --silent
pnpm -r build >/dev/null
chown -R root:root "$APP_DIR"

say "Preparing the data folder $DATA_DIR"
id lumina >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin lumina
mkdir -p "$DATA_DIR"
chown lumina:lumina "$DATA_DIR"
chmod 700 "$DATA_DIR"

if [ -n "$IMPORT_DB" ]; then
  [ -f "$IMPORT_DB" ] || { echo "Database not found: $IMPORT_DB" >&2; exit 1; }
  if [ -e "$DATA_DIR/lumina.db" ]; then
    echo "A database already exists in $DATA_DIR; not overwriting it. Remove it first if you really want to import." >&2
    exit 1
  fi
  say "Importing $IMPORT_DB"
  # The SQLite backup API folds any write-ahead log in, so the copy is consistent.
  node -e '
    const D = require(require.resolve("better-sqlite3", { paths: ["'"$APP_DIR"'/packages/core"] }));
    new D(process.argv[1], { readonly: true }).backup(process.argv[2]).then(() => console.log("imported"));
  ' "$IMPORT_DB" "$DATA_DIR/lumina.db"
  if [ -f "$(dirname "$IMPORT_DB")/lumina.key" ]; then cp "$(dirname "$IMPORT_DB")/lumina.key" "$DATA_DIR/lumina.key"; fi
  chown lumina:lumina "$DATA_DIR"/lumina.*
  chmod 600 "$DATA_DIR"/lumina.*
fi

if [ ! -e "$DATA_DIR/config.json" ]; then
  if [ "$HTTP_ONLY" -eq 1 ]; then
    echo '{ "port": 8080, "tls": "off", "httpRedirectPort": 0, "names": [], "hsts": false }' > "$DATA_DIR/config.json"
  else
    echo '{ "port": 443, "tls": "auto", "httpRedirectPort": 80, "names": [], "hsts": false }' > "$DATA_DIR/config.json"
  fi
  chown lumina:lumina "$DATA_DIR/config.json"
  chmod 600 "$DATA_DIR/config.json"
fi

say "Installing the service"
cat > /etc/systemd/system/lumina.service <<EOF
[Unit]
Description=Lumina homelab dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=lumina
Group=lumina
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=LUMINA_DATA=$DATA_DIR
ExecStart=$(command -v node) packages/core/dist/index.js
Restart=always
RestartSec=2
UMask=0077
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
PrivateDevices=true
ProtectHostname=true
ProtectClock=true
ProtectKernelLogs=true
ProtectProc=invisible
ProcSubset=pid
RestrictRealtime=true
RestrictNamespaces=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable lumina >/dev/null 2>&1
systemctl restart lumina || true
sleep 2
if ! systemctl is-active --quiet lumina && journalctl -u lumina -n 30 --no-pager 2>/dev/null | grep -qiE 'namespace|226|SYS|status=159'; then
  echo "This container does not allow filesystem sandboxing; relaxing those service options."
  sed -i '/^PrivateTmp=/d;/^ProtectSystem=/d;/^ProtectHome=/d;/^ReadWritePaths=/d;/^ProtectKernel/d;/^ProtectControlGroups=/d;/^PrivateDevices=/d;/^ProtectHostname=/d;/^ProtectClock=/d;/^ProtectProc=/d;/^ProcSubset=/d;/^RestrictNamespaces=/d;/^SystemCallFilter=/d' /etc/systemd/system/lumina.service
  systemctl daemon-reload
  systemctl restart lumina || true
fi

say "Waiting for Lumina to come up"
PORT="$(node -p "require('$DATA_DIR/config.json').port")"
SCHEME="$(node -p "require('$DATA_DIR/config.json').tls === 'off' ? 'http' : 'https'")"
for _ in $(seq 1 40); do
  if curl -ksf "$SCHEME://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    IP="$(hostname -I | awk '{print $1}')"
    SUFFIX=""; { [ "$SCHEME" = https ] && [ "$PORT" != 443 ]; } || { [ "$SCHEME" = http ] && [ "$PORT" != 80 ]; } && SUFFIX=":$PORT"
    echo
    echo "Lumina is running:  $SCHEME://$IP$SUFFIX/"
    [ "$SCHEME" = https ] && echo "(Your browser will warn about the self-signed certificate the first time; choose Advanced -> continue.)"
    if [ -s "$DATA_DIR/setup-code" ]; then
      echo
      echo "  Setup code (needed once, to create the first admin): $(cat "$DATA_DIR/setup-code")"
      echo
    fi
    echo "Open it to create the admin account — or restore a backup from another Lumina."
    echo "Logs: journalctl -u lumina -f      Upgrade: re-run this installer."
    exit 0
  fi
  sleep 1
done
echo "Lumina did not answer in time. Check:  journalctl -u lumina -n 50" >&2
exit 1
