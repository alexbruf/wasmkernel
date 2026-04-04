#!/usr/bin/env node
/**
 * Test loading @tailwindcss/oxide through WasmKernel with napi bridge.
 * Replicates emnapi's exact initialization flow.
 */
import { readFileSync } from "fs";
import { WASI } from "wasi";
import { NapiRuntime } from "./napi_runtime.mjs";

const kernelBytes = readFileSync(new URL("../../build/wasmkernel.wasm", import.meta.url).pathname);
const guestBytes = readFileSync("/tmp/tw-oxide/package/tailwindcss-oxide.wasm32-wasi.wasm");
const wasi = new WASI({ version: "preview1", args: [], env: {} });

const pendingIO = new Map();
const bridgeFunctions = new Map();
let bridgeNames = [];

const hostImports = {
  host_func_call(funcIdx, argsPtr, argc) {
    const handler = bridgeFunctions.get(funcIdx);
    if (!handler) {
      console.error(`  UNHANDLED bridge[${funcIdx}] = ${bridgeNames[funcIdx]}`);
      return 0n;
    }
    const dv = new DataView(k.memory.buffer);
    const args = [];
    for (let i = 0; i < argc; i++) args.push(dv.getUint32(argsPtr + i * 8, true));
    try {
      return handler(args);
    } catch (e) {
      console.error(`  BRIDGE ERROR ${bridgeNames[funcIdx]}: ${e.message}`);
      return 0n;
    }
  },
  host_io_submit(cb, op, fd, buf, len) { pendingIO.set(cb, { bytes: 0, error: 0 }); },
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
const k = instance.exports;
k.kernel_init();

console.log("Loading oxide (" + (guestBytes.length / 1024 / 1024).toFixed(1) + " MB)...");
const ptr = k.kernel_alloc(guestBytes.length);
new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
const loadResult = k.kernel_load(ptr, guestBytes.length);
if (loadResult !== 0) { console.error("load failed:", loadResult); process.exit(1); }

// Setup napi + WASI bridge
const napiRuntime = new NapiRuntime(k);
napiRuntime.debug = true;

const wasiFunctions = {
  random_get(args) {
    const [bufPtr, bufLen] = args;
    const base = k.kernel_guest_memory_base();
    const mem = new Uint8Array(k.memory.buffer);
    for (let i = 0; i < bufLen; i++) mem[base + bufPtr + i] = (Math.random() * 256) | 0;
    return 0n;
  },
  path_open()          { return 44n; },
  fd_readdir()         { return 8n; },
  fd_filestat_get()    { return 8n; },
  path_filestat_get()  { return 44n; },
  fd_prestat_dir_name(){ return 8n; },
};

const bridgeCount = k.kernel_bridge_count();
const infoBuf = k.kernel_alloc(256);
bridgeNames = [];
for (let i = 0; i < bridgeCount; i++) {
  const len = k.kernel_bridge_info(i, infoBuf, 256);
  if (!len) { bridgeNames.push(`?${i}`); continue; }
  const bytes = new Uint8Array(k.memory.buffer, infoBuf, len);
  const parts = []; let start = 0;
  for (let j = 0; j < len; j++) { if (bytes[j] === 0) { parts.push(new TextDecoder().decode(bytes.slice(start, j))); start = j + 1; } }
  const [mod, field] = parts;
  bridgeNames.push(`${mod}.${field}`);
  if (mod === "env" && napiRuntime[field]) {
    const fn = field;
    bridgeFunctions.set(i, (args) => napiRuntime.dispatch(fn, args));
  } else if (mod === "wasi_snapshot_preview1" && wasiFunctions[field]) {
    const fn = field;
    bridgeFunctions.set(i, (args) => { const r = wasiFunctions[fn](args); return typeof r === 'bigint' ? r : BigInt(r ?? 0); });
  } else {
    bridgeFunctions.set(i, () => 0n);
  }
}

console.log("Guest memory:", (k.kernel_guest_memory_size() / 1024 / 1024).toFixed(1), "MB at offset", k.kernel_guest_memory_base());

// Helper to call guest exports
function callExport(name, args = []) {
  const np = k.kernel_alloc(name.length + 1);
  const nb = new Uint8Array(k.memory.buffer, np, name.length + 1);
  new TextEncoder().encodeInto(name, nb); nb[name.length] = 0;
  const ap = k.kernel_alloc(Math.max(args.length, 1) * 4);
  const dv = new DataView(k.memory.buffer);
  args.forEach((a, i) => dv.setUint32(ap + i * 4, a, true));
  const r = k.kernel_call(np, ap, args.length);
  return { status: r, retVal: dv.getUint32(ap, true) };
}

// ===== EMNAPI-COMPATIBLE INITIALIZATION FLOW =====

// Step 1: _initialize (wasi reactor init - already happened during kernel_load's
//         wasm start function. But the scheduler also runs _initialize.)
console.log("\n=== Step 1: _initialize ===");
let status = 0;
while (status === 0) status = k.kernel_step();
console.log("_initialize:", status === 1 ? "OK" : `FAIL(${status})`);
if (status !== 1) process.exit(1);

// Step 2: beforeInit - call __napi_register__ exports (like emnapi does)
console.log("\n=== Step 2: beforeInit (__napi_register__) ===");
const r1 = callExport("__napi_register__Scanner_struct_4");
console.log("Scanner_struct_4:", r1.status === 0 ? "OK" : `FAIL(${r1.status})`);
const r2 = callExport("__napi_register__Scanner_impl_13");
console.log("Scanner_impl_13:", r2.status === 0 ? "OK" : `FAIL(${r2.status})`);

// Step 3: napiModule.init - call napi_register_wasm_v1(env, exports)
console.log("\n=== Step 3: napi_register_wasm_v1 ===");
const exportsObj = {};
const exportsHandle = napiRuntime._newHandle(exportsObj);
const envHandle = 1;

const reg = callExport("napi_register_wasm_v1", [envHandle, exportsHandle]);
console.log("napi_register_wasm_v1:", reg.status === 0 ? "OK" : `FAIL(${reg.status})`);

// Check what we got
const resultObj = napiRuntime._getHandle(reg.retVal) ?? exportsObj;
console.log("\n=== Results ===");
console.log("Return handle:", reg.retVal);
console.log("Exports object:", resultObj);
console.log("Exports keys:", Object.keys(resultObj));
if (resultObj.Scanner) {
  console.log("Scanner class:", resultObj.Scanner);
  console.log("Scanner.prototype:", Object.keys(resultObj.Scanner.prototype ?? {}));
}
