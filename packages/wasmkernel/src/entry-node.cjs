'use strict';
/**
 * CJS entry for @wasmkernel/runtime. Required by napi-rs's published
 * `.wasi.cjs` loaders — they synchronously `require('@napi-rs/wasm-runtime')`
 * and destructure, so we have to match that shape in plain CommonJS.
 *
 * Everything is sync at the top. No top-level await, no dynamic import.
 */
const { readFileSync } = require('node:fs');
const path = require('node:path');

// We can't `require` an ESM `.js` file directly, but we also don't want
// to maintain two copies of napi_runtime.js. Workaround: evaluate the ESM
// file as text inside a Function() that exposes its class — the file has
// no top-level imports (we refactored that out), so this works.
//
// Simpler alternative: have a dedicated .cjs mirror that re-exports the
// class via `module.exports`. Let's do that.

const { NapiRuntime } = require('./napi_runtime.cjs');

const KERNEL_PATH = path.join(__dirname, '..', 'wasmkernel.wasm');
let _kernelBytes = null;
function kernelBytes() {
  if (!_kernelBytes) _kernelBytes = readFileSync(KERNEL_PATH);
  return _kernelBytes;
}

function instantiateNapiModuleSync(guestBytes, options) {
  options = options || {};
  if (!options.wasi) {
    throw new Error(
      '@wasmkernel/runtime: options.wasi is required (pass a node:wasi instance)'
    );
  }

  const pendingIO = new Map();
  const bridgeFunctions = new Map();
  let k;
  const hostImports = {
    host_func_call(funcIdx, argsPtr, argc) {
      const handler = bridgeFunctions.get(funcIdx);
      if (!handler) return 0n;
      const args = [];
      for (let i = 0; i < argc; i++) {
        args.push(new DataView(k.memory.buffer).getUint32(argsPtr + i * 8, true));
      }
      try { return handler(args, argsPtr); }
      catch (e) { console.error('[wasmkernel] bridge err:', e); return 0n; }
    },
    host_io_submit(cb) { pendingIO.set(cb, { bytes: 0, error: 0 }); },
    host_io_check(cb) { return pendingIO.has(cb) ? 1 : 0; },
    host_io_result_bytes(cb) { return pendingIO.get(cb) ? pendingIO.get(cb).bytes : 0; },
    host_io_result_error(cb) {
      const r = pendingIO.get(cb);
      if (r) pendingIO.delete(cb);
      return r ? r.error : 8;
    },
  };

  const kernelModule = new WebAssembly.Module(kernelBytes());
  const instance = new WebAssembly.Instance(kernelModule, {
    wasi_snapshot_preview1: options.wasi.wasiImport,
    host: hostImports,
  });
  if (typeof options.wasi.initialize === 'function') options.wasi.initialize(instance);
  k = instance.exports;
  k.kernel_init();

  const minInit = options.minInitialPages != null ? options.minInitialPages : 4000;
  if (k.kernel_set_min_initial_pages && minInit > 0) {
    k.kernel_set_min_initial_pages(minInit);
  }

  const ptr = k.kernel_alloc(guestBytes.length);
  new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
  if (k.kernel_load(ptr, guestBytes.length) !== 0) {
    throw new Error('wasmkernel: kernel_load failed');
  }

  const napiRuntime = new NapiRuntime(k);

  const defaultWasiBridges = {
    random_get(args) {
      const [bufPtr, bufLen] = args;
      const base = k.kernel_guest_memory_base();
      const mem = new Uint8Array(k.memory.buffer);
      if (typeof globalThis.crypto !== 'undefined' &&
          typeof globalThis.crypto.getRandomValues === 'function') {
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
  };
  const wasiBridges = Object.assign({}, defaultWasiBridges, options.wasiBridges || {});

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
    if ((mod === 'env' || mod === 'emnapi' || mod === 'napi') && napiRuntime[field]) {
      const fn = field;
      bridgeFunctions.set(i, (args, argsPtr) => napiRuntime.dispatch(fn, args, argsPtr));
    } else if (mod === 'wasi_snapshot_preview1' && wasiBridges[field]) {
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

  function kernelCall(name, argsPtr, argCount) {
    argsPtr = argsPtr || 0;
    argCount = argCount || 0;
    const nameBytes = new TextEncoder().encode(name);
    const np = k.kernel_alloc(nameBytes.length + 1);
    new Uint8Array(k.memory.buffer, np, nameBytes.length).set(nameBytes);
    new Uint8Array(k.memory.buffer)[np + nameBytes.length] = 0;
    return k.kernel_call(np, argsPtr, argCount);
  }

  const guestModule = new WebAssembly.Module(guestBytes);
  const guestExports = WebAssembly.Module.exports(guestModule);

  const stubInstance = {
    exports: Object.fromEntries(
      guestExports
        .filter((e) => e.kind === 'function' && e.name.startsWith('__napi_register__'))
        .map((e) => [e.name, () => kernelCall(e.name)])
    ),
  };
  if (typeof options.beforeInit === 'function') {
    options.beforeInit({ instance: stubInstance });
  } else {
    for (const name of Object.keys(stubInstance.exports)) stubInstance.exports[name]();
  }

  const ap = k.kernel_alloc(8);
  new DataView(k.memory.buffer).setUint32(ap, 1, true);
  new DataView(k.memory.buffer).setUint32(ap + 4, exportsHandle, true);
  let callResult = kernelCall('napi_register_module_v1', ap, 2);
  if (callResult === -2) callResult = kernelCall('napi_register_wasm_v1', ap, 2);

  if (napiRuntime.exceptionPending) {
    const e = napiRuntime.lastException;
    napiRuntime.exceptionPending = false;
    napiRuntime.lastException = null;
    throw e;
  }
  if (callResult !== 0) throw new Error('wasmkernel: napi_register failed: ' + callResult);

  const retHandle = new DataView(k.memory.buffer).getUint32(ap, true);
  const napiExports = napiRuntime._getHandle(retHandle) || exportsObj;

  return {
    instance,
    module: kernelModule,
    napiModule: { exports: napiExports },
    kernel: k,
    napiRuntime,
  };
}

function getDefaultContext() { return {}; }
function createOnMessage(_fsApi) { return function () {}; }

module.exports = {
  instantiateNapiModuleSync,
  getDefaultContext,
  createOnMessage,
};
