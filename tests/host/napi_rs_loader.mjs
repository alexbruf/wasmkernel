/**
 * Generic loader for napi-rs wasm packages.
 *
 * napi-rs wasm binaries use a per-function registration pattern: each
 * exported function is represented by a top-level export named
 * `__napi_register__<Name>_<N>` that must be called after instantiation
 * to record its descriptor. Then `napi_register_module_v1` (or the
 * legacy `napi_register_wasm_v1`) drains the queue into the exports
 * object.
 *
 * This module wires that up generically — discover register exports
 * via WebAssembly.Module.exports() on the raw bytes, then call each
 * in turn, then register the module.
 */
import { readFileSync } from "fs";
import { WASI } from "wasi";
import { NapiRuntime } from "./napi_runtime.mjs";

/**
 * @param {string} kernelPath path to wasmkernel.wasm
 * @param {string} guestPath  path to the napi-rs wasm
 * @param {object} [opts]
 * @param {Record<string, (args:number[]) => bigint>} [opts.wasiBridges]
 *   Extra wasi_snapshot_preview1.* handlers (e.g. random_get). Return value
 *   is the wasi errno as a BigInt.
 * @returns {Promise<{exports: object, kernel: object, napiRuntime: NapiRuntime}>}
 */
export async function loadNapiRs(kernelPath, guestPath, opts = {}) {
  const kernelBytes = readFileSync(kernelPath);
  const guestBytes = readFileSync(guestPath);

  // Discover all __napi_register__* exports without running the module.
  const guestModule = await WebAssembly.compile(guestBytes);
  const guestExports = WebAssembly.Module.exports(guestModule);
  const registerFns = guestExports
    .filter(e => e.kind === "function" && e.name.startsWith("__napi_register__"))
    .map(e => e.name);

  const wasi = new WASI({ version: "preview1", args: [], env: process.env });
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
      catch (e) { console.error("bridge err:", e); return 0n; }
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

  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(kernelBytes),
    { wasi_snapshot_preview1: wasi.wasiImport, host: hostImports }
  );
  wasi.initialize(instance);
  k = instance.exports;
  k.kernel_init();

  /* Match emnapi's `new WebAssembly.Memory({ initial: 4000, ... })`.
   * The published napi-rs wasi loaders (parser.wasi.cjs, argon2.wasi.cjs,
   * etc.) create a 256 MB shared memory and inject it via
   * overwriteImports, replacing whatever the wasm module declared.
   * On V8 the Rust allocator in the guest sees 4000 initial pages and
   * places its heap accordingly. Without this hint, WAMR uses the
   * module-declared initial (typically 980 pages for oxc-parser), and
   * Rust places buffers at addresses that happen to trigger a memcpy
   * aliasing pattern: iter-N's "small" memcpy writes bytes that iter-N's
   * "big" memcpy then reads from the same overlapping region.
   * Matching emnapi's layout is the right fix because it reproduces the
   * environment the wasm was validated against. */
  if (k.kernel_set_min_initial_pages) k.kernel_set_min_initial_pages(4000);

  const ptr = k.kernel_alloc(guestBytes.length);
  new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
  if (k.kernel_load(ptr, guestBytes.length) !== 0) {
    throw new Error("kernel_load failed");
  }

  const napiRuntime = new NapiRuntime(k);

  // Default wasi bridges: random_get (needed for crypto addons), and
  // caller-supplied overrides.
  let _randomCount = 0;
  const wasiBridges = {
    random_get(args) {
      const [bufPtr, bufLen] = args;
      const base = k.kernel_guest_memory_base();
      const mem = new Uint8Array(k.memory.buffer);
      // BISECT MODE: deterministic counter to match V8 if possible.
      // Real impl is at the bottom of this if/else.
      if (process.env.WASMKERNEL_DETERMINISTIC_RANDOM) {
        for (let i = 0; i < bufLen; i++) {
          mem[base + bufPtr + i] = (_randomCount++) & 0xff;
        }
      } else {
        for (let i = 0; i < bufLen; i++) {
          mem[base + bufPtr + i] = (Math.random() * 256) | 0;
        }
      }
      return 0n;
    },
    ...(opts.wasiBridges || {}),
  };

  // Wire bridge table.
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

  // Let the scheduler drain any startup (reactor modules typically just
  // return on first step — the wasm `start` section already ran during
  // instantiate).
  let status = 0;
  while (status === 0) status = k.kernel_step();

  // --- napi-rs register dance ---
  const exportsObj = {};
  const exportsHandle = napiRuntime._newHandle(exportsObj);

  const kernelCall = (name, argsPtr = 0, argCount = 0) => {
    const nameBytes = new TextEncoder().encode(name);
    const np = k.kernel_alloc(nameBytes.length + 1);
    new Uint8Array(k.memory.buffer, np, nameBytes.length).set(nameBytes);
    new Uint8Array(k.memory.buffer)[np + nameBytes.length] = 0;
    return k.kernel_call(np, argsPtr, argCount);
  };

  for (const fn of registerFns) kernelCall(fn);

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
  if (callResult !== 0) throw new Error(`napi_register failed: ${callResult}`);

  const retHandle = new DataView(k.memory.buffer).getUint32(ap, true);
  const exported = napiRuntime._getHandle(retHandle) ?? exportsObj;

  return { exports: exported, kernel: k, napiRuntime };
}
