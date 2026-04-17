/**
 * Measure RSS when loading + using Rolldown through wasmkernel.
 *
 * The feature request (wasmkernel-feature-sqlite-memory.md) cited "~100 MB
 * of external memory" for a stock Rolldown instantiation. This script
 * verifies the post-tuning state: after the os_mmap memset fix and the
 * app_heap_size=0 default, how much RSS does rolldown actually use?
 *
 * Goal: peak RSS delta < 50 MB for load + a small transform() call.
 */

import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";
import { instantiateNapiModule } from "../../packages/wasmkernel/src/instantiate.js";

const KERNEL = new URL("../../build/wasmkernel.wasm", import.meta.url).pathname;
const ROLLDOWN = new URL(
  "../pkgs/rolldown/package/rolldown-binding.wasm32-wasi.wasm",
  import.meta.url).pathname;

const kernelBytes = readFileSync(KERNEL);
const guestBytes = readFileSync(ROLLDOWN);

function snap(label) {
  const m = process.memoryUsage();
  console.log(
    `[${label.padEnd(18)}]  rss=${(m.rss / 1048576).toFixed(1)} MB ` +
    `ext=${(m.external / 1048576).toFixed(1)} MB ` +
    `heap=${(m.heapUsed / 1048576).toFixed(1)} MB`);
  return m;
}

const base = snap("baseline");

const wasi = new WASI({ version: "preview1", args: [], env: {} });
const { napiModule } = await instantiateNapiModule(kernelBytes, guestBytes, {
  wasi,
  // Let rolldown use its declared initial (~1004 pages) rather than the
  // oxc-parser-specific 4000 bump. Saves ~180 MB virtual, and post-init
  // V8 only commits touched pages anyway.
  minInitialPages: 0,
});

const afterLoad = snap("after load");

// Try a small transform() to exercise real working set.
let transformResult = null;
try {
  if (typeof napiModule.exports.transform === "function") {
    transformResult = await napiModule.exports.transform(
      "const x = 1 + 2;\nexport default x;",
      {}
    );
  } else if (typeof napiModule.exports.parseSync === "function") {
    transformResult = napiModule.exports.parseSync("const x = 1;", {});
  }
} catch (e) {
  console.log(`  transform error: ${e.message}`);
}

const afterRun = snap("after transform");

console.log();
console.log(`Deltas (vs baseline):`);
console.log(`  after load:       ` +
  `rss=+${((afterLoad.rss - base.rss) / 1048576).toFixed(1)} MB, ` +
  `ext=+${((afterLoad.external - base.external) / 1048576).toFixed(1)} MB`);
console.log(`  after transform:  ` +
  `rss=+${((afterRun.rss - base.rss) / 1048576).toFixed(1)} MB, ` +
  `ext=+${((afterRun.external - base.external) / 1048576).toFixed(1)} MB`);
console.log();
console.log(`transform() returned: ${
  transformResult
    ? JSON.stringify(transformResult).slice(0, 80)
    : "(no result)"}`);
