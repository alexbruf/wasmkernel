#!/usr/bin/env node
/**
 * Quick test: load wasmkernel.wasm, initialize, load a guest, run it.
 * Usage: node tests/host/run_wasmkernel.mjs <guest.wasm>
 *
 * Supports the generic host function bridge — any guest imports the
 * kernel doesn't handle internally are forwarded to host_func_call.
 * The host discovers bridge mappings via kernel_bridge_count/info
 * and dispatches to real implementations (WASI fs ops, N-API, etc).
 */

import { readFileSync } from "fs";
import { WASI } from "wasi";
import { NapiRuntime } from "./napi_runtime.mjs";

const kernelPath = new URL("../../build/wasmkernel.wasm", import.meta.url)
  .pathname;
const guestPath = process.argv[2];

if (!guestPath) {
  console.error("Usage: node run_wasmkernel.mjs <guest.wasm>");
  process.exit(1);
}

const kernelBytes = readFileSync(kernelPath);
const guestBytes = readFileSync(guestPath);

const wasi = new WASI({
  version: "preview1",
  args: [],
  env: {},
});

/* ===== Bridge dispatch table ===== */
// Populated after kernel_load by reading kernel_bridge_count/info
const bridgeFunctions = new Map(); // funcIdx -> handler function

/* ===== Host I/O bridge ===== */
const pendingIO = new Map();

/* ===== WASI function implementations for bridge ===== */
const wasiFunctions = {
  path_open(exec_args) {
    // args: dirfd(i32), dirflags(i32), path_ptr(i32), path_len(i32),
    //       oflags(i32), fs_rights_base(i64), fs_rights_inheriting(i64),
    //       fdflags(i32), fd_out_ptr(i32) -> i32
    // For now, return ENOENT (44) — real fs bridging needs preopens
    return 44n;
  },

  fd_readdir(exec_args) {
    // args: fd(i32), buf(i32), buf_len(i32), cookie(i64), bufused_ptr(i32) -> i32
    return 8n; // BADF
  },

  fd_filestat_get(exec_args) {
    // args: fd(i32), buf_ptr(i32) -> i32
    return 8n; // BADF
  },

  path_filestat_get(exec_args) {
    // args: fd(i32), flags(i32), path_ptr(i32), path_len(i32), buf_ptr(i32) -> i32
    return 44n; // ENOENT
  },

  fd_prestat_dir_name(exec_args) {
    // args: fd(i32), path_ptr(i32), path_len(i32) -> i32
    return 8n; // BADF
  },

  random_get(exec_args) {
    // args: buf_ptr(i32), buf_len(i32) -> i32
    const [bufPtr, bufLen] = exec_args;
    const mem = getKernelU8();
    // Fill with pseudo-random bytes
    for (let i = 0; i < bufLen; i++) {
      mem[bufPtr + i] = (Math.random() * 256) | 0;
    }
    return 0n; // success
  },
};

const hostImports = {
  host_func_call(funcIdx, argsPtr, argc) {
    const handler = bridgeFunctions.get(funcIdx);
    if (!handler) {
      console.error(`bridge: unhandled func_idx=${funcIdx}`);
      return 0n;
    }

    // Read raw args (each is uint64 = 8 bytes)
    const dv = getKernelMemory();
    const args = [];
    for (let i = 0; i < argc; i++) {
      // Read as two u32s (little-endian) to get full u64
      const lo = dv.getUint32(argsPtr + i * 8, true);
      const hi = dv.getUint32(argsPtr + i * 8 + 4, true);
      args.push(lo); // Most WASI args are i32; pass lo for now
    }

    const result = handler(args);
    return typeof result === "bigint" ? result : BigInt(result ?? 0);
  },

  host_io_submit(callbackId, opType, fd, bufPtr, len) {
    if (opType === 1) {
      pendingIO.set(callbackId, { bytes: 0, error: 0 }); // EOF
    } else if (opType === 2) {
      pendingIO.set(callbackId, { bytes: len, error: 0 });
    }
  },
  host_io_check(callbackId) {
    return pendingIO.has(callbackId) ? 1 : 0;
  },
  host_io_result_bytes(callbackId) {
    const r = pendingIO.get(callbackId);
    return r ? r.bytes : 0;
  },
  host_io_result_error(callbackId) {
    const r = pendingIO.get(callbackId);
    if (r) pendingIO.delete(callbackId);
    return r ? r.error : 8;
  },
};

const compiled = await WebAssembly.compile(kernelBytes);
const instance = await WebAssembly.instantiate(compiled, {
  wasi_snapshot_preview1: wasi.wasiImport,
  host: hostImports,
});

wasi.initialize(instance);

const k = instance.exports;

k.kernel_init();

const ptr = k.kernel_alloc(guestBytes.length);
const mem = new Uint8Array(k.memory.buffer);
mem.set(guestBytes, ptr);

const loadResult = k.kernel_load(ptr, guestBytes.length);
console.error(`load: ${loadResult}`);

if (loadResult !== 0) {
  process.exit(1);
}

/* ===== Discover bridge mappings ===== */
const napiRuntime = new NapiRuntime(k);
const bridgeCount = k.kernel_bridge_count();
if (bridgeCount > 0) {
  const infoBuf = k.kernel_alloc(256);
  for (let i = 0; i < bridgeCount; i++) {
    const len = k.kernel_bridge_info(i, infoBuf, 256);
    if (len === 0) continue;

    const bytes = new Uint8Array(k.memory.buffer, infoBuf, len);
    const parts = [];
    let start = 0;
    for (let j = 0; j < len; j++) {
      if (bytes[j] === 0) {
        parts.push(new TextDecoder().decode(bytes.slice(start, j)));
        start = j + 1;
      }
    }
    const [moduleName, fieldName] = parts;

    if (moduleName === "wasi_snapshot_preview1" && wasiFunctions[fieldName]) {
      bridgeFunctions.set(i, wasiFunctions[fieldName]);
    } else if (moduleName === "env" && napiRuntime[fieldName]) {
      // N-API function — dispatch to our napi runtime
      const fname = fieldName;
      bridgeFunctions.set(i, (args) => napiRuntime.dispatch(fname, args));
    } else {
      console.error(`bridge[${i}]: ${moduleName}.${fieldName} (unimplemented)`);
      bridgeFunctions.set(i, () => 0n);
    }
  }
}

// Run scheduler loop until completion
let status = 0;
let steps = 0;
const MAX_STEPS = 2000000;
while (status === 0 && steps < MAX_STEPS) {
  status = k.kernel_step();
  steps++;
}
if (steps >= MAX_STEPS && status === 0) {
  console.error("timeout: scheduler did not complete");
  process.exit(1);
}

const exitCode = k.kernel_exit_code();
console.error(`status: ${status}, exitCode: ${exitCode}`);

process.exit(status === 1 ? 0 : status === -2 ? exitCode : 1);
