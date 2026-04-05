#!/usr/bin/env node
/**
 * Node.js Node-API compatibility tests.
 * Adapted from test/js-native-api/ in the Node.js repo.
 * Runs napi_node_compat.wasm through WasmKernel.
 */
import { readFileSync } from "fs";
import { WASI } from "wasi";
import { NapiRuntime } from "./napi_runtime.mjs";

const kernelBytes = readFileSync(new URL("../../build/wasmkernel.wasm", import.meta.url).pathname);
const guestBytes = readFileSync(new URL("../guest/napi_node_compat.wasm", import.meta.url).pathname);
const wasi = new WASI({ version: "preview1", args: [], env: {} });

const pendingIO = new Map();
const bridgeFunctions = new Map();

const hostImports = {
  host_func_call(funcIdx, argsPtr, argc) {
    const handler = bridgeFunctions.get(funcIdx);
    if (!handler) return 0n;
    const args = [];
    for (let i = 0; i < argc; i++) {
      args.push(new DataView(k.memory.buffer).getUint32(argsPtr + i * 8, true));
    }
    try { return handler(args, argsPtr); }
    catch (e) { console.error(`BRIDGE ERROR [${funcIdx}]: ${e.message}`); return 0n; }
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

const ptr = k.kernel_alloc(guestBytes.length);
new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
const loadResult = k.kernel_load(ptr, guestBytes.length);
if (loadResult !== 0) { console.error("load failed:", loadResult); process.exit(1); }

const napiRuntime = new NapiRuntime(k);

// Discover bridge
const bridgeCount = k.kernel_bridge_count();
const infoBuf = k.kernel_alloc(256);
for (let i = 0; i < bridgeCount; i++) {
  const len = k.kernel_bridge_info(i, infoBuf, 256);
  if (!len) continue;
  const bytes = new Uint8Array(k.memory.buffer, infoBuf, len);
  const parts = []; let start = 0;
  for (let j = 0; j < len; j++) { if (bytes[j] === 0) { parts.push(new TextDecoder().decode(bytes.slice(start, j))); start = j + 1; } }
  const [mod, field] = parts;
  if (mod === "env" && napiRuntime[field]) {
    const fn = field;
    bridgeFunctions.set(i, (args, argsPtr) => napiRuntime.dispatch(fn, args, argsPtr));
  } else {
    bridgeFunctions.set(i, () => 0n);
  }
}

// Initialize
let status = 0;
while (status === 0) status = k.kernel_step();

// Register
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
const resultObj = napiRuntime._getHandle(reg.retVal) ?? exportsObj;

// ===== Test runner =====
let passed = 0, failed = 0;
function assert(name, condition, msg = "") {
  if (condition) { console.log(`PASS  ${name}`); passed++; }
  else { console.log(`FAIL  ${name}${msg ? ": " + msg : ""}`); failed++; }
}

// ===== Tests adapted from Node.js test/js-native-api/ =====

// 2_function_arguments: Add(3, 4) = 7
{
  const r = resultObj.add(3, 4);
  assert("2_function_arguments: add(3, 4) = 7", r === 7, `got ${r}`);
}
{
  const r = resultObj.add(100, -50);
  assert("2_function_arguments: add(100, -50) = 50", r === 50, `got ${r}`);
}

// 3_callbacks: RunCallback(fn)
{
  const r = resultObj.runCallback(() => "from callback");
  assert("3_callbacks: runCallback returns callback result", r === "from callback", `got ${r}`);
}
{
  const r = resultObj.runCallback((x) => x + "!", "hello");
  assert("3_callbacks: runCallback passes arg", r === "hello!", `got ${r}`);
}

// 4_object_factory: CreateObject(msg)
{
  const r = resultObj.createObject("hi there");
  assert("4_object_factory: createObject returns {msg}", r && r.msg === "hi there", `got ${JSON.stringify(r)}`);
}
{
  const a = resultObj.createObject("a");
  const b = resultObj.createObject("b");
  assert("4_object_factory: creates distinct objects", a.msg === "a" && b.msg === "b" && a !== b);
}

// 5_function_factory: CreateFunction()
{
  const fn = resultObj.createFunction();
  assert("5_function_factory: returns a function", typeof fn === "function");
  const r = fn();
  assert("5_function_factory: returned fn works", r === "hello from inner", `got ${r}`);
}

// test_string: ConcatStrings + StringLength
{
  const r = resultObj.concatStrings("hello ", "world");
  assert("test_string: concat 'hello ' + 'world'", r === "hello world", `got ${r}`);
}
{
  const r = resultObj.stringLength("testing");
  assert("test_string: length of 'testing' = 7", r === 7, `got ${r}`);
}
{
  const r = resultObj.concatStrings("", "empty");
  assert("test_string: concat '' + 'empty'", r === "empty", `got ${r}`);
}

// test_error: CheckError + MakeError
{
  const err = new Error("test error");
  const r = resultObj.checkError(err);
  assert("test_error: checkError(new Error) = true", r === "true", `got ${r}`);
}
{
  const r = resultObj.checkError("not an error");
  assert("test_error: checkError('not an error') = false", r === "false", `got ${r}`);
}
{
  const err = resultObj.makeError("CODE", "the message");
  assert("test_error: makeError returns Error instance", err instanceof Error, `got ${typeof err}`);
  assert("test_error: makeError message", err.message === "the message", `got ${err.message}`);
}

// test_array: ArrayFromArgs + ArrayGet
{
  const r = resultObj.arrayFromArgs("a", "b", "c");
  assert("test_array: arrayFromArgs length", Array.isArray(r) && r.length === 3, `got ${JSON.stringify(r)}`);
  assert("test_array: arrayFromArgs values", r[0] === "a" && r[1] === "b" && r[2] === "c");
}
{
  const arr = resultObj.arrayFromArgs(10, 20, 30);
  const r = resultObj.arrayGet(arr, 1);
  assert("test_array: arrayGet(arr, 1) = 20", r === 20, `got ${r}`);
}

// test_object: ObjGetNamed + ObjSetNamed + GetTypeof
{
  const obj = { x: 42, y: "hello" };
  const r = resultObj.objGetNamed(obj, "x");
  assert("test_object: getNamed(obj, 'x') = 42", r === 42, `got ${r}`);
}
{
  const obj = { x: 42 };
  resultObj.objSetNamed(obj, "z", "new value");
  assert("test_object: setNamed adds property", obj.z === "new value", `got ${obj.z}`);
}
{
  assert("test_object: typeof 42", resultObj.getTypeof(42) === "number");
  assert("test_object: typeof 'str'", resultObj.getTypeof("str") === "string");
  assert("test_object: typeof {}", resultObj.getTypeof({}) === "object");
  assert("test_object: typeof null", resultObj.getTypeof(null) === "null");
  assert("test_object: typeof undefined", resultObj.getTypeof(undefined) === "undefined");
  assert("test_object: typeof fn", resultObj.getTypeof(() => {}) === "function");
  assert("test_object: typeof true", resultObj.getTypeof(true) === "boolean");
}

// test_reference: StoreRef + LoadRef + DeleteRef
{
  const val = { key: "stored" };
  resultObj.storeRef(val);
  const r = resultObj.loadRef();
  assert("test_reference: store and load ref", r === val, `got ${JSON.stringify(r)}`);
  assert("test_reference: ref identity preserved", r.key === "stored");
}
{
  resultObj.deleteRef();
  // After delete, loadRef should throw
  try {
    resultObj.loadRef();
    assert("test_reference: loadRef after delete throws", false, "did not throw");
  } catch (e) {
    assert("test_reference: loadRef after delete throws", true);
  }
}

// ===== Summary =====
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
