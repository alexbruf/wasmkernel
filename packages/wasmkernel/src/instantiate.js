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
import { defaultWasiBridges, WASI_ENOSYS } from "./wasi_bridge.js";
import { wasiPassthrough } from "./wasi_passthrough.js";

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

  // Build the guest-side WASI bridge table in three layers, last wins:
  //
  // 1. defaultWasiBridges: empty-VFS stubs that return proper errnos
  //    for addons that never touch the filesystem (oxc-parser, argon2,
  //    bcrypt). Every function writes result pointers properly instead
  //    of silent 0n, so a no-fs addon gets a clean "ENOENT everywhere"
  //    environment rather than uninitialised memory.
  //
  // 2. wasiPassthrough(opts.wasi): automatically forward every wasi
  //    function the caller's wasi library implements (node:wasi,
  //    @bjorn3/browser_wasi_shim, etc.), with pointer translation
  //    applied so the shim's memory reads/writes land in the guest
  //    memory region. Callers populate their wasi with a real or
  //    in-memory filesystem via its normal API — no bridges boilerplate.
  //
  // 3. opts.wasiBridges: user overrides on top of everything else, for
  //    callers who want to intercept a specific function (e.g. trace,
  //    virtual stdin, custom random). Accepts either a plain object or
  //    a `(kernel) => object` factory.
  const passthrough = wasiPassthrough({ wasi: opts.wasi })(k);
  const userBridges =
    typeof opts.wasiBridges === "function"
      ? opts.wasiBridges(k)
      : (opts.wasiBridges || {});
  const wasiBridges = {
    ...defaultWasiBridges(() => k),
    ...passthrough,
    ...userBridges,
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
      bridgeFunctions.set(i, (args, argsPtr) => {
        const r = handler(args, argsPtr);
        return typeof r === "bigint" ? r : BigInt(r ?? 0);
      });
    } else {
      // Unknown guest import — fail loudly with ENOSYS instead of the
      // old silent-0n fallback, which caused hangs when Rust code read
      // uninitialised output pointers back.
      const unknownName = `${mod}.${field}`;
      bridgeFunctions.set(i, () => {
        if (!wasiBridges.__warned) wasiBridges.__warned = new Set();
        if (!wasiBridges.__warned.has(unknownName)) {
          wasiBridges.__warned.add(unknownName);
          console.warn(`[wasmkernel] unhandled guest import: ${unknownName} — returning ENOSYS`);
        }
        return WASI_ENOSYS;
      });
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
  //
  // napi-rs emits register functions in declaration order but the wasm
  // export section may reorder them. __napi_register__<T>_struct_N must
  // run before __napi_register__<T>_impl_N (struct defines the class,
  // impl adds methods). Sort by the trailing integer so calls happen in
  // source-declaration order regardless of export layout.
  const _asyncNapiRegisterNames = guestExports
    .filter((e) => e.kind === "function" && e.name.startsWith("__napi_register__"))
    .map((e) => ({ name: e.name, idx: (/_(\d+)$/.exec(e.name) || [])[1] }))
    .map(({ name, idx }) => ({ name, idx: idx ? parseInt(idx, 10) : Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.idx - b.idx)
    .map((e) => e.name);

  const stubInstance = {
    exports: Object.fromEntries(
      _asyncNapiRegisterNames.map((name) => [name, () => kernelCall(name)])
    ),
  };
  if (typeof opts.beforeInit === "function") {
    opts.beforeInit({ instance: stubInstance });
  } else {
    // Auto-call every __napi_register__* export in declaration order.
    for (const name of _asyncNapiRegisterNames) stubInstance.exports[name]();
  }

  // napi_register_module_v1 → falls back to napi_register_wasm_v1.
  const ap = k.kernel_alloc(8);
  new DataView(k.memory.buffer).setUint32(ap, 1, true);
  new DataView(k.memory.buffer).setUint32(ap + 4, exportsHandle, true);
  // Prefer napi_register_wasm_v1 for wasm addons — it's the entry point
  // napi-rs wasm targets use and matches emnapi's behaviour. Fall back
  // to napi_register_module_v1 for native-style modules that only ship
  // the newer entry. Oxide exports both but only _wasm_v1 sets up the
  // class the way scan() expects; calling _module_v1 leaves the napi
  // class registration subtly different and scan() later hangs.
  let callResult = kernelCall("napi_register_wasm_v1", ap, 2);
  if (callResult === -2) callResult = kernelCall("napi_register_module_v1", ap, 2);

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

  // Three-layer wasi bridge (see async path for the full explanation):
  //   1. empty-VFS defaults
  //   2. automatic passthrough to opts.wasi
  //   3. user overrides
  const _passthrough = wasiPassthrough({ wasi: opts.wasi })(k);
  const _userBridges =
    typeof opts.wasiBridges === "function"
      ? opts.wasiBridges(k)
      : (opts.wasiBridges || {});
  const wasiBridges = {
    ...defaultWasiBridges(() => k),
    ..._passthrough,
    ..._userBridges,
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
      bridgeFunctions.set(i, (args, argsPtr) => {
        const r = handler(args, argsPtr);
        return typeof r === "bigint" ? r : BigInt(r ?? 0);
      });
    } else {
      const unknownName = `${mod}.${field}`;
      bridgeFunctions.set(i, () => {
        if (!wasiBridges.__warned) wasiBridges.__warned = new Set();
        if (!wasiBridges.__warned.has(unknownName)) {
          wasiBridges.__warned.add(unknownName);
          console.warn(`[wasmkernel] unhandled guest import: ${unknownName} — returning ENOSYS`);
        }
        return WASI_ENOSYS;
      });
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

  // Sort __napi_register__* by trailing index so struct_N runs before
  // impl_M when M > N. See detailed explanation in the async path above.
  const _syncNapiRegisterNames = guestExports
    .filter((e) => e.kind === "function" && e.name.startsWith("__napi_register__"))
    .map((e) => ({ name: e.name, idx: (/_(\d+)$/.exec(e.name) || [])[1] }))
    .map(({ name, idx }) => ({ name, idx: idx ? parseInt(idx, 10) : Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.idx - b.idx)
    .map((e) => e.name);

  const stubInstance = {
    exports: Object.fromEntries(
      _syncNapiRegisterNames.map((name) => [name, () => kernelCall(name)])
    ),
  };
  if (typeof opts.beforeInit === "function") {
    opts.beforeInit({ instance: stubInstance });
  } else {
    for (const name of _syncNapiRegisterNames) stubInstance.exports[name]();
  }

  const ap = k.kernel_alloc(8);
  new DataView(k.memory.buffer).setUint32(ap, 1, true);
  new DataView(k.memory.buffer).setUint32(ap + 4, exportsHandle, true);
  // Prefer napi_register_wasm_v1 for wasm addons — it's the entry point
  // napi-rs wasm targets use and matches emnapi's behaviour. Fall back
  // to napi_register_module_v1 for native-style modules that only ship
  // the newer entry. Oxide exports both but only _wasm_v1 sets up the
  // class the way scan() expects; calling _module_v1 leaves the napi
  // class registration subtly different and scan() later hangs.
  let callResult = kernelCall("napi_register_wasm_v1", ap, 2);
  if (callResult === -2) callResult = kernelCall("napi_register_module_v1", ap, 2);

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
