#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ $(uname -m) == x86_64 ]] || { echo 'P1 build requires Linux amd64' >&2; exit 1; }
mkdir -p artifacts
asset=artifacts/cua-spacesd
sha=73f4ab392d7832561b454ce137114f22242753f43a9e95166259bbf72e514379
if ! echo "$sha  $asset" | sha256sum -c - >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 20 --max-time 900 \
      https://github.com/trycua/cua/releases/download/cua-spacesd-v0.6.0/cua-spacesd-x86_64-unknown-linux-gnu \
      -o "$asset.part"
    echo "$sha  $asset.part" | sha256sum -c -
    mv "$asset.part" "$asset"
fi
docker buildx build --load --provenance=false --sbom=false \
    -f docker/cua/Dockerfile -t local/woc-cua:1.5.2-cua0.6.0-p1 .
