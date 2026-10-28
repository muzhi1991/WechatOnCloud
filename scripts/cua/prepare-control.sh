#!/bin/sh
set -eu
cd "$(dirname "$0")/../../deploy/cua-control"
umask 077
mkdir -p secrets/instances
chmod 700 secrets secrets/instances
for name in cua-sync-token cua-agent-token panel-admin-password; do
  if [ ! -f "secrets/$name" ]; then openssl rand -hex 32 > "secrets/$name"; fi
  chmod 600 "secrets/$name"
done
printf 'P3 credentials prepared without overwriting existing secrets.\n'
