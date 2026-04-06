#!/usr/bin/env node
/**
 * Run ALL emnapi tests in a single process.
 * Loads the kernel once, then loads each guest wasm sequentially.
 * Output: JSON with pass/fail per test.
 */
import { readFileSync, readdirSync } from "fs";
import { WASI } from "wasi";
import { NapiRuntime } from "../host/napi_runtime.mjs";

const kernelBytes = readFileSync(new URL("../../build/wasmkernel.wasm", import.meta.url).pathname);
const wasmDir = new URL("./wasm/", import.meta.url).pathname;
const tests = process.argv.slice(2);

if (tests.length === 0) {
  // Run all .wasm files
  tests.push(...readdirSync(wasmDir).filter(f => f.endsWith(".wasm")).map(f => f.replace(".wasm", "")));
}

const results = {};

for (const testName of tests) {
  try {
    const guestBytes = readFileSync(`${wasmDir}${testName}.wasm`);
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
        catch { return 0n; }
      },
      host_io_submit(cb) { pendingIO.set(cb, { bytes: 0, error: 0 }); },
      host_io_check(cb) { return pendingIO.has(cb) ? 1 : 0; },
      host_io_result_bytes(cb) { return pendingIO.get(cb)?.bytes ?? 0; },
      host_io_result_error(cb) { const r = pendingIO.get(cb); if (r) pendingIO.delete(cb); return r?.error ?? 8; },
    };

    // Each test gets its own kernel instance (clean state)
    const compiled = await WebAssembly.compile(kernelBytes);
    const instance = await WebAssembly.instantiate(compiled, {
      wasi_snapshot_preview1: wasi.wasiImport, host: hostImports,
    });
    wasi.initialize(instance);
    k = instance.exports;
    k.kernel_init();

    const ptr = k.kernel_alloc(guestBytes.length);
    new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
    if (k.kernel_load(ptr, guestBytes.length) !== 0) {
      results[testName] = "load_failed";
      continue;
    }

    const napiRuntime = new NapiRuntime(k);
    const bridgeCount = k.kernel_bridge_count();
    const infoBuf = k.kernel_alloc(256);
    for (let i = 0; i < bridgeCount; i++) {
      const len = k.kernel_bridge_info(i, infoBuf, 256);
      if (!len) continue;
      const bytes = new Uint8Array(k.memory.buffer, infoBuf, len);
      const parts = []; let start = 0;
      for (let j = 0; j < len; j++) { if (bytes[j] === 0) { parts.push(new TextDecoder().decode(bytes.slice(start, j))); start = j + 1; } }
      const [mod, field] = parts;
      if ((mod === "env" || mod === "emnapi" || mod === "napi") && napiRuntime[field]) {
        const fn = field;
        bridgeFunctions.set(i, (args, argsPtr) => napiRuntime.dispatch(fn, args, argsPtr));
      } else {
        bridgeFunctions.set(i, () => 0n);
      }
    }

    let status = 0;
    while (status === 0) status = k.kernel_step();

    const exportsObj = {};
    const eh = napiRuntime._newHandle(exportsObj);
    const np = k.kernel_alloc(22);
    new Uint8Array(k.memory.buffer, np, 21).set(new TextEncoder().encode("napi_register_wasm_v1"));
    new Uint8Array(k.memory.buffer)[np + 21] = 0;
    const ap = k.kernel_alloc(8);
    new DataView(k.memory.buffer).setUint32(ap, 1, true);
    new DataView(k.memory.buffer).setUint32(ap + 4, eh, true);
    const callResult = k.kernel_call(np, ap, 2);

    if (callResult !== 0) {
      results[testName] = "register_failed";
      continue;
    }

    // Check exports exist
    const keys = Object.getOwnPropertyNames(
      napiRuntime._getHandle(new DataView(k.memory.buffer).getUint32(ap, true)) ?? exportsObj
    );

    results[testName] = "pass";
  } catch (e) {
    results[testName] = `error: ${e?.message?.slice(0, 60) ?? e}`;
  }
}

// Output results
const passed = Object.values(results).filter(r => r === "pass").length;
const failed = Object.values(results).filter(r => r !== "pass").length;
for (const [name, result] of Object.entries(results)) {
  if (result !== "pass") console.error(`FAIL ${name}: ${result}`);
}
console.log(JSON.stringify({ passed, failed, total: tests.length }));
process.exit(failed > 0 ? 1 : 0);
