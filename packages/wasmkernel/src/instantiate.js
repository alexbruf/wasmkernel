/**
 * Platform-agnostic "instantiate" — takes a guest wasm, a WASI impl, a
 * kernel-binary provider, and returns the same shape as @napi-rs/wasm-runtime's
 * instantiateNapiModuleSync: { instance, module, napiModule }.
 *
 * Callers (node/browser/worker entries) supply:
 *   wasi        — a wasi_snapshot_preview1 implementation
 *                 (Node's node:wasi, @bjorn3/browser_wasi_shim, etc.)
 *   kernelBytes — Uint8Array of wasmkernel.wasm
 *
 * Guest options mirror the @napi-rs/wasm-runtime API:
 *   context, asyncWorkPoolSize, onCreateWorker, overwriteImports({env, napi, emnapi, memory}),
 *   beforeInit({instance}), reuseWorker.
 */
import { NapiRuntime } from "./napi_runtime.js";

/** @param {Uint8Array} kernelBytes
 *  @param {Uint8Array} guestBytes
 *  @param {{
 *    context?: any,
 *    wasi: any,
 *    asyncWorkPoolSize?: number,
 *    onCreateWorker?: () => any,
 *    overwriteImports?: (imports: any) => any,
 *    beforeInit?: ({instance}: {instance: any}) => void,
 *    reuseWorker?: boolean,
 *    wasiBridges?: Record<string, (args: number[]) => bigint>,
 *    minInitialPages?: number,
 *  }} opts
 */
export async function instantiateNapiModule(kernelBytes, guestBytes, opts = {}) {
  // Host bridges for wasmkernel's own imports.
  const pendingIO = new Map();
  const bridgeFunctions = new Map();
  let k;
  const hostImports = {
    host_func_call(funcIdx, argsPtr, argc) {
      const handler = bridgeFunctions.get(funcIdx);
      if (!handler) return 0n;
      const args = [];
      for (let i = 0; i < argc; i++)
        args.push(new DataView(k.memory.buffer).getUint32(argsPtr + i * 8, true));
      try { return handler(args, argsPtr); }
      catch (e) { console.error("[wasmkernel] bridge err:", e); return 0n; }
    },
    host_io_submit(cb) { pendingIO.set(cb, { bytes: 0, error: 0 }); },
    host_io_check(cb) { return pendingIO.has(cb) ? 1 : 0; },
    host_io_result_bytes(cb) { return pendingIO.get(cb)?.bytes ?? 0; },
    host_io_result_error(cb) {
      const r = pendingIO.get(cb);
      if (r) pendingIO.delete(cb);
      return r?.error ?? 8;
    },
  };

  const kernelModule = await WebAssembly.compile(kernelBytes);
  const instance = await WebAssembly.instantiate(kernelModule, {
    wasi_snapshot_preview1: opts.wasi.wasiImport,
    host: hostImports,
  });
  // Initialize WASI. Both node:wasi and @bjorn3/browser_wasi_shim expose
  // the same `initialize(instance)` entry point.
  if (typeof opts.wasi.initialize === "function") opts.wasi.initialize(instance);
  else if (typeof opts.wasi.start === "function") {
    // Some shims want `start` for command modules. Our kernel is a reactor,
    // so this path is unlikely but kept for completeness.
  }
  k = instance.exports;
  k.kernel_init();

  // Match emnapi's default initial memory (4000 pages = 256 MB) so Rust's
  // allocator in the guest places buffers where it was validated against.
  // See CLAUDE.md "napi-rs memory layout mismatch" for the background.
  const minInit = opts.minInitialPages ?? 4000;
  if (k.kernel_set_min_initial_pages && minInit > 0)
    k.kernel_set_min_initial_pages(minInit);

  // Load the guest.
  const ptr = k.kernel_alloc(guestBytes.length);
  new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
  if (k.kernel_load(ptr, guestBytes.length) !== 0) {
    throw new Error("wasmkernel: kernel_load failed");
  }

  const napiRuntime = new NapiRuntime(k);

  // WASI host-bridge defaults. The kernel ships stubs for most wasi
  // imports; we only override what the typical napi-rs addon actually
  // calls from its Rust runtime. Callers can add more via opts.wasiBridges.
  const wasiBridges = {
    random_get(args) {
      const [bufPtr, bufLen] = args;
      const base = k.kernel_guest_memory_base();
      const mem = new Uint8Array(k.memory.buffer);
      // Use crypto-quality random if available.
      if (typeof globalThis.crypto?.getRandomValues === "function") {
        const chunk = new Uint8Array(Math.min(bufLen, 65536));
        let remaining = bufLen, off = 0;
        while (remaining > 0) {
          const n = Math.min(chunk.length, remaining);
          globalThis.crypto.getRandomValues(chunk.subarray(0, n));
          mem.set(chunk.subarray(0, n), base + bufPtr + off);
          off += n; remaining -= n;
        }
      } else {
        // Fallback for environments without crypto.
        for (let i = 0; i < bufLen; i++)
          mem[base + bufPtr + i] = (Math.random() * 256) | 0;
      }
      return 0n;
    },
    ...(opts.wasiBridges || {}),
  };

  // Wire bridges.
  const bridgeCount = k.kernel_bridge_count();
  const infoBuf = k.kernel_alloc(256);
  for (let i = 0; i < bridgeCount; i++) {
    const len = k.kernel_bridge_info(i, infoBuf, 256);
    if (!len) continue;
    const bytes = new Uint8Array(k.memory.buffer, infoBuf, len);
    const parts = []; let start = 0;
    for (let j = 0; j < len; j++) {
      if (bytes[j] === 0) {
        parts.push(new TextDecoder().decode(bytes.slice(start, j)));
        start = j + 1;
      }
    }
    const [mod, field] = parts;
    if ((mod === "env" || mod === "emnapi" || mod === "napi") && napiRuntime[field]) {
      const fn = field;
      bridgeFunctions.set(i, (args, argsPtr) => napiRuntime.dispatch(fn, args, argsPtr));
    } else if (mod === "wasi_snapshot_preview1" && wasiBridges[field]) {
      const handler = wasiBridges[field];
      bridgeFunctions.set(i, (args) => handler(args));
    } else {
      bridgeFunctions.set(i, () => 0n);
    }
  }

  // Let the scheduler drain startup (reactor modules' wasm start section
  // has already run; this lets any _initialize / _start-style guests finish).
  let status = 0;
  while (status === 0) status = k.kernel_step();

  // Build the napi-rs-compatible result. napi-rs's loaders use instance,
  // module, and napiModule. `napiModule.exports` is what user code sees.
  const exportsObj = {};
  const exportsHandle = napiRuntime._newHandle(exportsObj);

  const kernelCall = (name, argsPtr = 0, argCount = 0) => {
    const nameBytes = new TextEncoder().encode(name);
    const np = k.kernel_alloc(nameBytes.length + 1);
    new Uint8Array(k.memory.buffer, np, nameBytes.length).set(nameBytes);
    new Uint8Array(k.memory.buffer)[np + nameBytes.length] = 0;
    return k.kernel_call(np, argsPtr, argCount);
  };

  // napi-rs register pattern: first call all __napi_register__* exports,
  // then napi_register_module_v1 (or legacy napi_register_wasm_v1).
  // We need to know the export names — WebAssembly.Module.exports() gives
  // us that from the original bytes.
  const guestModule = await WebAssembly.compile(guestBytes);
  const guestExports = WebAssembly.Module.exports(guestModule);

  // beforeInit hook — emnapi calls this to let callers run
  // __napi_register__* functions on the raw instance. Our "instance" is
  // a stand-in object whose .exports maps export names to wrappers.
  const stubInstance = {
    exports: Object.fromEntries(
      guestExports
        .filter((e) => e.kind === "function" && e.name.startsWith("__napi_register__"))
        .map((e) => [e.name, () => kernelCall(e.name)])
    ),
  };
  if (typeof opts.beforeInit === "function") {
    opts.beforeInit({ instance: stubInstance });
  } else {
    // Auto-call every __napi_register__* export — matches the common pattern.
    for (const name of Object.keys(stubInstance.exports)) stubInstance.exports[name]();
  }

  // napi_register_module_v1 → falls back to napi_register_wasm_v1.
  const ap = k.kernel_alloc(8);
  new DataView(k.memory.buffer).setUint32(ap, 1, true);
  new DataView(k.memory.buffer).setUint32(ap + 4, exportsHandle, true);
  let callResult = kernelCall("napi_register_module_v1", ap, 2);
  if (callResult === -2) callResult = kernelCall("napi_register_wasm_v1", ap, 2);

  if (napiRuntime.exceptionPending) {
    const e = napiRuntime.lastException;
    napiRuntime.exceptionPending = false;
    napiRuntime.lastException = null;
    throw e;
  }
  if (callResult !== 0) throw new Error(`wasmkernel: napi_register failed: ${callResult}`);

  const retHandle = new DataView(k.memory.buffer).getUint32(ap, true);
  const napiExports = napiRuntime._getHandle(retHandle) ?? exportsObj;

  return {
    instance,
    module: kernelModule,
    napiModule: { exports: napiExports },
    // Expose internals for callers that need them
    kernel: k,
    napiRuntime,
  };
}

/** Compatibility export — most napi-rs published loaders call this
 *  synchronously, but the underlying operations are async (WebAssembly.compile
 *  is async on browsers). We expose a synchronous wrapper for Node where
 *  WebAssembly.Module can be constructed synchronously, and fall back to an
 *  async path on browsers (where callers must `await` the result).
 */
export function instantiateNapiModuleSync(kernelBytes, guestBytes, opts) {
  // Real Node: synchronous WebAssembly.Module + Instance
  const kernelModule = new WebAssembly.Module(kernelBytes);
  return instantiateNapiModuleNodeSync(kernelModule, kernelBytes, guestBytes, opts);
}

/** Sync path that skips the async compile for Node. */
function instantiateNapiModuleNodeSync(kernelModule, kernelBytes, guestBytes, opts) {
  // We can't `await` in a sync function, so we copy the async body here
  // with WebAssembly.instantiate replaced by `new Instance`.
  const pendingIO = new Map();
  const bridgeFunctions = new Map();
  let k;
  const hostImports = {
    host_func_call(funcIdx, argsPtr, argc) {
      const handler = bridgeFunctions.get(funcIdx);
      if (!handler) return 0n;
      const args = [];
      for (let i = 0; i < argc; i++)
        args.push(new DataView(k.memory.buffer).getUint32(argsPtr + i * 8, true));
      try { return handler(args, argsPtr); }
      catch (e) { console.error("[wasmkernel] bridge err:", e); return 0n; }
    },
    host_io_submit(cb) { pendingIO.set(cb, { bytes: 0, error: 0 }); },
    host_io_check(cb) { return pendingIO.has(cb) ? 1 : 0; },
    host_io_result_bytes(cb) { return pendingIO.get(cb)?.bytes ?? 0; },
    host_io_result_error(cb) {
      const r = pendingIO.get(cb);
      if (r) pendingIO.delete(cb);
      return r?.error ?? 8;
    },
  };

  const instance = new WebAssembly.Instance(kernelModule, {
    wasi_snapshot_preview1: opts.wasi.wasiImport,
    host: hostImports,
  });
  if (typeof opts.wasi.initialize === "function") opts.wasi.initialize(instance);
  k = instance.exports;
  k.kernel_init();

  const minInit = opts.minInitialPages ?? 4000;
  if (k.kernel_set_min_initial_pages && minInit > 0)
    k.kernel_set_min_initial_pages(minInit);

  const ptr = k.kernel_alloc(guestBytes.length);
  new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
  if (k.kernel_load(ptr, guestBytes.length) !== 0) {
    throw new Error("wasmkernel: kernel_load failed");
  }

  const napiRuntime = new NapiRuntime(k);

  const wasiBridges = {
    random_get(args) {
      const [bufPtr, bufLen] = args;
      const base = k.kernel_guest_memory_base();
      const mem = new Uint8Array(k.memory.buffer);
      if (typeof globalThis.crypto?.getRandomValues === "function") {
        const chunk = new Uint8Array(Math.min(bufLen, 65536));
        let remaining = bufLen, off = 0;
        while (remaining > 0) {
          const n = Math.min(chunk.length, remaining);
          globalThis.crypto.getRandomValues(chunk.subarray(0, n));
          mem.set(chunk.subarray(0, n), base + bufPtr + off);
          off += n; remaining -= n;
        }
      } else {
        for (let i = 0; i < bufLen; i++)
          mem[base + bufPtr + i] = (Math.random() * 256) | 0;
      }
      return 0n;
    },
    ...(opts.wasiBridges || {}),
  };

  const bridgeCount = k.kernel_bridge_count();
  const infoBuf = k.kernel_alloc(256);
  for (let i = 0; i < bridgeCount; i++) {
    const len = k.kernel_bridge_info(i, infoBuf, 256);
    if (!len) continue;
    const bytes = new Uint8Array(k.memory.buffer, infoBuf, len);
    const parts = []; let start = 0;
    for (let j = 0; j < len; j++) {
      if (bytes[j] === 0) {
        parts.push(new TextDecoder().decode(bytes.slice(start, j)));
        start = j + 1;
      }
    }
    const [mod, field] = parts;
    if ((mod === "env" || mod === "emnapi" || mod === "napi") && napiRuntime[field]) {
      const fn = field;
      bridgeFunctions.set(i, (args, argsPtr) => napiRuntime.dispatch(fn, args, argsPtr));
    } else if (mod === "wasi_snapshot_preview1" && wasiBridges[field]) {
      const handler = wasiBridges[field];
      bridgeFunctions.set(i, (args) => handler(args));
    } else {
      bridgeFunctions.set(i, () => 0n);
    }
  }

  let status = 0;
  while (status === 0) status = k.kernel_step();

  const exportsObj = {};
  const exportsHandle = napiRuntime._newHandle(exportsObj);
  const kernelCall = (name, argsPtr = 0, argCount = 0) => {
    const nameBytes = new TextEncoder().encode(name);
    const np = k.kernel_alloc(nameBytes.length + 1);
    new Uint8Array(k.memory.buffer, np, nameBytes.length).set(nameBytes);
    new Uint8Array(k.memory.buffer)[np + nameBytes.length] = 0;
    return k.kernel_call(np, argsPtr, argCount);
  };

  const guestModule = new WebAssembly.Module(guestBytes);
  const guestExports = WebAssembly.Module.exports(guestModule);

  const stubInstance = {
    exports: Object.fromEntries(
      guestExports
        .filter((e) => e.kind === "function" && e.name.startsWith("__napi_register__"))
        .map((e) => [e.name, () => kernelCall(e.name)])
    ),
  };
  if (typeof opts.beforeInit === "function") {
    opts.beforeInit({ instance: stubInstance });
  } else {
    for (const name of Object.keys(stubInstance.exports)) stubInstance.exports[name]();
  }

  const ap = k.kernel_alloc(8);
  new DataView(k.memory.buffer).setUint32(ap, 1, true);
  new DataView(k.memory.buffer).setUint32(ap + 4, exportsHandle, true);
  let callResult = kernelCall("napi_register_module_v1", ap, 2);
  if (callResult === -2) callResult = kernelCall("napi_register_wasm_v1", ap, 2);

  if (napiRuntime.exceptionPending) {
    const e = napiRuntime.lastException;
    napiRuntime.exceptionPending = false;
    napiRuntime.lastException = null;
    throw e;
  }
  if (callResult !== 0) throw new Error(`wasmkernel: napi_register failed: ${callResult}`);

  const retHandle = new DataView(k.memory.buffer).getUint32(ap, true);
  const napiExports = napiRuntime._getHandle(retHandle) ?? exportsObj;

  return {
    instance,
    module: kernelModule,
    napiModule: { exports: napiExports },
    kernel: k,
    napiRuntime,
  };
}

/** Minimal @napi-rs/wasm-runtime compat exports — callers don't use these
 *  meaningfully (they're vestigial emnapi APIs), but published loaders
 *  destructure them, so they must exist. */
export function getDefaultContext() {
  return { /* opaque — wasmkernel doesn't use emnapi's context */ };
}

export function createOnMessage(_fsApi) {
  // Noop message handler. napi-rs's fs-proxy-in-worker path is not used
  // by wasmkernel (we run the guest in the main thread's cooperative
  // scheduler). Returning a no-op is safe.
  return () => {};
}
