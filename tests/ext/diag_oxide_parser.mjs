/**
 * Diagnostic: compare the bytes-only wasm export parser in entry-browser.js
 * against WebAssembly.Module.exports() on the oxide binary.
 *
 * If the two disagree on __napi_register__* names, that's the root cause of
 * the Scanner constructor hang in mirage.
 */
import { readFileSync } from "node:fs";

const OXIDE_PATH =
  "/Users/alexbruf/viewengine/tools/mirage/node_modules/@tailwindcss/oxide-wasm32-wasi/tailwindcss-oxide.wasm32-wasi.wasm";

const bytes = new Uint8Array(readFileSync(OXIDE_PATH));
console.log(`oxide bytes: ${bytes.length}`);

// --- Parser from entry-browser.js (copy) ---
function parseWasmFunctionExports(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (
    u8.length < 8 ||
    u8[0] !== 0x00 ||
    u8[1] !== 0x61 ||
    u8[2] !== 0x73 ||
    u8[3] !== 0x6d
  ) {
    throw new Error("invalid wasm magic");
  }
  let p = 8;
  function leb() {
    let result = 0,
      shift = 0,
      byte;
    do {
      byte = u8[p++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result >>> 0;
  }
  const td = new TextDecoder();
  const funcExports = [];
  while (p < u8.length) {
    const id = u8[p++];
    const size = leb();
    const sectionEnd = p + size;
    if (id === 7) {
      const count = leb();
      for (let i = 0; i < count; i++) {
        const nameLen = leb();
        const name = td.decode(u8.subarray(p, p + nameLen));
        p += nameLen;
        const kind = u8[p++];
        leb(); // index
        if (kind === 0) funcExports.push(name);
      }
      return funcExports;
    }
    p = sectionEnd;
  }
  return funcExports;
}

const parsed = parseWasmFunctionExports(bytes);
const parsedNapiReg = parsed.filter((n) => n.startsWith("__napi_register__"));
console.log(
  `\nparser found ${parsed.length} function exports total, ${parsedNapiReg.length} __napi_register__*:`
);
for (const n of parsedNapiReg) console.log("  parser:", n);

const guestModule = await WebAssembly.compile(bytes);
const canonicalExports = WebAssembly.Module.exports(guestModule);
const canonicalFuncs = canonicalExports.filter((e) => e.kind === "function");
const canonicalNapiReg = canonicalFuncs
  .filter((e) => e.name.startsWith("__napi_register__"))
  .map((e) => e.name);
console.log(
  `\nWebAssembly.Module.exports() found ${canonicalFuncs.length} function exports, ${canonicalNapiReg.length} __napi_register__*:`
);
for (const n of canonicalNapiReg) console.log("  canonical:", n);

// Diff
const parsedSet = new Set(parsedNapiReg);
const canonicalSet = new Set(canonicalNapiReg);
const onlyInParsed = [...parsedSet].filter((n) => !canonicalSet.has(n));
const onlyInCanonical = [...canonicalSet].filter((n) => !parsedSet.has(n));

console.log("\n=== diff ===");
console.log("only in parser:", onlyInParsed);
console.log("only in canonical:", onlyInCanonical);

if (onlyInCanonical.length === 0 && onlyInParsed.length === 0) {
  console.log("\nparser and canonical agree — parser is NOT the cause of the hang");
} else {
  console.log("\nparser MISSES some register functions — this likely causes the hang");
}

// Also check total function export count agreement
console.log(
  `\ntotal function export counts: parser=${parsed.length} canonical=${canonicalFuncs.length}`
);
if (parsed.length !== canonicalFuncs.length) {
  console.log("parser function export count differs from canonical — parser bug");
}
