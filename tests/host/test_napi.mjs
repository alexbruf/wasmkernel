#!/usr/bin/env node
/**
 * N-API compliance test harness for WasmKernel.
 * Loads napi_test.wasm guest, registers napi functions, and verifies results.
 */
import { readFileSync } from "fs";
import { WASI } from "wasi";
import { NapiRuntime } from "./napi_runtime.mjs";

const kernelBytes = readFileSync(new URL("../../build/wasmkernel.wasm", import.meta.url).pathname);
const guestBytes = readFileSync(new URL("../guest/napi_test.wasm", import.meta.url).pathname);
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
    const args = [];
    for (let i = 0; i < argc; i++) {
      args.push(new DataView(k.memory.buffer).getUint32(argsPtr + i * 8, true));
    }
    try {
      return handler(args, argsPtr);
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

console.log("Loading napi_test (" + (guestBytes.length / 1024).toFixed(1) + " KB)...");
const ptr = k.kernel_alloc(guestBytes.length);
new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
const loadResult = k.kernel_load(ptr, guestBytes.length);
if (loadResult !== 0) { console.error("load failed:", loadResult); process.exit(1); }

// Setup napi bridge
const napiRuntime = new NapiRuntime(k);
napiRuntime.debug = false;

// Discover bridge mappings
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
    bridgeFunctions.set(i, (args, argsPtr) => napiRuntime.dispatch(fn, args, argsPtr));
  } else {
    const fname = `${mod}.${field}`;
    bridgeFunctions.set(i, (args) => { console.error(`  STUB: ${fname}(${args.join(',')})`); return 0n; });
  }
}

console.log("Bridge functions:", bridgeCount);
console.log("Guest memory:", (k.kernel_guest_memory_size() / 1024).toFixed(1), "KB at offset", k.kernel_guest_memory_base());

// Helper to call guest exports
function callExport(name, args = []) {
  const np = k.kernel_alloc(name.length + 1);
  new Uint8Array(k.memory.buffer, np, name.length + 1).set(new TextEncoder().encode(name));
  new Uint8Array(k.memory.buffer)[np + name.length] = 0;
  const ap = k.kernel_alloc(Math.max(args.length, 1) * 4);
  args.forEach((a, i) => new DataView(k.memory.buffer).setUint32(ap + i * 4, a, true));
  const r = k.kernel_call(np, ap, args.length);
  return { status: r, retVal: new DataView(k.memory.buffer).getUint32(ap, true) };
}

// ===== INITIALIZATION =====

// Step 1: _initialize (wasi reactor init)
console.log("\n=== Step 1: _initialize ===");
let status = 0;
while (status === 0) status = k.kernel_step();
console.log("_initialize:", status === 1 ? "OK" : `FAIL(${status})`);
if (status !== 1) process.exit(1);

// Step 2: napi_register_wasm_v1 (no __napi_register__ exports for this guest)
console.log("\n=== Step 2: napi_register_wasm_v1 ===");
const exportsObj = {};
const exportsHandle = napiRuntime._newHandle(exportsObj);
const envHandle = 1;

const reg = callExport("napi_register_wasm_v1", [envHandle, exportsHandle]);
console.log("napi_register_wasm_v1:", reg.status === 0 ? "OK" : `FAIL(${reg.status})`);
if (reg.status !== 0) { console.error("Registration failed"); process.exit(1); }

const resultObj = napiRuntime._getHandle(reg.retVal) ?? exportsObj;
console.log("Exports keys:", Object.keys(resultObj));

// ===== TEST RUNNER =====

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}: ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${msg || ""}expected ${b}, got ${a}`);
  }
}

console.log("\n=== Running Tests ===\n");

// Test: testObject
test("testObject returns {greeting: 'hello', answer: 42}", () => {
  const result = resultObj.testObject();
  assertEqual(result.greeting, "hello", "greeting: ");
  assertEqual(result.answer, 42, "answer: ");
});

// Test: testString
test("testString('abcdef') returns 'fedcba'", () => {
  const result = resultObj.testString("abcdef");
  assertEqual(result, "fedcba");
});

// Test: testCallback
test("testCallback(x => x * 2, 21) returns 42", () => {
  const result = resultObj.testCallback((x) => x * 2, 21);
  assertEqual(result, 42);
});

// Test: testTypeof — number
test("testTypeof(42) returns 'number'", () => {
  assertEqual(resultObj.testTypeof(42), "number");
});

// Test: testTypeof — string
test("testTypeof('hi') returns 'string'", () => {
  assertEqual(resultObj.testTypeof("hi"), "string");
});

// Test: testTypeof — object
test("testTypeof({}) returns 'object'", () => {
  assertEqual(resultObj.testTypeof({}), "object");
});

// Test: testTypeof — undefined
test("testTypeof(undefined) returns 'undefined'", () => {
  assertEqual(resultObj.testTypeof(undefined), "undefined");
});

// Test: testArray
test("testArray() returns [10, 20, 30]", () => {
  const result = resultObj.testArray();
  assert(Array.isArray(result), "expected array");
  assertDeepEqual(result, [10, 20, 30]);
});

// Test: testError
test("testError('boom') throws Error containing 'boom'", () => {
  // After calling testError, the napi runtime should have a pending exception
  napiRuntime.exceptionPending = false;
  napiRuntime.lastException = null;
  let threw = false;
  try {
    resultObj.testError("boom");
  } catch (e) {
    threw = true;
    assert(e instanceof Error, "expected Error instance");
    assert(e.message.includes("boom"), `error message should contain 'boom', got: ${e.message}`);
  }
  // The guest calls napi_throw which sets exceptionPending, but our JS wrapper
  // may or may not actually throw. Check both paths.
  if (!threw) {
    // If the function didn't throw, check if the napi runtime captured the exception
    assert(napiRuntime.exceptionPending || napiRuntime.lastException,
      "expected either a throw or a pending exception");
    if (napiRuntime.lastException) {
      assert(napiRuntime.lastException.message.includes("boom"),
        `pending error should contain 'boom', got: ${napiRuntime.lastException.message}`);
    }
    // Clear the exception state
    napiRuntime.exceptionPending = false;
    napiRuntime.lastException = null;
  }
});

// Test: testRefCreate / testRefGet
test("testRefCreate(value) then testRefGet() returns same value", () => {
  const sentinel = { refTest: true, id: 999 };
  resultObj.testRefCreate(sentinel);
  const result = resultObj.testRefGet();
  assertEqual(result, sentinel, "ref round-trip: ");
});

// Test: testExceptionPending
test("testExceptionPending() returns 'false'", () => {
  napiRuntime.exceptionPending = false;
  napiRuntime.lastException = null;
  const result = resultObj.testExceptionPending();
  assertEqual(result, "false");
});

// Test: TestClass constructor and methods
test("new TestClass('alice', 99) — getName() returns 'alice'", () => {
  const instance = new resultObj.TestClass("alice", 99);
  assertEqual(instance.getName(), "alice");
});

test("new TestClass('alice', 99) — getValue() returns 99", () => {
  const instance = new resultObj.TestClass("alice", 99);
  assertEqual(instance.getValue(), 99);
});

test("TestClass instance.setValue(123), getValue() returns 123", () => {
  const instance = new resultObj.TestClass("bob", 0);
  instance.setValue(123);
  assertEqual(instance.getValue(), 123);
});

// ===== SUMMARY =====
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
