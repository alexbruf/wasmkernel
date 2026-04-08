// Repro: oxc-parser parseSync in a loop until JSON.parse fails.
// Bisect by iteration count to find which call returns malformed JSON.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadNapiRs } from "../host/napi_rs_loader.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const { exports: oxc } = await loadNapiRs(
  resolve(ROOT, "build", "wasmkernel.wasm"),
  resolve(ROOT, "tests", "emnapi", "wasm", "oxc_parser.wasm")
);

for (let i = 0; i < 5000; i++) {
  const r = oxc.parseSync(`f${i}.js`, `const x${i} = ${i};`);
  const prog = r.program;
  try {
    JSON.parse(prog);
  } catch (e) {
    console.log(`FAIL at iter ${i}: ${e.message}`);
    console.log(`prog length: ${prog?.length}`);
    console.log(`prog (full): ${JSON.stringify(prog)}`);
    process.exit(1);
  }
  if (i % 500 === 0) console.log(`iter ${i} ok, len=${prog.length}`);
}
console.log("DONE — no corruption in 5000 iters");
