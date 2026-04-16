#!/usr/bin/env node
/**
 * Regression test for the rolldown-async hang documented in
 * wasmkernel-issue-rolldown-async.md.
 *
 * Loads tests/guest/napi_async_promise.wasm. The guest exposes
 * runAsync(value), which spawns a wasi-thread worker that calls
 * napi_resolve_deferred from inside the cooperative scheduler. The
 * Promise must settle without the host calling kernel_step manually —
 * the napi runtime's pump (introduced as part of this fix) is what
 * makes that work.
 *
 * Test PASSES when await runAsync(N) resolves to N+100 within a few
 * seconds. Before the fix it hangs indefinitely.
 */
import { readFileSync } from "fs";
import { WASI } from "wasi";
import { NapiRuntime } from "./napi_runtime.mjs";

const kernelBytes = readFileSync(new URL("../../build/wasmkernel.wasm", import.meta.url).pathname);
const guestBytes = readFileSync(new URL("../guest/napi_async_promise.wasm", import.meta.url).pathname);
const wasi = new WASI({ version: "preview1", args: [], env: {} });

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
    catch (e) { console.error("bridge err:", e.message); return 0n; }
  },
  host_io_submit(cb) { pendingIO.set(cb, { bytes: 0, error: 0 }); },
  host_io_check(cb) { return pendingIO.has(cb) ? 1 : 0; },
  host_io_result_bytes(cb) { return pendingIO.get(cb)?.bytes ?? 0; },
  host_io_result_error(cb) { const r = pendingIO.get(cb); if (r) pendingIO.delete(cb); return r?.error ?? 8; },
};

const compiled = await WebAssembly.compile(kernelBytes);
const instance = await WebAssembly.instantiate(compiled, {
  wasi_snapshot_preview1: wasi.wasiImport,
  host: hostImports,
});
wasi.initialize(instance);
k = instance.exports;
k.kernel_init();

const ptr = k.kernel_alloc(guestBytes.length);
new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
if (k.kernel_load(ptr, guestBytes.length) !== 0) {
  console.error("kernel_load failed");
  process.exit(1);
}

const napiRuntime = new NapiRuntime(k);
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
  } else {
    bridgeFunctions.set(i, () => 0n);
  }
}

// _initialize
let status = 0;
while (status === 0) status = k.kernel_step();
if (status !== 1) {
  console.error("init failed:", status);
  process.exit(1);
}

// napi_register_wasm_v1
const exportsObj = {};
const exportsHandle = napiRuntime._newHandle(exportsObj);
function callExport(name, args = []) {
  const np = k.kernel_alloc(name.length + 1);
  new Uint8Array(k.memory.buffer, np, name.length + 1).set(new TextEncoder().encode(name));
  new Uint8Array(k.memory.buffer)[np + name.length] = 0;
  const ap = k.kernel_alloc(Math.max(args.length, 1) * 4);
  args.forEach((a, i) => new DataView(k.memory.buffer).setUint32(ap + i * 4, a, true));
  const r = k.kernel_call(np, ap, args.length);
  return { status: r, retVal: new DataView(k.memory.buffer).getUint32(ap, true) };
}
const reg = callExport("napi_register_wasm_v1", [1, exportsHandle]);
if (reg.status !== 0) {
  console.error("napi_register_wasm_v1 failed:", reg.status);
  process.exit(1);
}
const mod = napiRuntime._getHandle(reg.retVal) ?? exportsObj;

let passed = 0, failed = 0;
function pass(name) { console.log(`PASS  ${name}`); passed++; }
function fail(name, msg) { console.log(`FAIL  ${name}: ${msg}`); failed++; }

// Bound the wait so a regression hangs the test runner instead of CI.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${label}`)), ms)),
  ]);
}

if (typeof mod.runAsync !== "function") {
  fail("runAsync export", `not a function: ${typeof mod.runAsync}`);
} else {
  try {
    const got = await withTimeout(mod.runAsync(42), 5000, "runAsync(42)");
    if (got === 142) pass("runAsync(42) → 142");
    else fail("runAsync(42)", `expected 142, got ${got}`);
  } catch (e) {
    fail("runAsync(42)", e.message);
  }

  // Multiple in-flight promises share a single pump — verify the pump
  // doesn't hand the work back early before all have settled.
  try {
    const results = await withTimeout(
      Promise.all([mod.runAsync(1), mod.runAsync(2), mod.runAsync(3)]),
      5000,
      "concurrent runAsync");
    if (results[0] === 101 && results[1] === 102 && results[2] === 103)
      pass("concurrent runAsync(1,2,3) → [101,102,103]");
    else
      fail("concurrent runAsync", `got ${JSON.stringify(results)}`);
  } catch (e) {
    fail("concurrent runAsync", e.message);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
