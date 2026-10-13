#!/bin/sh
# Makes the zip you attach to a GitHub release: build/Screenshot-Gallery.zip, with one folder "Screenshot Gallery" inside.
# Needs only zip. It packs the committed dist/index.js as it is (no pnpm, no build).
set -e
cd "$(dirname "$0")/.."
[ -f dist/index.js ] || { echo "dist/index.js is missing. Run 'pnpm i && pnpm build' once and commit dist/."; exit 1; }
rm -rf build && mkdir -p "build/Screenshot Gallery"
cp -R dist main.py plugin.json package.json LICENSE README.md "build/Screenshot Gallery/"
find "build/Screenshot Gallery" -name "__pycache__" -type d -prune -exec rm -rf {} +
(cd build && zip -qr Screenshot-Gallery.zip "Screenshot Gallery")
echo "Made build/Screenshot-Gallery.zip"
