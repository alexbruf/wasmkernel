/**
 * Verify entry-browser.js (re-exported by entry-worker.js) actually wires
 * paged memory. Runs in Node but uses the worker path by supplying
 * kernelModule explicitly so the fetch-based kernel loader is bypassed.
 *
 * Exits non-zero if paging didn't activate when memoryBackend + hotWindowPages
 * were provided.
 */

import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";
import { instantiateNapiModule } from "../../packages/wasmkernel/src/entry-browser.js";
import { createInMemoryBackend } from "../../packages/wasmkernel/src/memory_backend.js";

const KERNEL = new URL("../../build/wasmkernel.wasm", import.meta.url).pathname;
const GUEST = new URL(
  "../emnapi/wasm/oxc_parser.wasm",
  import.meta.url).pathname;

const kernelBytes = readFileSync(KERNEL);
const guestBytes = readFileSync(GUEST);
const kernelModule = await WebAssembly.compile(kernelBytes);

const backend = createInMemoryBackend(0);
let readCount = 0;
let writeCount = 0;
const trackedBackend = {
  sizePages() { return backend.sizePages(); },
  growPages(d) { return backend.growPages(d); },
  readPage(i, dst) { readCount++; return backend.readPage(i, dst); },
  writePage(i, src) { writeCount++; return backend.writePage(i, src); },
};

const wasi = new WASI({ version: "preview1", args: [], env: {} });
const { napiModule, kernel } = await instantiateNapiModule(guestBytes, {
  wasi,
  kernelModule,
  memoryBackend: trackedBackend,
  hotWindowPages: 100,
  minInitialPages: 0,
});

const logicalPages = kernel.kernel_logical_page_count();
console.log(`logical pages: ${logicalPages}`);
console.log(`backend writes after seed: ${writeCount}`);

if (writeCount === 0) {
  console.error("FAIL: no pages seeded — paging didn't activate");
  process.exit(1);
}

// Trigger a parse to exercise the fault path.
const before = { r: readCount, w: writeCount };
const r = napiModule.exports.parseSync("x.ts", "const x: number = 1 + 2;");
console.log(`after parseSync: reads=${readCount - before.r} writes=${writeCount - before.w}`);
const prog = r?.program;  // cache — it's a napi getter that re-reads on each access
if (!prog) {
  console.error("FAIL: parseSync returned no .program");
  process.exit(1);
}
console.log(`program len: ${prog.length}`);
const ok = JSON.parse(prog);
if (ok?.node?.type !== "Program") {
  console.error(`FAIL: expected Program, got ${ok?.node?.type}`);
  process.exit(1);
}
console.log(`body[0].type: ${ok.node.body[0]?.type}`);

console.log("PASS: worker-entry paged memory active, parseSync works");
