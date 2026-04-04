# WasmKernel

Portable cooperative threading for WebAssembly. Compiles WAMR (WebAssembly Micro Runtime) to wasm32-wasi so it can interpret guest wasm modules with cooperative thread scheduling.

## Build

Requires wasi-sdk (currently at `/tmp/wasi-sdk-25.0-arm64-macos`).

```bash
cmake -B build -DCMAKE_TOOLCHAIN_FILE=cmake/wasi-sdk.cmake -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

## Test

Compile guest test programs first, then run tests:

```bash
# Compile guests
for src in tests/guest/*.c; do
  /tmp/wasi-sdk-25.0-arm64-macos/bin/clang --target=wasm32-wasi -O2 "$src" -o "${src%.c}.wasm"
done

# Run tests
bun test tests/
```

Or use the build script: `./scripts/build.sh`

## Architecture

- `src/platform_wasi/` — WAMR platform layer for wasm32-wasi (all OS APIs stubbed)
- `src/kernel/wasmkernel.c` — kernel entry point with WASI passthrough and exported API
- `deps/wamr/` — WAMR git submodule (pinned to WAMR-2.4.1)
- `tests/guest/` — C programs compiled to guest .wasm modules
- `tests/wasmkernel.test.ts` — bun test suite

## Key decisions

- WAMR native functions use the **raw API** (`wasm_runtime_register_natives_raw`) because the regular API uses function pointers that become `call_indirect` in wasm32, causing type mismatches.
- Build as a **reactor** (`-mexec-model=reactor`) so the host can call individual exports.
- WASI passthrough is minimal (fd_write to stdout/stderr, proc_exit, args/environ stubs).
- Phase 1 runs guest `_start` to completion in one shot (no cooperative scheduling yet).
