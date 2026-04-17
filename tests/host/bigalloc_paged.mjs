/**
 * Capacity test: run tests/guest/bigalloc.wasm under paged memory with
 * a small hot window. Measures whether the paging layer correctly
 * serves GB-scale logical memory and at what throughput.
 *
 * Usage:
 *   node tests/host/bigalloc_paged.mjs [sizeMB=512] [hotPages=100]
 */
import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";
import { PageCache } from "../../packages/wasmkernel/src/page_cache.js";
import { createInMemoryBackend }
  from "../../packages/wasmkernel/src/memory_backend.js";

const KERNEL = new URL("../../build/wasmkernel.wasm", import.meta.url).pathname;
const GUEST = new URL("../guest/bigalloc.wasm", import.meta.url).pathname;
const PAGE_FAULT_BRIDGE_SLOT = 255;

const sizeMB = parseInt(process.argv[2] ?? "512", 10);
const hotPages = parseInt(process.argv[3] ?? "100", 10);

const kernelBytes = readFileSync(KERNEL);
const guestBytes = readFileSync(GUEST);

const wasi = new WASI({
  version: "preview1",
  args: ["bigalloc", String(sizeMB)],
  env: {},
});

const pendingIO = new Map();
const bridgeFunctions = new Map();
let stdout = "";
let k;

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

// Enable paging.
k.kernel_set_hot_window_pages(hotPages);

// Load guest.
const ptr = k.kernel_alloc(guestBytes.length);
new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
if (k.kernel_load(ptr, guestBytes.length) !== 0) {
  console.error("kernel_load failed");
  process.exit(1);
}

// Wire paging.
const backend = createInMemoryBackend(0);
const pageCache = new PageCache(k, backend, hotPages);
bridgeFunctions.set(PAGE_FAULT_BRIDGE_SLOT, (args) => {
  return BigInt(pageCache.onPageFault(args[0] >>> 0));
});
k.kernel_register_page_fault_slot(PAGE_FAULT_BRIDGE_SLOT);

// Seed backend from memory_data.
const logicalPages = k.kernel_logical_page_count();
backend.growPages(logicalPages);
const scratch = new Uint8Array(65536);
for (let pg = 0; pg < logicalPages; pg++) {
  const srcPtr = k.kernel_memory_data_page_ptr(pg);
  if (!srcPtr) continue;
  scratch.set(new Uint8Array(k.memory.buffer, srcPtr, 65536));
  backend.writePage(pg, scratch);
}

// Wire WASI bridges we need: fd_write for stdout, args_get/sizes_get for argv.
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
  if (mod !== "wasi_snapshot_preview1") continue;

  // Translate a guest address to a physical offset by faulting the page
  // in if needed. In paged mode the hot window isn't contiguous with
  // memory_data at logical offsets beyond hot_window_pages.
  const toPhys = (guestPtr) => {
    const pg = guestPtr >>> 16;
    const po = guestPtr & 0xFFFF;
    const pt = new Uint16Array(
      k.memory.buffer,
      k.kernel_page_table_ptr(),
      logicalPages);
    let slot = pt[pg];
    if (slot === 0xFFFF) slot = Number(pageCache.onPageFault(pg));
    return k.kernel_hot_window_base() + slot * 65536 + po;
  };

  if (field === "fd_write") {
    bridgeFunctions.set(i, (args) => {
      const [fd, iovsPtr, iovsLen, nwrittenPtr] = args;
      const dv = () => new DataView(k.memory.buffer);
      let total = 0;
      for (let j = 0; j < iovsLen; j++) {
        const iovEntry = toPhys(iovsPtr + j * 8);
        const bufPtr = dv().getUint32(iovEntry, true);
        const blen = dv().getUint32(iovEntry + 4, true);
        // Copy the payload out page-by-page so cross-page bufs work.
        const out = new Uint8Array(blen);
        let off = 0;
        while (off < blen) {
          const pg = (bufPtr + off) >>> 16;
          const po = (bufPtr + off) & 0xFFFF;
          const chunk = Math.min(blen - off, 65536 - po);
          const pt = new Uint16Array(
            k.memory.buffer, k.kernel_page_table_ptr(), logicalPages);
          let slot = pt[pg];
          if (slot === 0xFFFF) slot = Number(pageCache.onPageFault(pg));
          const src = new Uint8Array(
            k.memory.buffer,
            k.kernel_hot_window_base() + slot * 65536 + po,
            chunk);
          out.set(src, off);
          off += chunk;
        }
        const text = new TextDecoder().decode(out);
        if (fd === 1) { stdout += text; process.stdout.write(text); }
        else if (fd === 2) process.stderr.write(text);
        total += blen;
      }
      dv().setUint32(toPhys(nwrittenPtr), total, true);
      return 0n;
    });
  }
  else if (field === "args_sizes_get") {
    bridgeFunctions.set(i, (args) => {
      const [argcPtr, argvBufSizePtr] = args;
      const argv = wasi.args ?? ["bigalloc", String(sizeMB)];
      let bufSize = 0;
      for (const a of argv) bufSize += new TextEncoder().encode(a).length + 1;
      const dv = new DataView(k.memory.buffer);
      dv.setUint32(toPhys(argcPtr), argv.length, true);
      dv.setUint32(toPhys(argvBufSizePtr), bufSize, true);
      return 0n;
    });
  }
  else if (field === "args_get") {
    bridgeFunctions.set(i, (args) => {
      const [argvPtr, argvBufPtr] = args;
      const argv = wasi.args ?? ["bigalloc", String(sizeMB)];
      const dv = new DataView(k.memory.buffer);
      let bufCursor = argvBufPtr;
      for (let j = 0; j < argv.length; j++) {
        dv.setUint32(toPhys(argvPtr + j * 4), bufCursor, true);
        const encoded = new TextEncoder().encode(argv[j] + "\0");
        // Write into guest memory page-by-page.
        let off = 0;
        while (off < encoded.length) {
          const pg = (bufCursor + off) >>> 16;
          const po = (bufCursor + off) & 0xFFFF;
          const chunk = Math.min(encoded.length - off, 65536 - po);
          const pt = new Uint16Array(
            k.memory.buffer, k.kernel_page_table_ptr(), logicalPages);
          let slot = pt[pg];
          if (slot === 0xFFFF) slot = Number(pageCache.onPageFault(pg));
          new Uint8Array(
            k.memory.buffer,
            k.kernel_hot_window_base() + slot * 65536 + po,
            chunk).set(encoded.subarray(off, off + chunk));
          off += chunk;
        }
        bufCursor += encoded.length;
      }
      return 0n;
    });
  }
}

// Override wasi.args so our bridges can reach it (node:wasi doesn't expose it).
wasi.args = ["bigalloc", String(sizeMB)];

const baseRss = process.memoryUsage().rss;
const t0 = Date.now();

let status = 0;
while (status === 0) status = k.kernel_step();

const runMs = Date.now() - t0;
const peakRss = process.memoryUsage().rss;
const touched = pageCache.uniqueTouchedPages;
const evictions = pageCache.evictions ?? 0;
const exitCode = k.kernel_exit_code();

process.stderr.write(
  `\n[bigalloc_paged] exit=${exitCode} status=${status} runMs=${runMs}\n` +
  `  sizeMB=${sizeMB} hotPages=${hotPages} (${(hotPages * 64 / 1024).toFixed(1)} MB physical)\n` +
  `  touched=${touched} unique pages (${(touched * 64 / 1024).toFixed(1)} MB logical)\n` +
  `  evictions=${evictions}\n` +
  `  throughput=${runMs > 0 ? (sizeMB * 1000 / runMs).toFixed(1) : "∞"} MB/sec (logical)\n` +
  `  rss delta=${((peakRss - baseRss) / 1048576).toFixed(1)} MB\n`);

process.exit(exitCode);
