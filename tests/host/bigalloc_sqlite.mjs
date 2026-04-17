/**
 * Capacity test with node:sqlite backend. Spills cold pages to a file on
 * disk (or :memory: SQLite). Proves the paging system can address guest
 * memory well beyond Node's own heap because cold pages don't accumulate
 * in JS memory — they live in SQLite.
 *
 * Usage:
 *   node --experimental-sqlite tests/host/bigalloc_sqlite.mjs [hotPages=100]
 *
 * Size comes from the guest binary's default (rebuild via
 * /tmp/build_bigalloc.sh <MB>).
 */
import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";
import sqlite from "node:sqlite";
import { PageCache } from "../../packages/wasmkernel/src/page_cache.js";
import { createSqliteNodeBackend }
  from "../../packages/wasmkernel/src/backends/sqlite_node.js";

const KERNEL = new URL("../../build/wasmkernel.wasm", import.meta.url).pathname;
const GUEST = new URL("../guest/bigalloc.wasm", import.meta.url).pathname;
const PAGE_FAULT_BRIDGE_SLOT = 255;

const hotPages = parseInt(process.argv[2] ?? "100", 10);

// node:sqlite uses slightly different API than better-sqlite3. Adapt it
// to sqlite_node.js's expected shape.
const db = new sqlite.DatabaseSync("/tmp/bigalloc_pages.db");
try { db.exec("DROP TABLE IF EXISTS wk_pages"); db.exec("DROP TABLE IF EXISTS wk_meta"); } catch {}
const dbAdapter = {
  exec(sql) { db.exec(sql); },
  prepare(sql) {
    const stmt = db.prepare(sql);
    return {
      get: (...args) => stmt.get(...args),
      run: (...args) => stmt.run(...args),
    };
  },
};

const backend = createSqliteNodeBackend(dbAdapter);

const kernelBytes = readFileSync(KERNEL);
const guestBytes = readFileSync(GUEST);

const wasi = new WASI({ version: "preview1", args: ["bigalloc"], env: {} });

const pendingIO = new Map();
const bridgeFunctions = new Map();
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
k.kernel_set_hot_window_pages(hotPages);

const ptr = k.kernel_alloc(guestBytes.length);
new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
if (k.kernel_load(ptr, guestBytes.length) !== 0) {
  console.error("kernel_load failed");
  process.exit(1);
}

const pageCache = new PageCache(k, backend, hotPages);
bridgeFunctions.set(PAGE_FAULT_BRIDGE_SLOT, (args) =>
  BigInt(pageCache.onPageFault(args[0] >>> 0)));
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

// fd_write bridge for stdout.
const bridgeCount = k.kernel_bridge_count();
const infoBuf = k.kernel_alloc(256);
for (let i = 0; i < bridgeCount; i++) {
  const len = k.kernel_bridge_info(i, infoBuf, 256);
  if (!len) continue;
  const bytes = new Uint8Array(k.memory.buffer, infoBuf, len);
  const parts = []; let start = 0;
  for (let j = 0; j < len; j++) if (bytes[j] === 0) { parts.push(new TextDecoder().decode(bytes.slice(start, j))); start = j + 1; }
  if (parts[0] !== "wasi_snapshot_preview1") continue;
  if (parts[1] === "fd_write") {
    bridgeFunctions.set(i, (args) => {
      const [fd, iovsPtr, iovsLen, nwrittenPtr] = args;
      const readU32 = (a) => {
        const pg = a >>> 16;
        const po = a & 0xFFFF;
        const pt = new Uint16Array(
          k.memory.buffer, k.kernel_page_table_ptr(), logicalPages);
        let slot = pt[pg];
        if (slot === 0xFFFF) slot = Number(pageCache.onPageFault(pg));
        return new DataView(k.memory.buffer).getUint32(
          k.kernel_hot_window_base() + slot * 65536 + po, true);
      };
      const writeU32 = (a, v) => {
        const pg = a >>> 16;
        const po = a & 0xFFFF;
        const pt = new Uint16Array(
          k.memory.buffer, k.kernel_page_table_ptr(), logicalPages);
        let slot = pt[pg];
        if (slot === 0xFFFF) slot = Number(pageCache.onPageFault(pg));
        new DataView(k.memory.buffer).setUint32(
          k.kernel_hot_window_base() + slot * 65536 + po, v, true);
      };
      const readBytes = (a, n) => {
        const out = new Uint8Array(n);
        let off = 0;
        while (off < n) {
          const pg = (a + off) >>> 16;
          const po = (a + off) & 0xFFFF;
          const chunk = Math.min(n - off, 65536 - po);
          const pt = new Uint16Array(
            k.memory.buffer, k.kernel_page_table_ptr(), logicalPages);
          let slot = pt[pg];
          if (slot === 0xFFFF) slot = Number(pageCache.onPageFault(pg));
          out.set(new Uint8Array(
            k.memory.buffer,
            k.kernel_hot_window_base() + slot * 65536 + po,
            chunk), off);
          off += chunk;
        }
        return out;
      };
      let total = 0;
      for (let j = 0; j < iovsLen; j++) {
        const bufPtr = readU32(iovsPtr + j * 8);
        const blen = readU32(iovsPtr + j * 8 + 4);
        const text = new TextDecoder().decode(readBytes(bufPtr, blen));
        if (fd === 1) process.stdout.write(text);
        else if (fd === 2) process.stderr.write(text);
        total += blen;
      }
      writeU32(nwrittenPtr, total);
      return 0n;
    });
  }
}

const baseRss = process.memoryUsage().rss;
const t0 = Date.now();

let status = 0;
while (status === 0) status = k.kernel_step();

const runMs = Date.now() - t0;
const peakRss = process.memoryUsage().rss;
const exitCode = k.kernel_exit_code();
const touched = pageCache.uniqueTouchedPages;
const evictions = pageCache.evictions ?? 0;

const dbSize = (() => {
  try { const { size } = require('node:fs').statSync("/tmp/bigalloc_pages.db"); return size; } catch { return 0; }
})();

process.stderr.write(
  `\n[bigalloc_sqlite] exit=${exitCode} status=${status} runMs=${runMs}\n` +
  `  hotPages=${hotPages} (${(hotPages * 64 / 1024).toFixed(1)} MB physical)\n` +
  `  touched=${touched} unique pages (${(touched * 64 / 1024).toFixed(1)} MB logical)\n` +
  `  evictions=${evictions}\n` +
  `  rss delta=${((peakRss - baseRss) / 1048576).toFixed(1)} MB\n` +
  `  sqlite file size=${(dbSize / 1048576).toFixed(1)} MB\n`);

process.exit(exitCode);
