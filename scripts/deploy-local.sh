#!/usr/bin/env bash
# Developer shortcut: build here, copy only the compiled output into the installed copy, restart the service.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm -r build >/dev/null
# Package manifests and the lockfile travel too, so a new module package gets linked.
for f in package.json pnpm-lock.yaml pnpm-workspace.yaml; do install -m 644 "$f" "/opt/lumina/$f"; done
for pj in packages/*/package.json packages/modules/*/package.json; do install -D -m 644 "$pj" "/opt/lumina/$pj"; done
(cd /opt/lumina && pnpm install --silent --frozen-lockfile)
for d in ui core sdk; do rsync -a --delete "packages/$d/dist/" "/opt/lumina/packages/$d/dist/"; done
for m in packages/modules/*/dist; do mkdir -p "/opt/lumina/$m"; rsync -a --delete "$m/" "/opt/lumina/$m/"; done
systemctl restart lumina
echo "deployed; waiting for health..."
for _ in $(seq 1 30); do curl -ksf https://127.0.0.1/health >/dev/null 2>&1 && { echo ok; exit 0; }; sleep 1; done
echo "not healthy yet: journalctl -u lumina -n 30" >&2; exit 1
