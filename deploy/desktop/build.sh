#!/bin/sh
set -eu
# Run from repository root on the Docker host. Never implicitly follow a moved base tag.
base=local/woc-cua:1.5.2-cua0.6.0-p4
expected=sha256:4a0b859c281fc097cc5e8d8c8b56f984e272963f41e8889eb78bbae4e0e1442a
actual=$(docker image inspect "$base" --format '{{.Id}}')
[ "$actual" = "$expected" ] || { echo 'Desktop base changed; review and revalidate it before building' >&2; exit 1; }
docker build --provenance=false --sbom=false --build-arg WOC_DESKTOP_BASE="$base" \
  -f docker/desktop/Dockerfile -t local/woc-desktop:1.5.2-cua0.6.0-d1 .
