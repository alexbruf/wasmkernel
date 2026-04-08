#!/usr/bin/env node
/**
 * Test loading @tailwindcss/oxide through WasmKernel with napi bridge,
 * using the wasi_passthrough bridge so calls into wasi_snapshot_preview1
 * route through node:wasi (with real preopens) instead of needing
 * hand-written file operations.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { WASI } from "node:wasi";
import { join } from "node:path";
import { NapiRuntime } from "./napi_runtime.mjs";
import { wasiPassthrough } from "../../packages/wasmkernel/src/wasi_passthrough.js";

const kernelBytes = readFileSync(new URL("../../build/wasmkernel.wasm", import.meta.url).pathname);
const guestBytes = readFileSync("/tmp/tw-oxide/package/tailwindcss-oxide.wasm32-wasi.wasm");

// Multi-file recursive layout: two HTML files in nested subdirs of the
// preopen. This exercises rayon's parallel par_iter() inside oxide's
// parse_all_blobs() — the path that needs the cooperative-scheduler
// fixes (slot-0 reservation, kernel_call_indirect cooperative loop,
// and the wasm_interp_call_wasm resume frame fix) to actually return.
const root = "/tmp/wasmkernel-oxide-test";
const testDir = join(root, "src");
mkdirSync(testDir, { recursive: true });
mkdirSync(join(testDir, "pages"), { recursive: true });
const content = '<div class="flex items-center bg-blue-500 p-4 text-white hover:bg-blue-600">Hello</div>';
writeFileSync(join(testDir, "test.html"), content);
writeFileSync(join(testDir, "pages", "about.html"),
  '<section class="max-w-3xl mx-auto grid grid-cols-2 gap-8">about</section>');

const wasi = new WASI({
  version: "preview1",
  args: [],
  env: {},
  preopens: { [root]: root },
});

const bridgeFunctions = new Map();
let bridgeNames = [];
let k;

const hostImports = {
  host_func_call(funcIdx, argsPtr, argc) {
    const handler = bridgeFunctions.get(funcIdx);
    if (!handler) return 0n;
    const args = [];
    for (let i = 0; i < argc; i++)
      args.push(new DataView(k.memory.buffer).getUint32(argsPtr + i * 8, true));
    try { return handler(args, argsPtr); }
    catch (e) { console.error(`  BRIDGE ERROR ${bridgeNames[funcIdx]}: ${e.message}`); return 0n; }
  },
  host_io_submit() {},
  host_io_check() { return 0; },
  host_io_result_bytes() { return 0; },
  host_io_result_error() { return 0; },
};

const compiled = await WebAssembly.compile(kernelBytes);
const instance = await WebAssembly.instantiate(compiled, {
  wasi_snapshot_preview1: wasi.wasiImport,
  host: hostImports,
});
wasi.initialize(instance);
k = instance.exports;
k.kernel_init();

console.log("Loading oxide (" + (guestBytes.length / 1024 / 1024).toFixed(1) + " MB)...");
const ptr = k.kernel_alloc(guestBytes.length);
new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
const loadResult = k.kernel_load(ptr, guestBytes.length);
if (loadResult !== 0) { console.error("load failed:", loadResult); process.exit(1); }

const napiRuntime = new NapiRuntime(k);
napiRuntime.debug = false;

const passthroughBridges = wasiPassthrough({ wasi })(k);

const bridgeCount = k.kernel_bridge_count();
const infoBuf = k.kernel_alloc(256);
bridgeNames = [];
for (let i = 0; i < bridgeCount; i++) {
  const len = k.kernel_bridge_info(i, infoBuf, 256);
  if (!len) { bridgeNames.push(`?${i}`); continue; }
  const bytes = new Uint8Array(k.memory.buffer, infoBuf, len);
  const parts = []; let start = 0;
  for (let j = 0; j < len; j++) {
    if (bytes[j] === 0) { parts.push(new TextDecoder().decode(bytes.slice(start, j))); start = j + 1; }
  }
  const [mod, field] = parts;
  bridgeNames.push(`${mod}.${field}`);
  if (mod === "env" && napiRuntime[field]) {
    const fn = field;
    bridgeFunctions.set(i, (args, argsPtr) => napiRuntime.dispatch(fn, args, argsPtr));
  } else if (mod === "wasi_snapshot_preview1" && passthroughBridges[field]) {
    const handler = passthroughBridges[field];
    bridgeFunctions.set(i, (args, argsPtr) => {
      const r = handler(args, argsPtr);
      return typeof r === "bigint" ? r : BigInt(r ?? 0);
    });
  } else {
    bridgeFunctions.set(i, () => 0n);
  }
}

console.log("Guest memory:", (k.kernel_guest_memory_size() / 1024 / 1024).toFixed(1), "MB at offset", k.kernel_guest_memory_base());

function callExport(name, args = []) {
  const np = k.kernel_alloc(name.length + 1);
  new Uint8Array(k.memory.buffer, np, name.length + 1).set(new TextEncoder().encode(name));
  new Uint8Array(k.memory.buffer)[np + name.length] = 0;
  const ap = k.kernel_alloc(Math.max(args.length, 1) * 4);
  args.forEach((a, i) => new DataView(k.memory.buffer).setUint32(ap + i * 4, a, true));
  const r = k.kernel_call(np, ap, args.length);
  return { status: r, retVal: new DataView(k.memory.buffer).getUint32(ap, true) };
}

// ===== EMNAPI-COMPATIBLE INITIALIZATION FLOW =====

console.log("\n=== Step 1: _initialize ===");
let status = 0;
while (status === 0) status = k.kernel_step();
console.log("_initialize:", status === 1 ? "OK" : `FAIL(${status})`);
if (status !== 1) process.exit(1);

console.log("\n=== Step 2: beforeInit (__napi_register__) ===");
const r1 = callExport("__napi_register__Scanner_struct_4");
console.log("Scanner_struct_4:", r1.status === 0 ? "OK" : `FAIL(${r1.status})`);
const r2 = callExport("__napi_register__Scanner_impl_13");
console.log("Scanner_impl_13:", r2.status === 0 ? "OK" : `FAIL(${r2.status})`);

console.log("\n=== Step 3: napi_register_wasm_v1 ===");
const exportsObj = {};
const exportsHandle = napiRuntime._newHandle(exportsObj);
const reg = callExport("napi_register_wasm_v1", [1, exportsHandle]);
console.log("napi_register_wasm_v1:", reg.status === 0 ? "OK" : `FAIL(${reg.status})`);

const resultObj = napiRuntime._getHandle(reg.retVal) ?? exportsObj;
console.log("\n=== Results ===");
console.log("Exports keys:", Object.keys(resultObj));

if (resultObj.Scanner) {
  console.log("Scanner class:", resultObj.Scanner);
  console.log("Scanner methods:", Object.keys(resultObj.Scanner.prototype ?? {}));

  console.log("\n=== Trying Scanner ===");
  try {
    const scanner = new resultObj.Scanner({
      sources: [{ base: testDir, pattern: "**/*.html", negated: false }],
    });
    console.log("Scanner created:", scanner);
    console.log("\nScanning:", content.slice(0, 60) + "...");

    const scan2 = scanner.scan();
    console.log("scan() result:", JSON.stringify(scan2)?.slice(0, 300));
    if (Array.isArray(scan2)) console.log("scan count:", scan2.length);
  } catch (e) {
    console.error("Scanner error:", e.message);
    console.error("Stack:", e.stack?.split('\n').slice(0, 5).join('\n'));
  }
}
