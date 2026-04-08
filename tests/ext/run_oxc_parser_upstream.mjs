#!/usr/bin/env node
/**
 * One-shot runner: download oxc-parser's upstream test suite and run it
 * against wasmkernel's napi-rs loader.
 *
 * NOT part of CI — this is for manual validation when you want to know
 * how deep our N-API coverage is against a real third-party test suite
 * that doesn't know we exist.
 *
 * What it does:
 *   1. Shells out to `npm pack oxc-parser` to get the published source tree
 *      (src-js/index.js, wrap.js, raw-transfer/, generated/, etc.)
 *   2. Replaces src-js/bindings.js with a shim that loads the wasm32-wasi
 *      binary through wasmkernel instead of the native .node addon
 *   3. Fetches the upstream test file (test/parse.test.ts) from github
 *   4. Rewrites vitest imports + TS annotations to our minimal compat shim
 *   5. Imports and runs the tests, reporting pass/fail
 *
 * Run with:
 *   node --expose-gc --experimental-wasi-unstable-preview1 \
 *     tests/ext/run_oxc_parser_upstream.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const KERNEL = join(ROOT, "build", "wasmkernel.wasm");
const WASM = join(ROOT, "tests", "emnapi", "wasm", "oxc_parser.wasm");
const WORK = "/tmp/oxc-upstream-run";
const OXC_VERSION = "0.124.0";

// === Step 1: fetch oxc-parser sources ===
function fetchOxcSources() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  console.log("[fetch] npm pack oxc-parser@" + OXC_VERSION);
  // npm pack prints progress lines + the filename on the last non-empty line
  const out = execFileSync("npm", ["pack", "--silent", `oxc-parser@${OXC_VERSION}`], {
    cwd: WORK, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  });
  const tgz = out.trim().split("\n").filter(l => l.endsWith(".tgz")).pop();
  if (!tgz) throw new Error("npm pack: couldn't find .tgz in output:\n" + out);
  execFileSync("tar", ["-xzf", join(WORK, tgz), "-C", WORK]);
  // Strip the wrapping `package/` dir
  cpSync(join(WORK, "package", "src-js"), join(WORK, "src-js"), { recursive: true });
  // Also copy package.json so module resolution works
  cpSync(join(WORK, "package", "package.json"), join(WORK, "package.json"));
}

// === Step 2: shim bindings.js ===
function writeBindingsShim() {
  const shimPath = join(WORK, "src-js", "bindings.js");
  writeFileSync(shimPath, `/* wasmkernel shim — replaces oxc-parser's native binding loader */
import { loadNapiRs } from ${JSON.stringify(pathToFileURL(join(__dirname, "..", "host", "napi_rs_loader.mjs")).href)};

const { exports: binding } = await loadNapiRs(
  ${JSON.stringify(KERNEL)},
  ${JSON.stringify(WASM)}
);

export const Severity = binding.Severity;
export const ParseResult = binding.ParseResult;
export const ExportExportNameKind = binding.ExportExportNameKind;
export const ExportImportNameKind = binding.ExportImportNameKind;
export const ExportLocalNameKind = binding.ExportLocalNameKind;
export const ImportNameKind = binding.ImportNameKind;
export const parse = binding.parse;
export const parseSync = binding.parseSync;
export const rawTransferSupported = binding.rawTransferSupported;
// Optional rawTransfer exports — may be undefined in wasm builds
export const getBufferOffset = binding.getBufferOffset;
export const parseRaw = binding.parseRaw;
export const parseRawSync = binding.parseRawSync;
`);
}

// === Step 3: fetch upstream parse.test.ts ===
function fetchUpstreamTest() {
  // oxc uses `oxc_parser@<ver>` tags rather than `v<ver>`, but those lag the
  // published npm releases. Just pull from main — the test file is stable.
  console.log("[fetch] upstream parse.test.ts from oxc-project/oxc@main");
  const body = execFileSync("gh", [
    "api", "repos/oxc-project/oxc/contents/napi/parser/test/parse.test.ts",
    "--jq", ".content",
  ], { encoding: "utf8" });
  const decoded = Buffer.from(body.trim(), "base64").toString("utf8");
  writeFileSync(join(WORK, "parse.test.ts.orig"), decoded);
  return decoded;
}

// === Step 4: rewrite to vanilla JS (strip TS, swap vitest → our shim) ===
function rewriteTestFile(src) {
  // Rewrite imports so they find OUR src-js
  src = src.replace(
    /from\s+["']\.\.\/src-js\/index\.js["']/g,
    () => `from ${JSON.stringify(pathToFileURL(join(WORK, "src-js", "index.js")).href)}`
  );
  // Replace vitest with our shim
  src = src.replace(
    /from\s+["']vitest["']/g,
    () => `from ${JSON.stringify(pathToFileURL(join(__dirname, "vitest_shim.mjs")).href)}`
  );
  // Strip `import type { ... }` blocks
  src = src.replace(/import type[^;]*;\n?/g, "");
  // Strip `as X` casts: `(foo as Bar).baz` → `(foo).baz`
  src = src.replace(/ as [A-Za-z][A-Za-z0-9_]*(\[[^\]]*\])?/g, "");
  // Strip type annotations on `const`/`let` destructuring
  src = src.replace(/const\s+(\w+)\s*:\s*[^=]+=/g, "const $1 =");
  // Strip type-only parameter annotations (very rough)
  src = src.replace(/:\s*ParserOptions\["lang"\]\[\]/g, "");
  // Worker import — replace with a stub that throws, and rewrite the one
  // worker test to use `it.skip` instead of `it`. We're not testing the
  // worker spawn path here.
  src = src.replace(
    /import\s+{\s*Worker\s*}\s+from\s+["']node:worker_threads["'];?\n?/g,
    "const Worker = class { constructor() { throw new Error('Worker skipped in wasmkernel runner'); } };\n"
  );
  src = src.replace(/describe\("worker"/, 'describe.skip("worker"');
  writeFileSync(join(WORK, "parse.test.mjs"), src);
  return join(WORK, "parse.test.mjs");
}

// === Step 5: minimal vitest shim ===
function writeVitestShim() {
  const shimPath = join(__dirname, "vitest_shim.mjs");
  writeFileSync(shimPath, `/* Minimal vitest compat: describe/it/test/test.each/expect */
const stats = { passed: 0, failed: 0, skipped: 0, failures: [] };
const path = [];
export function describe(name, fn) {
  path.push(name);
  try { fn(); }
  catch (e) { console.error("  describe(" + name + ") threw:", e?.message || e); }
  path.pop();
}
describe.skip = (name) => { console.log("  SKIP describe(" + name + ")"); stats.skipped++; };
async function runTest(name, fn) {
  const label = [...path, name].join(" > ");
  try {
    await fn();
    console.log("  PASS " + label);
    stats.passed++;
  } catch (e) {
    console.error("  FAIL " + label + ": " + (e?.message || e));
    stats.failures.push({ label, message: e?.message || String(e) });
    stats.failed++;
  }
}
export function it(name, fn) { return runTest(name, fn); }
export function test(name, fn) { return runTest(name, fn); }
it.each = (table) => (name, fn) => {
  for (const row of table) {
    const rendered = name.replace("%s", String(row));
    runTest(rendered, () => fn(row));
  }
};
test.each = it.each;
it.skip = (name) => { console.log("  SKIP " + name); stats.skipped++; };
test.skip = it.skip;

// expect() — implement the subset the oxc-parser test file uses
import { deepStrictEqual, strictEqual, ok } from "assert";
export function expect(actual) {
  return {
    toBe(expected) { strictEqual(actual, expected); },
    toEqual(expected) { deepStrictEqual(actual, expected); },
    toStrictEqual(expected) { deepStrictEqual(actual, expected); },
    toBeDefined() { ok(actual !== undefined, "expected defined, got undefined"); },
    toBeUndefined() { strictEqual(actual, undefined); },
    toBeNull() { strictEqual(actual, null); },
    toBeTruthy() { ok(actual, "expected truthy, got " + actual); },
    toBeFalsy() { ok(!actual, "expected falsy, got " + actual); },
    toContain(x) { ok(actual.includes(x), "expected to contain " + x); },
    toThrow() {
      try { actual(); throw new Error("did not throw"); }
      catch (e) { if (e?.message === "did not throw") throw e; }
    },
    toHaveLength(n) { strictEqual(actual?.length, n); },
  };
}

export function getStats() { return stats; }
`);
}

// === main ===
async function main() {
  fetchOxcSources();
  writeBindingsShim();
  writeVitestShim();
  const rawTestSrc = fetchUpstreamTest();
  const testPath = rewriteTestFile(rawTestSrc);

  console.log("\n[run] importing", testPath, "\n");
  await import(pathToFileURL(testPath).href);

  // Give async its() callbacks a tick to settle
  await new Promise((r) => setImmediate(r));

  const { getStats } = await import(pathToFileURL(join(__dirname, "vitest_shim.mjs")).href);
  const s = getStats();
  console.log(`\n${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`);
  process.exit(s.failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("runner error:", e); process.exit(2); });
