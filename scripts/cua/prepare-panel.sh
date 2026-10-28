#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../deploy/cua-panel"
umask 077
mkdir -p secrets/instances
chmod 700 secrets secrets/instances
for name in cua-sync-token panel-admin-password; do
    if [[ ! -e secrets/$name ]]; then openssl rand -hex 32 | tr -d '\n' > "secrets/$name"; fi
    [[ -s secrets/$name ]] || { echo "Empty secret: $name" >&2; exit 1; }
    chmod 600 "secrets/$name"
done
echo 'Panel credentials prepared without overwriting existing secrets.'
