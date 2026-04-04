#!/usr/bin/env node
/**
 * Test loading @tailwindcss/oxide through WasmKernel with napi bridge.
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
let callLog = [];

const hostImports = {
  host_func_call(funcIdx, argsPtr, argc) {
    const handler = bridgeFunctions.get(funcIdx);
    callLog.push(funcIdx);
    if (!handler) {
      console.error(`  unhandled bridge call: ${bridgeNames[funcIdx] ?? funcIdx}`);
      return 0n;
    }
    const dv = new DataView(k.memory.buffer);
    const args = [];
    for (let i = 0; i < argc; i++) args.push(dv.getUint32(argsPtr + i * 8, true));
    try {
      return handler(args);
    } catch (e) {
      console.error(`  bridge error in ${bridgeNames[funcIdx]}: ${e.message}`);
      return 0n;
    }
  },
  host_io_submit(callbackId, opType, fd, bufPtr, len) {
    pendingIO.set(callbackId, { bytes: 0, error: 0 });
  },
  host_io_check(callbackId) { return pendingIO.has(callbackId) ? 1 : 0; },
  host_io_result_bytes(callbackId) { return pendingIO.get(callbackId)?.bytes ?? 0; },
  host_io_result_error(callbackId) { const r = pendingIO.get(callbackId); if (r) pendingIO.delete(callbackId); return r?.error ?? 8; },
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
new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
const loadResult = k.kernel_load(ptr, guestBytes.length);
console.log("load:", loadResult);
if (loadResult !== 0) process.exit(1);

// WASI bridge functions
const wasiFunctions = {
  random_get(args) {
    const [bufPtr, bufLen] = args;
    const base = k.kernel_guest_memory_base();
    const mem = new Uint8Array(k.memory.buffer);
    for (let i = 0; i < bufLen; i++) {
      mem[base + bufPtr + i] = (Math.random() * 256) | 0;
    }
    return 0n;
  },
  path_open() { return 44n; },    // ENOENT
  fd_readdir() { return 8n; },    // BADF
  fd_filestat_get() { return 8n; },
  path_filestat_get() { return 44n; },
  fd_prestat_dir_name() { return 8n; },
};

// Setup bridge
const napiRuntime = new NapiRuntime(k);
const bridgeCount = k.kernel_bridge_count();
console.log("bridge functions:", bridgeCount);

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
    const fname = field;
    bridgeFunctions.set(i, (args) => napiRuntime.dispatch(fname, args));
  } else if (mod === "wasi_snapshot_preview1" && wasiFunctions[field]) {
    const fname = field;
    bridgeFunctions.set(i, (args) => {
      const r = wasiFunctions[fname](args);
      return typeof r === 'bigint' ? r : BigInt(r ?? 0);
    });
  } else {
    bridgeFunctions.set(i, () => 0n);
  }
}

napiRuntime.debug = true;
console.log("guest memory base:", k.kernel_guest_memory_base());
console.log("guest memory size:", (k.kernel_guest_memory_size() / 1024 / 1024).toFixed(1), "MB");

// Run _initialize (reactor init)
let status = 0;
let steps = 0;
const MAX_STEPS = 2000000;
while (status === 0 && steps < MAX_STEPS) {
  status = k.kernel_step();
  steps++;
}
console.log("_initialize:", status === 1 ? "OK" : `FAIL (status=${status})`);

if (status === 1) {
  // Helper to call a guest export by name
  function callGuestExport(name, args) {
    const fnNamePtr = k.kernel_alloc(name.length + 1);
    const buf = new Uint8Array(k.memory.buffer, fnNamePtr, name.length + 1);
    new TextEncoder().encodeInto(name, buf);
    buf[name.length] = 0;
    const argvPtr = k.kernel_alloc(args.length * 4);
    const dv = new DataView(k.memory.buffer);
    args.forEach((a, i) => dv.setUint32(argvPtr + i * 4, a, true));
    const result = k.kernel_call(fnNamePtr, argvPtr, args.length);
    const retVal = dv.getUint32(argvPtr, true);
    return { result, retVal };
  }

  // Step 1: Call __napi_register__Scanner_struct_4 and __napi_register__Scanner_impl_13
  // These register the Scanner class descriptors in a global list inside the guest
  console.log("\nRegistering Scanner descriptors...");
  callGuestExport("__napi_register__Scanner_struct_4", []);
  callGuestExport("__napi_register__Scanner_impl_13", []);

  // Step 2: Call napi_register_module_v1(env, exports)
  // This iterates the registered descriptors and calls napi_define_class etc.
  console.log("Calling napi_register_module_v1...");
  const exportsObj = {};
  const exportsHandle = napiRuntime._newHandle(exportsObj);

  const { result: regResult, retVal: returnedHandle } =
    callGuestExport("napi_register_module_v1", [1, exportsHandle]);
  console.log("napi_register_module_v1:", regResult === 0 ? "OK" : `FAIL(${regResult})`);

  if (regResult === 0) {
    const returnedObj = napiRuntime._getHandle(returnedHandle);
    console.log("exports handle:", returnedHandle);
    console.log("exports keys:", Object.keys(returnedObj ?? exportsObj));
    console.log("Scanner?", typeof (returnedObj ?? exportsObj)?.Scanner);
  }
}

console.log("\n--- Results ---");
console.log("exit code:", k.kernel_exit_code());
console.log("steps:", steps);
console.log("bridge calls:", callLog.length);
if (callLog.length > 0) {
  const counts = {};
  callLog.forEach(i => { const n = bridgeNames[i]; counts[n] = (counts[n] || 0) + 1; });
  console.log("call breakdown:");
  Object.entries(counts).sort((a,b) => b[1]-a[1]).forEach(([name, count]) => {
    console.log(`  ${name}: ${count}`);
  });
}
