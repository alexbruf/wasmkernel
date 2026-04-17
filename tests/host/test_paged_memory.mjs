/**
 * Integration test: paged guest memory with an in-memory backend.
 *
 * Runs alloc.wasm directly against wasmkernel (bypassing the NAPI
 * harness — this is a pure-WASI guest). Exercises the
 * CHECK_MEMORY_OVERFLOW macro + host_page_fault bridge round-trip.
 *
 *   1. Identity mode: no backend, hot window == logical memory.
 *   2. Paged mode:   32-page hot window + in-memory backend. Reads and
 *      writes beyond the hot window force the kernel to call into JS
 *      via the bridge, evict cold pages, and fetch the needed ones.
 */

import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";
import { PageCache } from "../../packages/wasmkernel/src/page_cache.js";
import { createInMemoryBackend } from "../../packages/wasmkernel/src/memory_backend.js";

const KERNEL = new URL("../../build/wasmkernel.wasm", import.meta.url).pathname;
const GUEST = new URL("../guest/alloc.wasm", import.meta.url).pathname;
const PAGE_FAULT_BRIDGE_SLOT = 255;

const kernelBytes = readFileSync(KERNEL);
const guestBytes = readFileSync(GUEST);

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { console.log(`PASS  ${name}`); passed++; }
  else { console.log(`FAIL  ${name}`); failed++; }
}

async function runOnce(label, pagingOpts) {
  const pendingIO = new Map();
  const bridgeFunctions = new Map();
  let stdout = "";
  let k;

  const wasi = new WASI({ version: "preview1", args: [], env: {} });

  const hostImports = {
    host_func_call(funcIdx, argsPtr, argc) {
      const handler = bridgeFunctions.get(funcIdx);
      if (!handler) return 0n;
      const args = [];
      for (let i = 0; i < argc; i++)
        args.push(new DataView(k.memory.buffer).getUint32(argsPtr + i * 8, true));
      const r = handler(args, argsPtr);
      return typeof r === "bigint" ? r : BigInt(r ?? 0);
    },
    host_io_submit(cb) { pendingIO.set(cb, { bytes: 0, error: 0 }); },
    host_io_check(cb) { return pendingIO.has(cb) ? 1 : 0; },
    host_io_result_bytes(cb) { return pendingIO.get(cb)?.bytes ?? 0; },
    host_io_result_error(cb) {
      const r = pendingIO.get(cb);
      if (r) pendingIO.delete(cb);
      return r?.error ?? 8;
    },
  };

  const compiled = await WebAssembly.compile(kernelBytes);
  const instance = await WebAssembly.instantiate(compiled, {
    wasi_snapshot_preview1: wasi.wasiImport,
    host: hostImports,
  });
  wasi.initialize(instance);
  k = instance.exports;
  k.kernel_init();

  // Enable paging BEFORE kernel_load if the test asks for it.
  if (pagingOpts.hotWindowPages && k.kernel_set_hot_window_pages)
    k.kernel_set_hot_window_pages(pagingOpts.hotWindowPages);

  const ptr = k.kernel_alloc(guestBytes.length);
  new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
  if (k.kernel_load(ptr, guestBytes.length) !== 0)
    throw new Error(`${label}: kernel_load failed`);

  // Wire paging post-load: construct PageCache, register bridge slot,
  // seed backend from WAMR's memory_data.
  let pageCache = null;
  if (pagingOpts.hotWindowPages && pagingOpts.backend) {
    pageCache = new PageCache(k, pagingOpts.backend, pagingOpts.hotWindowPages);
    bridgeFunctions.set(PAGE_FAULT_BRIDGE_SLOT, (args) => {
      const slot = pageCache.onPageFault(args[0] >>> 0);
      return BigInt(slot);
    });
    k.kernel_register_page_fault_slot(PAGE_FAULT_BRIDGE_SLOT);

    // Seed backend from WAMR memory_data.
    const logicalPages = k.kernel_logical_page_count();
    if (pagingOpts.backend.sizePages() < logicalPages) {
      pagingOpts.backend.growPages(logicalPages - pagingOpts.backend.sizePages());
    }
    const scratch = new Uint8Array(65536);
    for (let pg = 0; pg < logicalPages; pg++) {
      const srcPtr = k.kernel_memory_data_page_ptr(pg);
      if (!srcPtr) continue;
      scratch.set(new Uint8Array(k.memory.buffer, srcPtr, 65536));
      pagingOpts.backend.writePage(pg, scratch);
    }
  }

  // Wire fd_write for stdout capture (bridge slot 0 is the guest's fd_write).
  const bridgeCount = k.kernel_bridge_count();
  const infoBuf = k.kernel_alloc(256);
  for (let i = 0; i < bridgeCount; i++) {
    const len = k.kernel_bridge_info(i, infoBuf, 256);
    if (!len) continue;
    const bytes = new Uint8Array(k.memory.buffer, infoBuf, len);
    const parts = []; let start = 0;
    for (let j = 0; j < len; j++) {
      if (bytes[j] === 0) {
        parts.push(new TextDecoder().decode(bytes.slice(start, j)));
        start = j + 1;
      }
    }
    const [mod, field] = parts;
    if (mod === "wasi_snapshot_preview1" && field === "fd_write") {
      bridgeFunctions.set(i, (args) => {
        const [fd, iovsPtr, iovsLen, nwrittenPtr] = args;
        const base = k.kernel_guest_memory_base
          ? k.kernel_guest_memory_base()
          : 0;
        const dv = new DataView(k.memory.buffer);
        let total = 0;
        for (let j = 0; j < iovsLen; j++) {
          const bufPtr = dv.getUint32(base + iovsPtr + j * 8, true);
          const blen = dv.getUint32(base + iovsPtr + j * 8 + 4, true);
          // In paged mode, the guest's data is in the hot window at the
          // resident slot. We need to translate via the page table. For a
          // write to stdout after printf, the relevant page should already
          // be resident (the printf buffer was just written by the guest).
          // For this test's single-page access pattern, direct-read works
          // in identity mode; in paged mode, we look up the slot.
          let phys;
          if (k.kernel_hot_window_base && pagingOpts.hotWindowPages) {
            const hotBase = k.kernel_hot_window_base();
            const pt = new Uint16Array(
              k.memory.buffer,
              k.kernel_page_table_ptr(),
              k.kernel_logical_page_count());
            const pg = bufPtr >>> 16;
            const po = bufPtr & 0xFFFF;
            let slot = pt[pg];
            if (slot === 0xFFFF) {
              slot = Number(pageCache.onPageFault(pg));
            }
            phys = hotBase + slot * 65536 + po;
          } else {
            phys = base + bufPtr;
          }
          const chunk = new Uint8Array(k.memory.buffer, phys, blen);
          stdout += new TextDecoder().decode(chunk);
          total += blen;
        }
        dv.setUint32(base + nwrittenPtr, total, true);
        return 0n;
      });
    }
  }

  let status = 0;
  while (status === 0) status = k.kernel_step();
  return { stdout, exitCode: k.kernel_exit_code(), status };
}

console.log("\n=== Identity mode ===");
try {
  const r = await runOnce("identity", {});
  check("identity: exit 0", r.exitCode === 0);
} catch (e) {
  console.log("FAIL  identity run:", e.stack); failed++;
}

// Large hot window (>= logical) — paging is active but should never
// fault a resident page out. This isolates the "seed + fault-in" path
// from eviction logic.
console.log("\n=== Paged mode LARGE (128-page hot window) ===");
try {
  const backend = createInMemoryBackend(0);
  const r = await runOnce("paged_large", { hotWindowPages: 128, backend });
  check("paged_large: exit 0", r.exitCode === 0);
} catch (e) {
  console.log("FAIL  paged_large run:", e.stack); failed++;
}

console.log("\n=== Paged mode TIGHT (4-page hot window, forces eviction) ===");
try {
  const backend = createInMemoryBackend(0);
  const r = await runOnce("paged_tight", { hotWindowPages: 4, backend });
  check("paged_tight: exit 0", r.exitCode === 0);
} catch (e) {
  console.log("FAIL  paged_tight run:", e.stack); failed++;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
