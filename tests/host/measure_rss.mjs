/**
 * Measure committed memory (external = WebAssembly.Memory allocations)
 * after loading a guest. Baseline for CF-compat tuning.
 */

import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";

const KERNEL = new URL("../../build/wasmkernel.wasm", import.meta.url).pathname;
const kernelBytes = readFileSync(KERNEL);

async function loadAndMeasure(guestPath, label, opts = {}) {
  const guestBytes = readFileSync(guestPath);

  const pendingIO = new Map();
  const bridgeFunctions = new Map();
  const wasi = new WASI({ version: "preview1", args: [], env: {} });
  let k;

  const hostImports = {
    host_func_call(funcIdx, argsPtr, argc) {
      const handler = bridgeFunctions.get(funcIdx);
      if (!handler) return 0n;
      const args = [];
      for (let i = 0; i < argc; i++)
        args.push(new DataView(k.memory.buffer).getUint32(argsPtr + i * 8, true));
      try { return handler(args, argsPtr); }
      catch { return 0n; }
    },
    host_io_submit() {},
    host_io_check() { return 0; },
    host_io_result_bytes() { return 0; },
    host_io_result_error() { return 8; },
  };

  const compiled = await WebAssembly.compile(kernelBytes);
  const instance = await WebAssembly.instantiate(compiled, {
    wasi_snapshot_preview1: wasi.wasiImport,
    host: hostImports,
  });
  wasi.initialize(instance);
  k = instance.exports;
  k.kernel_init();

  if (opts.minInitialPages && k.kernel_set_min_initial_pages)
    k.kernel_set_min_initial_pages(opts.minInitialPages);
  if (opts.appHeapSize != null && k.kernel_set_app_heap_size)
    k.kernel_set_app_heap_size(opts.appHeapSize);

  const rssBefore = process.memoryUsage();

  const ptr = k.kernel_alloc(guestBytes.length);
  new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
  const r = k.kernel_load(ptr, guestBytes.length);

  const rssAfter = process.memoryUsage();

  const kernelPages = k.memory.buffer.byteLength / 65536;
  const logicalPages = k.kernel_logical_page_count
    ? k.kernel_logical_page_count() : -1;

  console.log(`\n${label}`);
  console.log(`  load result:        ${r}`);
  console.log(`  kernel pages:       ${kernelPages} (${(kernelPages * 64 / 1024).toFixed(1)} MB)`);
  console.log(`  guest logical pgs:  ${logicalPages} (${(logicalPages * 64 / 1024).toFixed(1)} MB)`);
  console.log(`  RSS delta (rss):    ${((rssAfter.rss - rssBefore.rss) / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  RSS delta (heap):   ${((rssAfter.heapUsed - rssBefore.heapUsed) / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  RSS delta (ext):    ${((rssAfter.external - rssBefore.external) / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  RSS delta (ab):     ${((rssAfter.arrayBuffers - rssBefore.arrayBuffers) / 1024 / 1024).toFixed(1)} MB`);
}

// Small guest (declares 2 pages)
await loadAndMeasure(
  new URL("../guest/alloc.wasm", import.meta.url).pathname,
  "alloc.wasm (2-page guest, default init)");

// Force guest initial to 1004 pages (Rolldown-equivalent)
await loadAndMeasure(
  new URL("../guest/alloc.wasm", import.meta.url).pathname,
  "alloc.wasm forced to 1004 init pages (Rolldown-equivalent)",
  { minInitialPages: 1004 });

// Force guest initial to 4000 pages (emnapi default)
await loadAndMeasure(
  new URL("../guest/alloc.wasm", import.meta.url).pathname,
  "alloc.wasm forced to 4000 init pages (emnapi default)",
  { minInitialPages: 4000 });

// Same, but with app_heap_size = 0 (skip WAMR's 64 MB auxiliary heap).
await loadAndMeasure(
  new URL("../guest/alloc.wasm", import.meta.url).pathname,
  "alloc.wasm @1004 init, NO app heap",
  { minInitialPages: 1004, appHeapSize: 0 });

await loadAndMeasure(
  new URL("../guest/alloc.wasm", import.meta.url).pathname,
  "alloc.wasm @4000 init, NO app heap",
  { minInitialPages: 4000, appHeapSize: 0 });
