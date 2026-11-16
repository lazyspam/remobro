#!/usr/bin/env bash
# Build the Chromium (Chrome, Brave, Edge, …) extension from the shared source in extension/:
#   dist/chromium/            load this with chrome://extensions → Developer mode → Load unpacked
#   dist/remobro-chromium.zip
# usage: scripts/build-chromium.sh [version]   (default: version from extension/manifest.json)
set -euo pipefail
cd "$(dirname "$0")/.."
version="${1:-$(jq -r .version extension/manifest.json)}"
rm -rf dist/chromium dist/remobro-chromium.zip
mkdir -p dist/chromium
cp -r extension/. dist/chromium/
rm dist/chromium/manifest.chromium.json dist/chromium/icons/icon.svg
jq --arg v "$version" '.version = $v' extension/manifest.chromium.json > dist/chromium/manifest.json
(cd dist/chromium && zip -qr ../remobro-chromium.zip .)
echo "dist/chromium (v$version) and dist/remobro-chromium.zip"
