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
- Phase 2 added cooperative scheduling: fuel-based preemption, wasi-threads thread-spawn, atomic wait/notify.
- Phase 3 added I/O bridge: host_io_* imports for async fd_read, poll_oneoff with clock subscriptions, sched_yield.
- The kernel imports `host_io_submit/check/result_bytes/result_error` from a `host` module at instantiation time.

## Root-caused: napi-rs memory layout mismatch (fixed via kernel_set_min_initial_pages)

Not a WAMR interpreter bug. The published napi-rs `*.wasi.cjs` loaders (parser.wasi.cjs, argon2.wasi.cjs, etc.) create an external shared memory with `new WebAssembly.Memory({ initial: 4000, maximum: 65536, shared: true })` and inject it via `overwriteImports`, **replacing** whatever initial the wasm module declares. So on V8 the guest sees 4000 initial pages (256 MB) at instantiation.

Our WAMR build was loading the guest with the module's declared initial (e.g. 980 pages = 64 MB for oxc-parser). Rust's wasi-libc allocator places its heap based on the actual memory size, so WAMR and V8 ended up with different allocator states → different buffer addresses → different memcpy overlap patterns.

With v0.124.0 specifically, WAMR's layout caused iter 14's "small" memcpy destination to land inside iter 14's "big" memcpy source (`dst=iter13_buf+8` inside `src=iter14_buf-336..iter14_buf-84`). The small memcpy overwrote iter 13's already-written buffer bytes 8-9, and the big memcpy then read those freshly-overwritten bytes back — propagating `0x10` to iter 14 byte 217 instead of `4`. V8's larger pool avoided the trigger window.

**Fix**: `kernel_set_min_initial_pages(n)` kernel export. The host calls it before `kernel_load` to hint a minimum initial page count. `napi_rs_loader.mjs` calls `kernel_set_min_initial_pages(4000)` to reproduce emnapi's environment. The bump is clamped to the module's declared `max_page_count` so small-memory guests (wasi-threads tests, etc.) are untouched.

**Validation**: all previously-broken oxc-parser versions pass 30/30 after the fix:
| Version | V8 | WAMR (before fix) | WAMR (after fix) |
|---|---|---|---|
| 0.115.0 | ✅ | ❌ iter 0 | ✅ |
| 0.120.0 | ✅ | ✅ | ✅ |
| 0.121.0 | ✅ | ✅ | ✅ |
| 0.123.0 | ✅ | ❌ iter 14 | ✅ |
| 0.124.0 | ✅ | ❌ iter 14 | ✅ |

5000-iter stress repro clean. Full bun suite 27/27. Upstream oxc-parser test runner 46/48 (2 failures are TC39 import-defer not yet in v0.124.0 — unrelated).

**Repro of the pre-fix bug**: `tests/ext/repro_oxc_strcorrupt.mjs` with `kernel_set_min_initial_pages` not called (edit napi_rs_loader.mjs to comment out the call).
