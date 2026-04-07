#!/usr/bin/env node
/**
 * Sanity test: kernel_call_indirect can invoke a guest function.
 *
 * The full asyncify suspend/resume path (where the guest blocks on wait32
 * inside a kernel_call_indirect) is exercised end-to-end by the emnapi tsfn
 * test suite — those tests run thousands of guest callbacks via the napi
 * bridge, with cooperative threads making real blocking calls.
 *
 * This test just verifies the basic mechanic: load a guest, look up a
 * function in the indirect function table, call it through
 * kernel_call_indirect, and verify it executed (return value + side effect).
 */

import { readFileSync } from "fs";
import { WASI } from "wasi";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const KERNEL = join(ROOT, "build", "wasmkernel.wasm");
const GUEST = join(ROOT, "tests", "guest", "asyncify_indirect.wasm");

const kernelBytes = readFileSync(KERNEL);
const guestBytes = readFileSync(GUEST);

const wasi = new WASI({ version: "preview1", args: [], env: {} });
const hostImports = {
  host_func_call() { return 0n; },
  host_io_submit() {},
  host_io_check() { return 0; },
  host_io_result_bytes() { return 0; },
  host_io_result_error() { return 8; },
};

const instance = await WebAssembly.instantiate(
  await WebAssembly.compile(kernelBytes),
  { wasi_snapshot_preview1: wasi.wasiImport, host: hostImports }
);
wasi.initialize(instance);
const k = instance.exports;
k.kernel_init();

const ptr = k.kernel_alloc(guestBytes.length);
new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
if (k.kernel_load(ptr, guestBytes.length) !== 0) {
  console.error("kernel_load failed");
  process.exit(1);
}

let s = 0;
while (s === 0) s = k.kernel_step();
console.error("init done");

function callNamed(name, args = []) {
  const nb = new TextEncoder().encode(name);
  const np = k.kernel_alloc(nb.length + 1);
  new Uint8Array(k.memory.buffer, np, nb.length).set(nb);
  new Uint8Array(k.memory.buffer)[np + nb.length] = 0;
  const ap = k.kernel_alloc(Math.max(4, args.length * 4));
  args.forEach((a, i) => new DataView(k.memory.buffer).setUint32(ap + i * 4, a, true));
  if (k.kernel_call(np, ap, args.length) !== 0) process.exit(1);
  return new DataView(k.memory.buffer).getInt32(ap, true);
}

// Look up the table index of simple_add via an exported helper
const simpleAddIdx = callNamed("get_simple_add_idx");
console.error(`simple_add idx=${simpleAddIdx}`);
if (simpleAddIdx <= 0) {
  console.error("FAIL: get_simple_add_idx returned invalid index");
  process.exit(1);
}

// Read the guest's g_called counter directly from linear memory
// (the simple_add function increments it as a side effect)
const base = k.kernel_guest_memory_base();
const readU32 = (a) => new DataView(k.memory.buffer).getUint32(base + a, true);
// Address 1152 is where g_called lives (verified via wasm dump).
const G_CALLED_ADDR = 1152;
const beforeCalled = readU32(G_CALLED_ADDR);

// Call simple_add(21) via kernel_call_indirect.
// Expected: returns 21*2+7=49 and increments g_called.
const ap = k.kernel_alloc(4);
new DataView(k.memory.buffer).setUint32(ap, 21, true);
const r = k.kernel_call_indirect(simpleAddIdx, 1, ap);
if (r !== 0) {
  console.error(`FAIL: kernel_call_indirect returned ${r}`);
  process.exit(1);
}
const result = new DataView(k.memory.buffer).getInt32(ap, true);
const afterCalled = readU32(G_CALLED_ADDR);

console.error(`simple_add(21) returned ${result}, g_called: ${beforeCalled} -> ${afterCalled}`);
if (result !== 49) {
  console.error(`FAIL: expected 49, got ${result}`);
  process.exit(1);
}
if (afterCalled !== beforeCalled + 1) {
  console.error(`FAIL: g_called did not increment (${beforeCalled} -> ${afterCalled})`);
  process.exit(1);
}

console.log("tier1 (simple_add) PASS");
process.exit(0);
