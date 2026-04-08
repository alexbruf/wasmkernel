#!/usr/bin/env node
/**
 * Smoke test the real published oxc-parser wasm binary through wasmkernel.
 *
 * This is the CI-stable subset — just enough to catch "the module no
 * longer loads" regressions. Deep AST testing lives in the one-shot
 * runner tests/ext/run_oxc_parser_upstream.mjs which fetches and runs
 * oxc-parser's actual upstream test suite.
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadNapiRs } from "./napi_rs_loader.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KERNEL = join(__dirname, "..", "..", "build", "wasmkernel.wasm");
const GUEST = join(__dirname, "..", "emnapi", "wasm", "oxc_parser.wasm");

const { exports: oxc } = await loadNapiRs(KERNEL, GUEST);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}: ${e?.message || e}`); failed++; }
}

test("module loaded", () => {
  if (!oxc.parseSync) throw new Error("parseSync missing");
  if (!oxc.ParseResult) throw new Error("ParseResult missing");
  if (!oxc.Severity) throw new Error("Severity missing");
});

test("Severity enum populated", () => {
  if (oxc.Severity.Error === undefined) throw new Error("Severity.Error missing");
  if (oxc.Severity.Warning === undefined) throw new Error("Severity.Warning missing");
});

test("rawTransferSupported returns boolean", () => {
  const r = oxc.rawTransferSupported();
  if (typeof r !== "boolean") throw new Error("expected boolean, got " + typeof r);
});

test("parseSync on simple expression", () => {
  const r = oxc.parseSync("test.js", "const x = 1 + 2;");
  const { node } = JSON.parse(r.program);
  if (node.type !== "Program") throw new Error("type");
  if (node.body[0].type !== "VariableDeclaration") throw new Error("body[0].type");
  if (node.body[0].declarations[0].id.name !== "x") throw new Error("name");
});

test("parseSync on TypeScript", () => {
  const src = `interface User { id: number; name: string }\nexport function greet(u: User): string { return 'Hello, ' + u.name; }`;
  const r = oxc.parseSync("test.ts", src);
  const { node } = JSON.parse(r.program);
  if (node.body.length !== 2) throw new Error("body.length");
});

test("parseSync lang=ts on .vue file", () => {
  const r = oxc.parseSync("test.vue", "/* comment */ foo", { lang: "ts" });
  const { node } = JSON.parse(r.program);
  if (node.body.length !== 1) throw new Error("body.length");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
