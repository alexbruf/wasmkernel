#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Building wasmkernel.wasm ==="
cmake -B build -DCMAKE_TOOLCHAIN_FILE=cmake/wasi-sdk.cmake -DCMAKE_BUILD_TYPE=Release 2>&1 | tail -3
cmake --build build 2>&1 | tail -3

echo ""
echo "=== Compiling guest test programs ==="
WASI_SDK="${WASI_SDK_PATH:-/tmp/wasi-sdk-25.0-arm64-macos}"
for src in tests/guest/*.c; do
    out="${src%.c}.wasm"
    "$WASI_SDK/bin/clang" --target=wasm32-wasi -O2 "$src" -o "$out"
    echo "  $(basename "$out")"
done

echo ""
echo "=== Binary sizes ==="
ls -la build/wasmkernel.wasm | awk '{print "  kernel: " $5 " bytes"}'

echo ""
echo "=== Running tests ==="
bun test tests/
