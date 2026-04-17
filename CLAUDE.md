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

## Paged guest memory (for Cloudflare Durable Objects)

The kernel is built with `WASMKERNEL_PAGED_MEMORY=1` always. The guest's linear memory is indexed via a flat `uint16_t` page table (`g_page_table` in `src/kernel/paged_mem.c`) that maps logical pages to hot-window slots. WAMR's `CHECK_MEMORY_OVERFLOW` and `CHECK_BULK_MEMORY_OVERFLOW` macros are overridden via `src/kernel/paged_mem_hooks.h` to route through the page table; `wasm_runtime_addr_app_to_native` is likewise patched so kernel-side WASI natives see the authoritative hot-window data.

**Identity mode (default)**: when `kernel_set_hot_window_pages(n)` is not called (or `n >= logical_pages`), `g_hot_base == memory->memory_data` and slot N = page N, so behavior matches pre-paging. All existing tests pass unchanged.

**Paged mode**: host calls `kernel_set_hot_window_pages(n)` before `kernel_load` with `n < logical_pages`, then registers a page-fault handler via `kernel_register_page_fault_slot(slot)` reusing the generic `host_func_call` bridge. `packages/wasmkernel/src/page_cache.js` (clock eviction) drives a host-provided `MemoryBackend`; `packages/wasmkernel/src/backends/sqlite_do.js` implements one against the DO SQLite API. `tests/host/test_paged_memory.mjs` exercises the round-trip with a WASI guest (alloc.wasm).

## RSS (committed-memory) tuning — critical for CF Workers

Two platform decisions used to burn ~65 MB of RSS per kernel instance, both now fixed:

1. **`os_mmap` memset**: `src/platform_wasi/platform_init.c`'s `os_mmap` used to `memset(0, size)` after `malloc`. That touched every page of the allocation, forcing V8 to physically commit the whole region (V8's WebAssembly.Memory is lazy-commit until first touch). Removed — freshly-grown linear memory pages are already zeroed by V8.

2. **WAMR app-heap default**: `wasm_runtime_instantiate` used a 64 MB `heap_size` argument, which appended 64 MB to the guest's linear memory even for guests that never call `wasm_runtime_module_malloc` (most NAPI guests use their own wasi-libc allocator). Now `kernel_set_app_heap_size(n)` is exported and `instantiate.js` defaults `n=0`. Callers that need the WAMR heap pass `opts.appHeapSize`.

Together these drop RSS-at-load for a 1004-page guest (rolldown-equivalent) from ~65 MB to ~0.7 MB; the guest's logical memory is reserved in V8's address space but physical pages only commit as the guest touches them. See `tests/host/measure_rss.mjs` for the benchmark.

**CF 128 MB cap — current v0.1.9 limitation, NOT enforced**: once a page is committed (guest wrote to it), V8 doesn't decommit on CF Workers — no `madvise(DONTNEED)` path available from JS. The v0.1.9 paging system uses an **in-place swap model** (slot index == logical page; `g_hot_base == memory_data`); evictions zero the page in memory_data but CF V8 keeps it committed. Net effect: committed RSS on CF grows up to the guest's peak working set regardless of `hotWindowPages`. On Node (where V8 honours zero-writes via `MADV_FREE`), RSS actually drops as configured.

**In short**: paging is correctness-complete everywhere but only RSS-effective on Node. On CF Workers, `hotWindowPages` is advisory — it controls how much memory must round-trip through the backend, not how much is physically resident.

For CF to honour `hotWindowPages` as a hard RSS cap, slot cycling is required: slot ∈ `[0, hotWindowPages)`, cycling across logical pages so only that many physical pages of memory_data ever get written. An attempt at this landed a WAMR init-memory intercept + JS-side clock allocator but stalled on an unfound WAMR internal path that computes `memory_data + logical_offset` without going through the paged macro — oxc-parser trapped "out of bounds memory access" during napi register after only 3 faults (same failure mode as an earlier abandoned iteration). Not shipped. Future work would need deeper instrumentation of every `memory_data` deref site during guest execution.

## Remaining work for full NAPI-paged support

The JS bridge has been refactored to route guest-memory accesses through `packages/wasmkernel/src/guest_memory.js` (`NapiRuntime`, `defaultWasiBridges`). `wasi_passthrough.js` still hands raw `guest_base + ptr` pointers to the host's wasi shim and works in identity mode only — for paged-mode runs with a filesystem, provide `wasiBridges` overrides that route through `GuestMemory` instead.

## WAMR range-check patches for paged mode

WAMR has several functions that assume native pointers into guest memory lie inside `[memory_data, memory_data_end)`. In paged mode the interpreter's `CHECK_MEMORY_OVERFLOW` hands out pointers into the separate hot-window allocation, so these functions spuriously flagged OOB. Patched to additionally accept `[g_hot_base, g_hot_base + hot_window_pages * 64 KB)`:

- `wasm_runtime_atomic_wait` / `wasm_runtime_atomic_notify` (`deps/wamr/core/iwasm/common/wasm_shared_memory.c`) — otherwise any guest atomic op on a hot-window pointer set `"out of bounds memory access"`. wasi-libc's single-thread locks trip this first.
- `wasm_runtime_validate_native_addr` (`wasm_memory.c`) — called by WAMR's host-side helpers before dereferencing a guest pointer.
- `wasm_runtime_get_native_addr_range` (`wasm_memory.c`) — returns the slot bounds (64 KB) when the pointer is in the hot window.
- `wasm_check_app_addr_and_convert` (`wasm_memory.c`) — routes the guest-offset → native-pointer translation through the paged layer so subsequent reads see live hot-window data rather than stale `memory_data`.
- `wasm_runtime_addr_app_to_native` was patched earlier in the same way.

After these patches, simple NAPI guests (argon2) ran with hot window smaller than logical memory. oxc-parser still traps `unreachable` in this model — likely one more WAMR site we haven't enumerated that reads memory_data directly.

## Paged memory: in-place swap model

Abandoned the separate-hot-window design in favor of in-place swap:

- `g_hot_base == memory_data` (no separate allocation).
- Slot index ≡ logical page index. No remapping.
- `g_page_table` degenerates into a residency bitmap: `g_page_table[i]` is either `i` (resident) or `INVALID` (cold).
- The macro's `maddr = g_hot_base + (slot << 16) + po` reduces to `memory_data + offset` — same as unpaged. WAMR's range checks against `[memory_data, memory_data_end)` naturally pass.
- `paged_mem_fault(page)` just loads the page back into memory_data at its natural offset from the backend; no eviction here.
- `PageCache.evictPage(page)` (JS-side, called when RSS pressure warrants) flushes the page to backend and zeros the memory_data region. On platforms where V8 decommits zero-written pages (Node with `madvise(MADV_FREE)`), RSS drops; on CF Workers where V8 doesn't, the zero is wasted but correctness is preserved.

oxc-parser and argon2 both load and run in this model with arbitrary hot-window sizes. The in-memory backend stores page copies in JS heap which inflates RSS; pair with the SQLite backend (`createSqliteBackend(ctx.storage.sql)`) to move cold pages outside the process.

To activate paging with eviction for real RSS savings:
1. Instantiate with `memoryBackend: createSqliteBackend(sql)` (or the Node variant).
2. The kernel-side paging machinery is automatic — every page access routes through the macro; first access loads from backend.
3. Eviction policy lives in JS: a periodic check of `process.memoryUsage().rss` and calls to `pageCache.evictPage(page)` on least-recently-used pages. Not wired into `instantiate.js` by default; callers that want it plug into `pageCache.refbit` and drive eviction themselves.
