#!/usr/bin/env node
/**
 * Node example: load the published @oxc-parser wasm32-wasi binary through
 * @alexbruf/wasmkernel and parse a JavaScript snippet.
 *
 * Run from this directory:
 *   node parse.mjs                       # parses a built-in snippet
 *   node parse.mjs path/to/file.js       # parses a file you point at
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadNapiRs } from "@alexbruf/wasmkernel/node";

const __dirname = dirname(fileURLToPath(import.meta.url));

// We use the published oxc-parser wasm that ships in this repo's tests so
// the example runs without a network fetch. In a real project you'd point
// at the wasm file shipped by your installed `@oxc-parser/binding-wasm32-wasi`.
const OXC_WASM = resolve(
  __dirname,
  "..",
  "..",
  "tests",
  "pkgs",
  "oxc",
  "package",
  "parser.wasm32-wasi.wasm"
);

async function main() {
  console.log(`Loading oxc-parser via @alexbruf/wasmkernel ...`);
  const { exports: oxc } = await loadNapiRs(OXC_WASM);
  console.log(`  ready (exports: ${Object.keys(oxc).filter(k => !k.startsWith("_")).sort().join(", ")})`);

  const filename = process.argv[2];
  let source, label;
  if (filename) {
    source = readFileSync(filename, "utf8");
    label = filename;
  } else {
    label = "<inline>";
    source = `
      const greet = (name) => \`hello, \${name}!\`;
      class Counter {
        #n = 0;
        bump() { return ++this.#n; }
      }
      export default greet(new Counter().bump() + "");
    `;
  }

  console.log(`\nParsing ${label} (${source.length} chars) ...`);
  const t0 = process.hrtime.bigint();
  const result = oxc.parseSync(label, source);
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;

  const { node } = JSON.parse(result.program);
  console.log(`  done in ${elapsed.toFixed(2)} ms`);
  console.log(`  ${node.body.length} top-level statements:`);
  for (const stmt of node.body) {
    const detail = stmt.kind ?? stmt.declaration?.type ?? "";
    console.log(`    - ${stmt.type}${detail ? ` (${detail})` : ""}`);
  }
  if (result.errors?.length) {
    console.log(`\n  ${result.errors.length} parse errors:`);
    for (const e of result.errors.slice(0, 5)) console.log(`    - ${e.message}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
