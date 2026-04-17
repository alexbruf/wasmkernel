/**
 * Measure RSS for multiple guests through wasmkernel with current tuning.
 * Reports delta (vs Node baseline) after load + after one real parse/call.
 */

import { readFileSync, existsSync } from "node:fs";
import { WASI } from "node:wasi";
import { instantiateNapiModule } from "../../packages/wasmkernel/src/instantiate.js";
import { createInMemoryBackend } from "../../packages/wasmkernel/src/memory_backend.js";

const KERNEL = new URL("../../build/wasmkernel.wasm", import.meta.url).pathname;
const kernelBytes = readFileSync(KERNEL);

async function measure(label, guestPath, runFn, opts = {}) {
  if (!existsSync(guestPath)) { console.log(`SKIP ${label}: ${guestPath} not found`); return; }
  const guestBytes = readFileSync(guestPath);

  // Node's memoryUsage after GC for a stable baseline. Run in a fresh
  // subprocess to reset the baseline — or just measure deltas within
  // this process and accept cumulative bleed.
  const base = process.memoryUsage();

  const wasi = new WASI({ version: "preview1", args: [], env: {} });
  let napiModule;
  const extraOpts = {};
  if (process.env.PAGED) {
    extraOpts.memoryBackend = createInMemoryBackend(0);
    extraOpts.hotWindowPages = parseInt(process.env.PAGED, 10) || 800;
  }
  try {
    const r = await instantiateNapiModule(kernelBytes, guestBytes, {
      wasi, minInitialPages: 0, ...extraOpts, ...opts,
    });
    napiModule = r.napiModule;
  } catch (e) {
    console.log(`  ${label}: load failed — ${e.message}`);
    return;
  }

  const loaded = process.memoryUsage();

  let ran = loaded;
  if (runFn && napiModule) {
    try { runFn(napiModule); ran = process.memoryUsage(); }
    catch (e) { console.log(`  ${label}: run error — ${e.message}`); }
  }

  const d = (m, a, b) => ((a[m] - b[m]) / 1048576).toFixed(1);
  console.log(
    `${label.padEnd(30)} ` +
    `load: rss+${d("rss", loaded, base)} ext+${d("external", loaded, base)} | ` +
    `after run: rss+${d("rss", ran, base)} ext+${d("external", ran, base)}`);
}

console.log(`Node baseline rss=${(process.memoryUsage().rss / 1048576).toFixed(1)} MB\n`);

// Select guest via env var so each can be measured in its own process
const target = process.env.GUEST || "oxc";
const targets = {
  oxc: [
    "oxc-parser (1.7MB)",
    new URL("../pkgs/oxc/package/parser.wasm32-wasi.wasm", import.meta.url).pathname,
    (m) => m.exports.parseSync?.("a.ts", "const x: number = 1 + 2;", {}),
  ],
  argon2: [
    "argon2 (193KB)",
    new URL("../pkgs/package/argon2.wasm32-wasi.wasm", import.meta.url).pathname,
    (m) => m.exports.hashSync?.("hello", { memoryCost: 128, timeCost: 1, parallelism: 1 }),
  ],
  rolldown: [
    "rolldown (12MB)",
    new URL("../pkgs/rolldown/package/rolldown-binding.wasm32-wasi.wasm", import.meta.url).pathname,
    null,  // just load — transform() needs full rolldown JS wrapper
  ],
};
const [label, path, fn] = targets[target];
await measure(label, path, fn);
