#!/usr/bin/env node
/**
 * Verify @wasmkernel/runtime works as:
 *   1. A direct loader (loadNapiRs → exports)
 *   2. A drop-in replacement for @napi-rs/wasm-runtime in an unmodified
 *      published parser.wasi.cjs loader
 *
 * This is the regression test for "does the package work like it's
 * supposed to". Run from repo root.
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { copyFileSync, mkdirSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const PKG_NODE_CJS = join(ROOT, "packages", "wasmkernel", "src", "entry-node.cjs");
const PKG_NODE_ESM = join(ROOT, "packages", "wasmkernel", "src", "entry-node.js");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}: ${e?.message || e}`); failed++; }
}

// === TEST 1: direct ESM usage ===
await test("direct loadNapiRs — oxc-parser", async () => {
  const { loadNapiRs } = await import(PKG_NODE_ESM);
  const { exports: oxc } = await loadNapiRs(
    join(ROOT, "tests", "emnapi", "wasm", "oxc_parser.wasm")
  );
  if (!oxc.parseSync) throw new Error("parseSync missing");
  const r = oxc.parseSync("test.js", "const x = 1 + 2;");
  const { node } = JSON.parse(r.program);
  if (node.body[0].type !== "VariableDeclaration") throw new Error("parse wrong");
});

// === TEST 2: CJS drop-in replacement for @napi-rs/wasm-runtime ===
await test("CJS drop-in — unmodified parser.wasi.cjs via @napi-rs/wasm-runtime alias", async () => {
  // The published .wasi.cjs does `require('@napi-rs/wasm-runtime')`.
  // We override Module._resolveFilename to route that to our CJS entry.
  const require = createRequire(import.meta.url);
  const Module = require("module");
  const origResolve = Module._resolveFilename;

  // Stage the published parser.wasi.cjs + wasm in a tmp dir so the loader's
  // __dirname-relative resolution works. Source is the unmodified npm tarball
  // we ship under tests/pkgs/oxc/package/ — same files you'd get from
  // `npm install @oxc-parser/binding-wasm32-wasi`.
  const tmp = join(ROOT, "build", "wasmkernel-dropin-test");
  mkdirSync(tmp, { recursive: true });
  const src = join(ROOT, "tests", "pkgs", "oxc", "package");
  if (!existsSync(join(src, "parser.wasi.cjs"))) {
    throw new Error(`prerequisite missing: ${join(src, "parser.wasi.cjs")}`);
  }
  copyFileSync(join(src, "parser.wasi.cjs"), join(tmp, "parser.wasi.cjs"));
  copyFileSync(join(src, "parser.wasm32-wasi.wasm"), join(tmp, "parser.wasm32-wasi.wasm"));
  if (existsSync(join(src, "wasi-worker.mjs")))
    copyFileSync(join(src, "wasi-worker.mjs"), join(tmp, "wasi-worker.mjs"));

  Module._resolveFilename = function (req, parent, ...rest) {
    if (req === "@napi-rs/wasm-runtime") return PKG_NODE_CJS;
    return origResolve.call(this, req, parent, ...rest);
  };

  try {
    // Clear require cache for the loader so our override takes effect
    delete require.cache[join(tmp, "parser.wasi.cjs")];
    const oxc = require(join(tmp, "parser.wasi.cjs"));
    if (!oxc.parseSync) throw new Error("drop-in: parseSync missing");
    const r = oxc.parseSync("t.js", "const y = 'hello';");
    const { node } = JSON.parse(r.program);
    if (node.body[0].declarations[0].init.value !== "hello")
      throw new Error("drop-in: AST wrong");
  } finally {
    Module._resolveFilename = origResolve;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
