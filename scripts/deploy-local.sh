#!/usr/bin/env bash
# Developer shortcut: build here, copy only the compiled output into the installed copy, restart the service.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm -r build >/dev/null
for d in ui core sdk; do rsync -a --delete "packages/$d/dist/" "/opt/lumina/packages/$d/dist/"; done
for m in packages/modules/*/dist; do rsync -a --delete "$m/" "/opt/lumina/$m/"; done
systemctl restart lumina
echo "deployed; waiting for health..."
for _ in $(seq 1 30); do curl -ksf https://127.0.0.1/health >/dev/null 2>&1 && { echo ok; exit 0; }; sleep 1; done
echo "not healthy yet: journalctl -u lumina -n 30" >&2; exit 1
