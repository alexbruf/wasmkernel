# NAPI async work / TSFN callbacks from cooperative threads never complete

## Summary

When running Rolldown (a Rust-based JS bundler compiled to `wasm32-wasip1-threads`) via wasmkernel, `napi_resolve_deferred` is never called after async bundling completes. The Promise returned by `BindingBundler.generate()` hangs indefinitely.

Plugin callbacks (resolveId, load) fire correctly via TSFN during the build — the issue is specifically the final Promise resolution after all work is done.

## Environment

- wasmkernel 0.1.7
- Rolldown 1.0.0-rc.12 (no-SIMD build: `-C target-feature=-simd128`)
- `@bjorn3/browser_wasi_shim` 0.4.2
- Running in Cloudflare Workers (miniflare/workerd) via Vite dev server
- Also reproduced in standalone Node.js

## Reproduction

```js
import { instantiateNapiModule } from "@alexbruf/wasmkernel/browser";
import { WASI, PreopenDirectory, ConsoleStdout } from "@bjorn3/browser_wasi_shim";

const wasm = new Uint8Array(fs.readFileSync("rolldown-binding.wasm32-wasi.wasm"));
const kernelBytes = new Uint8Array(fs.readFileSync("wasmkernel.wasm"));

const fds = [
  new ConsoleStdout(() => {}),
  ConsoleStdout.lineBuffered(() => {}),
  ConsoleStdout.lineBuffered(() => {}),
  new PreopenDirectory("/", new Map()),
];
const wasi = new WASI([], [], fds);

const { napiModule, napiRuntime } = await instantiateNapiModule(wasm, {
  wasi,
  kernelBytes,
});

// Drain fix — without this, even the plugin callbacks don't fire
const origDispatch = napiRuntime.dispatch.bind(napiRuntime);
napiRuntime.dispatch = function (funcName, args, argsPtr) {
  const result = origDispatch(funcName, args, argsPtr);
  if (napiRuntime._pendingAsyncQueue?.length > 0) napiRuntime.drainAsyncQueue();
  if (napiRuntime.hasPendingTsfn?.()) napiRuntime.drainTsfnQueue();
  return result;
};

// Use rolldown — binding loads fine, 74 exports
const { rolldown } = await import("@rolldown/browser");
const bundle = await rolldown({
  input: "main.js",
  plugins: [
    {
      name: "vfs",
      resolveId(s) {
        return { id: s, external: true }; // simplest case
      },
      load(id) {
        return 'console.log("hello")';
      },
    },
  ],
  platform: "browser",
});

// This hangs — Promise never resolves or rejects
const result = await bundle.generate({ format: "esm" });
```

## What works

- **Binding initialization:** 430ms, 74 exports, all NAPI classes present (`BindingBundler`, `BindingPluginContext`, etc.)
- **Sync operations:** `parseSync` (1-165ms depending on file size), `transformSync` (1ms) — both produce correct output
- **Plugin TSFN callbacks:** `napi_call_threadsafe_function` fires correctly during bundling. `resolveId` and `load` plugin hooks are called, `BindingPluginContext` and `BindingLoadPluginContext` are created and unwrapped successfully
- **Async queue drain:** After patching `dispatch()` to call `drainAsyncQueue()` and `drainTsfnQueue()`, the plugin callbacks complete and return results to the guest

## What doesn't work

After all plugin callbacks complete, the Rust code should call `napi_resolve_deferred` to settle the generate() Promise. This never happens.

Instrumenting `napi_resolve_deferred` and `napi_reject_deferred` shows neither is ever called. The Promise just hangs.

## Analysis

Rolldown uses tokio's multi-thread runtime (via `tokio_unstable` cfg on `wasm32-wasip1-threads`). The async flow is:

1. JS calls `generate(opts)` → dispatches to WASM via `host_func_call`
2. Rust creates a Promise (`napi_create_promise`) ✅
3. Rust spawns a tokio task (via `napi::spawn`) that does the bundling
4. The tokio task calls plugin hooks via TSFN → these fire correctly ✅
5. After plugins complete, tokio task finishes and should call `napi_resolve_deferred`
6. **Step 5 never happens** ❌

The tokio tasks run on WAMR cooperative threads (via `wasi_thread_spawn`). During step 4, the TSFN callbacks trigger `host_func_call` which calls our patched `dispatch()` which drains the queues. This works because plugin calls are synchronous bridge calls.

But in step 5, the tokio task completes **inside a cooperative thread** and calls `napi_resolve_deferred` via the bridge. This call either:
- Never reaches `host_func_call` (the cooperative thread finishes without triggering a bridge call)
- Or reaches it but the drain doesn't run afterward (the cooperative thread is already done)

## What I think the fix is

`drainAsyncQueue()` and `drainTsfnQueue()` are defined in NapiRuntime but never called from within wasmkernel itself. They're designed to be "called by the host after each top-level kernel_call_indirect returns" (comment on line 2452).

The issue: after a cooperative thread completes its work and calls `napi_resolve_deferred`, control returns to WAMR's thread scheduler — but the scheduler doesn't notify the host that there are pending drains.

Possible fixes:

1. **Call drainAsyncQueue/drainTsfnQueue after each cooperative thread step completes.** When the WAMR thread scheduler returns from processing a thread quantum, check and drain both queues.

2. **Add a host callback for "thread completed" events.** When a cooperative thread finishes (wasi_thread_spawn'd thread exits), call a host function that triggers the drain.

3. **Integrate drains into the kernel_step() loop for cooperative threads.** If `kernel_step()` is called to drive cooperative threads, drain queues after each step.

The key constraint: the drains call `kernel_call_indirect_simple` which re-enters the guest. This is safe between thread quantum boundaries but not during a thread's execution. So the drain must happen at a point where no cooperative thread is mid-execution.

## Performance context

This is for running Rolldown inside a Cloudflare Durable Object to serve previews on mobile (where Nodepod's browser runtime is too heavy). Individual OXC operations through WAMR are fast:
- parseSync: 1-165ms
- transformSync: 1ms  
- 10-file batch transform: 6ms

If the async flow completes, the full bundle should take ~500ms-2s through WAMR — acceptable for a cached preview that rebuilds on each agent turn.
