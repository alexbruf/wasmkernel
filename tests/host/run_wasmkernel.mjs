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

const compiled = await WebAssembly.compile(kernelBytes);
const instance = await WebAssembly.instantiate(compiled, {
  wasi_snapshot_preview1: wasi.wasiImport,
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
const MAX_STEPS = 1000000;
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
