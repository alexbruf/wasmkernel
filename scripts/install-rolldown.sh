#!/bin/bash
# Fetch the published @rolldown/binding-wasm32-wasi tarball and stage it
# under tests/pkgs/rolldown/package/ so tests/host/test_rolldown.mjs can
# load it. The wasm itself is ~12MB and not committed to the repo —
# this script repopulates it on demand.
#
# Idempotent: skips download if the file is already present.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/tests/pkgs/rolldown/package"
WASM="$DEST/rolldown-binding.wasm32-wasi.wasm"

if [ -f "$WASM" ]; then
    echo "rolldown binding already present at $WASM"
    exit 0
fi

mkdir -p "$DEST"
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

cd "$TMP"
echo "fetching @rolldown/binding-wasm32-wasi via npm pack..."
npm pack @rolldown/binding-wasm32-wasi >/dev/null
TGZ=$(ls rolldown-binding-wasm32-wasi-*.tgz | head -1)
tar -xzf "$TGZ"

# Stage the four files we actually use. The .cjs loader resolves the
# wasm relative to its own __dirname, so they have to live together.
for f in rolldown-binding.wasm32-wasi.wasm \
         rolldown-binding.wasi.cjs \
         wasi-worker.mjs \
         package.json; do
    cp "package/$f" "$DEST/$f"
done

echo "installed rolldown binding into $DEST"
ls -lh "$DEST"
