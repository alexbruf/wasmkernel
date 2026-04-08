#!/bin/bash
# Stage build/wasmkernel.wasm into packages/wasmkernel/ so the published
# tarball ships the latest binary. Idempotent.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

src="build/wasmkernel.wasm"
dst="packages/wasmkernel/wasmkernel.wasm"

if [ ! -f "$src" ]; then
    echo "error: $src not found — run scripts/build-kernel.sh first" >&2
    exit 1
fi

cp "$src" "$dst"
echo "synced $(wc -c < "$src") bytes → $dst"
