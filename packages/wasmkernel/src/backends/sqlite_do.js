/**
 * SQLite-backed MemoryBackend for Cloudflare Durable Objects.
 *
 * DO's synchronous SQLite API (ctx.storage.sql) is perfect for paged
 * guest memory: reads/writes are sync and typically microsecond-latency,
 * and the 10 GB storage cap is far beyond what any napi guest needs.
 *
 * Schema:
 *   CREATE TABLE wk_pages  (page_id INTEGER PRIMARY KEY, data BLOB);
 *   CREATE TABLE wk_meta   (k TEXT PRIMARY KEY, v INTEGER);
 *
 * Missing pages zero-fill on readPage — matches the contract expected
 * by the kernel's page-fault handler (wasm memory is zero-initialized).
 */

import { PAGE_SIZE } from "../memory_backend.js";

/** Create a MemoryBackend backed by a DO SQL storage API.
 *  @param {any} sql - ctx.storage.sql */
export function createSqliteBackend(sql) {
  // Initialize schema. exec is idempotent with IF NOT EXISTS.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS wk_pages (page_id INTEGER PRIMARY KEY, data BLOB);
    CREATE TABLE IF NOT EXISTS wk_meta  (k TEXT PRIMARY KEY, v INTEGER);
  `);

  const _readSize = () => {
    for (const row of sql.exec(
        "SELECT v FROM wk_meta WHERE k = 'size_pages'"))
      return row.v | 0;
    return 0;
  };

  const _writeSize = (v) => {
    sql.exec(
      "INSERT INTO wk_meta (k, v) VALUES ('size_pages', ?) " +
      "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      v);
  };

  return {
    sizePages() { return _readSize(); },
    growPages(delta) {
      const old = _readSize();
      _writeSize(old + delta);
      return old;
    },
    readPage(pageIdx, dst) {
      for (const row of sql.exec(
          "SELECT data FROM wk_pages WHERE page_id = ?", pageIdx)) {
        // row.data is Uint8Array (or ArrayBuffer in some bindings).
        const src = row.data instanceof Uint8Array
          ? row.data
          : new Uint8Array(row.data);
        if (src.length !== PAGE_SIZE) {
          throw new Error(
            `sqlite backend: page ${pageIdx} has ${src.length} bytes, ` +
            `expected ${PAGE_SIZE}`);
        }
        dst.set(src);
        return;
      }
      dst.fill(0);
    },
    writePage(pageIdx, src) {
      if (src.length !== PAGE_SIZE) {
        throw new Error(
          `sqlite backend: writePage(${pageIdx}) got ${src.length} bytes, ` +
          `expected ${PAGE_SIZE}`);
      }
      // SQLite BLOB bind accepts Uint8Array directly on DO.
      sql.exec(
        "INSERT INTO wk_pages (page_id, data) VALUES (?, ?) " +
        "ON CONFLICT(page_id) DO UPDATE SET data = excluded.data",
        pageIdx, src);
    },
  };
}
