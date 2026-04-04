#!/usr/bin/env node
/**
 * Quick test: load wasmkernel.wasm, initialize, load a guest, run it.
 * Usage: node tests/host/run_wasmkernel.mjs <guest.wasm>
 */

import { readFileSync } from "fs";
import { WASI } from "wasi";

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

/* ===== Host I/O bridge ===== */
const pendingIO = new Map(); // callback_id -> { resolve, result }

const hostImports = {
  host_io_submit(callbackId, opType, fd, bufPtr, len) {
    // For now, fd_read from stdin returns 0 bytes (EOF) immediately.
    // A real implementation would use async fs/net operations.
    if (opType === 1) {
      // READ
      pendingIO.set(callbackId, { bytes: 0, error: 0 });
    } else if (opType === 2) {
      // WRITE — sync for now
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
    return r ? r.error : 8; // BADF if not found
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
