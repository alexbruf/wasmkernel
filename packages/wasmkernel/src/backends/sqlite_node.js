/**
 * SQLite-backed MemoryBackend for Node, via better-sqlite3. Used for
 * local testing of the paged-memory system outside of Miniflare / DO.
 *
 * Schema matches sqlite_do.js so the two are interchangeable.
 *
 * Usage:
 *   import Database from "better-sqlite3";
 *   import { createSqliteNodeBackend } from "@wasmkernel/runtime/backends/sqlite_node";
 *   const db = new Database(":memory:");
 *   const backend = createSqliteNodeBackend(db);
 */

import { PAGE_SIZE } from "../memory_backend.js";

export function createSqliteNodeBackend(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wk_pages (page_id INTEGER PRIMARY KEY, data BLOB);
    CREATE TABLE IF NOT EXISTS wk_meta  (k TEXT PRIMARY KEY, v INTEGER);
  `);

  const selSize = db.prepare("SELECT v FROM wk_meta WHERE k = 'size_pages'");
  const setSize = db.prepare(
    "INSERT INTO wk_meta (k, v) VALUES ('size_pages', ?) " +
    "ON CONFLICT(k) DO UPDATE SET v = excluded.v");
  const selPage = db.prepare("SELECT data FROM wk_pages WHERE page_id = ?");
  const insPage = db.prepare(
    "INSERT INTO wk_pages (page_id, data) VALUES (?, ?) " +
    "ON CONFLICT(page_id) DO UPDATE SET data = excluded.data");

  const _readSize = () => {
    const row = selSize.get();
    return row ? (row.v | 0) : 0;
  };

  return {
    sizePages() { return _readSize(); },
    growPages(delta) {
      const old = _readSize();
      setSize.run(old + delta);
      return old;
    },
    readPage(pageIdx, dst) {
      const row = selPage.get(pageIdx);
      if (!row) { dst.fill(0); return; }
      const src = row.data instanceof Uint8Array
        ? row.data
        : new Uint8Array(row.data);
      if (src.length !== PAGE_SIZE) {
        throw new Error(
          `sqlite_node: page ${pageIdx} has ${src.length} bytes, ` +
          `expected ${PAGE_SIZE}`);
      }
      dst.set(src);
    },
    writePage(pageIdx, src) {
      if (src.length !== PAGE_SIZE) {
        throw new Error(
          `sqlite_node: writePage(${pageIdx}) got ${src.length} bytes, ` +
          `expected ${PAGE_SIZE}`);
      }
      // better-sqlite3 expects Buffer or Uint8Array for BLOB.
      insPage.run(pageIdx, Buffer.from(src.buffer, src.byteOffset, src.byteLength));
    },
  };
}
