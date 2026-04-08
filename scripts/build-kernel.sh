#!/bin/bash
# Build wasmkernel.wasm from the C source via wasi-sdk + asyncify.
#
# Output: build/wasmkernel.wasm
#
# Honours WASI_SDK_PATH (defaults to /opt/wasi-sdk or /tmp/wasi-sdk-* on macOS,
# see cmake/wasi-sdk.cmake).
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v wasm-opt >/dev/null 2>&1; then
    echo "error: wasm-opt not found (install binaryen)" >&2
    exit 1
fi

echo "=== cmake configure ==="
cmake -B build -DCMAKE_TOOLCHAIN_FILE=cmake/wasi-sdk.cmake -DCMAKE_BUILD_TYPE=Release | tail -3

echo "=== cmake build ==="
# CMakeLists.txt has a POST_BUILD step that applies asyncify already, so
# we don't run wasm-opt --asyncify here.
cmake --build build | tail -5

echo "  built $(wc -c < build/wasmkernel.wasm) bytes"
