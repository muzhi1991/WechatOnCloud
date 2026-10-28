#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../deploy/cua"
umask 077
mkdir -p secrets
chmod 700 secrets
for name in cua-token vnc-password; do
    if [[ ! -e secrets/$name ]]; then openssl rand -hex 32 | tr -d '\n' > "secrets/$name"; fi
    [[ -s secrets/$name ]] || { echo "Empty secret: $name" >&2; exit 1; }
    chmod 600 "secrets/$name"
done
if [[ ! -e .env ]]; then cp .env.example .env; fi
echo 'Canary secrets prepared; review BIND_IP in deploy/cua/.env before starting.'
