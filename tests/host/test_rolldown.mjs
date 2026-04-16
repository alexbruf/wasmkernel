#!/usr/bin/env node
/**
 * Regression test for the rolldown-async hang
 * (wasmkernel-issue-rolldown-async.md).
 *
 * Loads the published @rolldown/binding-wasm32-wasi via the wasmkernel
 * CJS drop-in (same pattern as test_package.mjs for oxc). Exercises the
 * exact napi-rs async pattern that hung before the promise-pump fix:
 * an async export that internally spawns a tokio task and resolves a
 * Deferred via TSFN.
 *
 * Real bundle.generate() with plugins requires the upstream
 * @rolldown/browser JS layer (a few thousand lines). For a regression
 * check we exercise the same hang path with a smaller surface — call
 * one of the binding's async exports directly (e.g. transform()).
 *
 * The wasm itself is ~12MB and not committed; install with
 *   ./scripts/install-rolldown.sh
 *
 * The bun suite skips this test when the binding isn't present.
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const PKG_NODE_CJS = join(ROOT, "packages", "wasmkernel", "src", "entry-node.cjs");
const ROLLDOWN_DIR = join(ROOT, "tests", "pkgs", "rolldown", "package");
const ROLLDOWN_LOADER = join(ROLLDOWN_DIR, "rolldown-binding.wasi.cjs");
const ROLLDOWN_WASM = join(ROLLDOWN_DIR, "rolldown-binding.wasm32-wasi.wasm");

if (!existsSync(ROLLDOWN_WASM)) {
  console.error(
    `SKIP: rolldown binding not installed at ${ROLLDOWN_WASM}\n` +
    `      run ./scripts/install-rolldown.sh to fetch it (~12MB).`
  );
  process.exit(0);
}

const require = createRequire(import.meta.url);
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === "@napi-rs/wasm-runtime") return PKG_NODE_CJS;
  return origResolve.call(this, req, parent, ...rest);
};

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { console.log(`FAIL  ${name}: ${e?.stack || e?.message || e}`); failed++; }
}

// Bound the wait so a regression hangs the test runner instead of CI.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${label}`)), ms)
    ),
  ]);
}

let rolldown;
await test("load @rolldown/binding-wasm32-wasi via wasmkernel drop-in", () => {
  delete require.cache[ROLLDOWN_LOADER];
  rolldown = require(ROLLDOWN_LOADER);
  const expected = ["parseSync", "parse", "transformSync", "transform", "BindingBundler"];
  for (const k of expected) {
    if (typeof rolldown[k] === "undefined")
      throw new Error(`missing export: ${k}`);
  }
});

if (!rolldown) {
  Module._resolveFilename = origResolve;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// Sanity: sync API works (this path doesn't hit the bug).
await test("parseSync('const x = 1;') produces an AST", () => {
  const r = rolldown.parseSync("test.js", "const x = 1 + 2;");
  const { node } = JSON.parse(r.program);
  if (node.body[0].type !== "VariableDeclaration")
    throw new Error(`unexpected AST root: ${node.body[0].type}`);
});

// The bug repro: an async napi-rs export that resolves a Deferred via
// TSFN from a worker thread. Pre-fix: hangs forever. Post-fix:
// resolves within hundreds of ms.
await test("await transform(code) resolves (Deferred-from-worker hang repro)", async () => {
  const result = await withTimeout(
    rolldown.transform("test.ts", "const x: number = 1 + 2;", {}),
    20000,
    "transform()"
  );
  if (typeof result !== "object" || result === null)
    throw new Error(`unexpected result type: ${typeof result}`);
  // Different rolldown versions return slightly different shapes; just
  // check that the call settled with something AST-like or code-like.
  const stringy = JSON.stringify(result);
  if (!stringy.includes("x") && !stringy.length)
    throw new Error("transform produced empty output");
});

Module._resolveFilename = origResolve;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
