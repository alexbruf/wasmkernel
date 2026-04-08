#!/usr/bin/env node
/**
 * Soak test: run oxc-parser parseSync in a loop and watch for unbounded
 * RSS growth. The single test that catches "we forgot to release X"
 * bugs (handles, refs, wraps, async work slots, finalizer-registered
 * objects, scheduler thread slots, etc.).
 *
 * Uses oxc-parser because it's cheap (~0.1 ms/parse) and exercises a
 * ton of the napi surface (handles, class instances with getters,
 * string conversion, napi-rs register pattern). Argon2 would take
 * ~15 minutes for a useful iteration count at default memoryCost.
 *
 * Passes if steady-state RSS growth (after warmup) is below budget.
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadNapiRs } from "./napi_rs_loader.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KERNEL = join(__dirname, "..", "..", "build", "wasmkernel.wasm");
const GUEST = join(__dirname, "..", "emnapi", "wasm", "oxc_parser.wasm");

const ITERS = 10000;
const WARMUP = 500;
const YIELD_EVERY = 200;  // let GC run, like a real async workload would
// Budget intentionally generous: a real leak would show hundreds/thousands
// of MB growth. Anything under ~200 MB is handle retention variance from
// V8 GC timing differences across test-suite runs, not a leak we should
// fail on. The numbers to watch are an order-of-magnitude change. We've
// observed up to ~120 MB on cold GitHub Actions runners; 200 gives
// headroom without making the gate meaningless.
const MAX_GROWTH_MB = 200;

const { exports: oxc } = await loadNapiRs(KERNEL, GUEST);

function rssMB() { return Math.round(process.memoryUsage().rss / 1e6); }

const startRss = rssMB();
let warmupRss = startRss;
const t0 = Date.now();

for (let i = 0; i < ITERS; i++) {
  const r = oxc.parseSync(`f${i}.js`, `const x${i} = ${i * 7 + 3};`);
  // Access program so the getter fires and the full napi roundtrip runs.
  void r.program;
  // Yield to event loop so V8 can GC and our napi_runtime can drain
  // pending finalizers. Real async workloads do this naturally between
  // calls; a tight sync loop would starve GC and grow the ref table.
  if (i % YIELD_EVERY === YIELD_EVERY - 1) {
    await new Promise((res) => setImmediate(res));
  }
  if (i === WARMUP - 1) {
    if (global.gc) global.gc();
    await new Promise((res) => setImmediate(res));
    warmupRss = rssMB();
  }
}

if (global.gc) global.gc();
const endRss = rssMB();
const elapsed = Date.now() - t0;
const growth = endRss - warmupRss;

console.log(`iters=${ITERS} warmup=${WARMUP} time=${elapsed}ms (${((elapsed / ITERS) * 1000).toFixed(0)}μs/iter)`);
console.log(`rss: start=${startRss}MB warmup=${warmupRss}MB end=${endRss}MB`);
console.log(`steady-state growth: ${growth} MB (budget: ${MAX_GROWTH_MB} MB)`);

if (growth > MAX_GROWTH_MB) {
  console.error(`FAIL — steady-state growth ${growth} MB exceeds ${MAX_GROWTH_MB} MB`);
  process.exit(1);
}
console.log("PASS");
