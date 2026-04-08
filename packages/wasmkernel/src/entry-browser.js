/**
 * Browser entry for @wasmkernel/runtime.
 *
 * Exposes the same API surface as the Node entry, but:
 *   - Uses fetch() to load the wasmkernel binary (async-only)
 *   - Requires the caller to supply a WASI shim (@bjorn3/browser_wasi_shim
 *     or equivalent) via the `wasi` option
 *   - Does NOT expose a sync version — browsers can't sync-compile wasm
 *
 * Usage:
 *
 *   import { instantiateNapiModule } from "@wasmkernel/runtime/browser";
 *   import { WASI } from "@bjorn3/browser_wasi_shim";
 *
 *   const guestBytes = new Uint8Array(await (await fetch("./addon.wasm")).arrayBuffer());
 *   const wasi = new WASI([], [], [], { debug: false });
 *   const { napiModule } = await instantiateNapiModule(guestBytes, { wasi });
 *   const addon = napiModule.exports;
 *
 * The `wasi` object must expose `wasiImport` (an object of WASI function
 * imports) and an `initialize(instance)` method. Both @bjorn3/browser_wasi_shim
 * and Node's node:wasi match this shape.
 */
import { NapiRuntime } from "./napi_runtime.js";
import { defaultWasiBridges, WASI_ENOSYS } from "./wasi_bridge.js";

/** Fetch and cache the kernel bytes. Resolved relative to this module.
 *  Used as a default when the caller doesn't supply their own kernel
 *  module/bytes. Won't work in environments without `fetch` of relative
 *  module URLs (e.g. Cloudflare Workers / workerd) — in those, pass
 *  `kernelModule` or `kernelBytes` in options. */
let _kernelBytesPromise = null;
function kernelBytes() {
  if (!_kernelBytesPromise) {
    const url = new URL("../wasmkernel.wasm", import.meta.url).href;
    _kernelBytesPromise = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
      return r.arrayBuffer();
    }).then((b) => new Uint8Array(b));
  }
  return _kernelBytesPromise;
}

export async function instantiateNapiModule(guestBytes, options = {}) {
  if (!options.wasi) {
    throw new Error(
      "@wasmkernel/runtime: options.wasi is required (pass a browser_wasi_shim instance)"
    );
  }

  // Caller may supply a pre-compiled kernel module (idiomatic in Cloudflare
  // Workers / workerd, where wasm is imported at build time) or raw bytes.
  // Falling back to fetch() works in normal browsers and bundlers that
  // honour `new URL(..., import.meta.url)` for assets.
  let kernelModule;
  if (options.kernelModule instanceof WebAssembly.Module) {
    kernelModule = options.kernelModule;
  } else {
    const kBytes = options.kernelBytes ?? (await kernelBytes());
    kernelModule = await WebAssembly.compile(kBytes);
  }

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

  const instance = await WebAssembly.instantiate(kernelModule, {
    wasi_snapshot_preview1: options.wasi.wasiImport,
    host: hostImports,
  });
  if (typeof options.wasi.initialize === "function") options.wasi.initialize(instance);
  k = instance.exports;
  k.kernel_init();

  const minInit = options.minInitialPages ?? 4000;
  if (k.kernel_set_min_initial_pages && minInit > 0) k.kernel_set_min_initial_pages(minInit);

  const ptr = k.kernel_alloc(guestBytes.length);
  new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
  if (k.kernel_load(ptr, guestBytes.length) !== 0) {
    throw new Error("wasmkernel: kernel_load failed");
  }

  const napiRuntime = new NapiRuntime(k);

  // Full empty-VFS WASI bridge for the GUEST's wasi_snapshot_preview1
  // imports. These run with guest-space pointers and write results into
  // guest memory. Callers can override individual functions via
  // `options.wasiBridges` to plug in a real filesystem / stdin / etc.
  const wasiBridges = {
    ...defaultWasiBridges(() => k),
    ...(options.wasiBridges || {}),
  };

  const bridgeCount = k.kernel_bridge_count();
  const infoBuf = k.kernel_alloc(256);
  for (let i = 0; i < bridgeCount; i++) {
    const len = k.kernel_bridge_info(i, infoBuf, 256);
    if (!len) continue;
    const bytes = new Uint8Array(k.memory.buffer, infoBuf, len);
    const parts = []; let start = 0;
    for (let j = 0; j < len; j++) {
      if (bytes[j] === 0) { parts.push(new TextDecoder().decode(bytes.slice(start, j))); start = j + 1; }
    }
    const [mod, field] = parts;
    if ((mod === "env" || mod === "emnapi" || mod === "napi") && napiRuntime[field]) {
      const fn = field;
      bridgeFunctions.set(i, (args, argsPtr) => napiRuntime.dispatch(fn, args, argsPtr));
    } else if (mod === "wasi_snapshot_preview1" && wasiBridges[field]) {
      const handler = wasiBridges[field];
      bridgeFunctions.set(i, (args) => {
        const r = handler(args);
        return typeof r === "bigint" ? r : BigInt(r ?? 0);
      });
    } else {
      // Unknown import — fail loudly (ENOSYS) so the guest gets a real
      // error instead of looping on uninitialised output pointers, which
      // is what the old `() => 0n` fallback did.
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

  // Read export names directly from the wasm binary instead of calling
  // WebAssembly.compile() — that's banned at request time in workerd, and
  // even at module init time it refuses bytes-from-an-import. Parsing the
  // export section ourselves keeps the whole load path bytes-only.
  const guestFuncExports = parseWasmFunctionExports(guestBytes);

  const stubInstance = {
    exports: Object.fromEntries(
      guestFuncExports
        .filter((name) => name.startsWith("__napi_register__"))
        .map((name) => [name, () => kernelCall(name)])
    ),
  };
  if (typeof options.beforeInit === "function") options.beforeInit({ instance: stubInstance });
  else for (const name of Object.keys(stubInstance.exports)) stubInstance.exports[name]();

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

/** Parse the wasm export section from raw bytes and return the names of
 *  all exported functions. Used in environments (workerd) where we cannot
 *  call WebAssembly.compile() to enumerate exports the easy way. */
function parseWasmFunctionExports(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Magic 0x6D736100 ("\0asm") + version 0x01000000
  if (u8.length < 8 || u8[0] !== 0x00 || u8[1] !== 0x61 || u8[2] !== 0x73 || u8[3] !== 0x6d) {
    throw new Error("invalid wasm magic");
  }
  let p = 8;
  function leb() {
    let result = 0, shift = 0, byte;
    do {
      byte = u8[p++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result >>> 0;
  }
  const td = new TextDecoder();
  const funcExports = [];
  while (p < u8.length) {
    const id = u8[p++];
    const size = leb();
    const sectionEnd = p + size;
    if (id === 7) {
      // Export section
      const count = leb();
      for (let i = 0; i < count; i++) {
        const nameLen = leb();
        const name = td.decode(u8.subarray(p, p + nameLen));
        p += nameLen;
        const kind = u8[p++];
        leb(); // index
        if (kind === 0) funcExports.push(name);
      }
      return funcExports;
    }
    p = sectionEnd;
  }
  return funcExports;
}

/** napi-rs compat — browser doesn't have a sync path. If a caller tries
 *  to use this synchronously they'll get a helpful error. Most published
 *  napi-rs loaders are CJS and Node-only; a browser user is expected to
 *  call instantiateNapiModule directly. */
export function instantiateNapiModuleSync() {
  throw new Error(
    "@wasmkernel/runtime/browser: sync instantiate is not supported in browsers; " +
    "use await instantiateNapiModule() instead"
  );
}

export function getDefaultContext() { return {}; }
export function createOnMessage() { return () => {}; }
