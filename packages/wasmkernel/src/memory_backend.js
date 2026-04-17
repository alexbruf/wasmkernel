/**
 * MemoryBackend — sync page store for guest linear memory.
 *
 * The backend is the authoritative source of cold pages. It sees
 * page-granular reads and writes. All methods MUST be synchronous —
 * the WAMR interpreter blocks on a miss and cannot tolerate a Promise.
 *
 *   sizePages()                    Current logical size, in 64 KB pages.
 *   growPages(delta) -> number     Grow logical size; returns old pages or -1.
 *   readPage(pageIdx, dst)         Fill dst (65536 bytes) with page data.
 *                                  Missing pages MUST zero-fill.
 *   writePage(pageIdx, src)        Persist src (65536 bytes) as the page.
 *
 * The in-memory backend is the default — useful for tests and for
 * Node runs where footprint isn't a concern.
 */

export const PAGE_SIZE = 65536;

/** Typedef only — JS has no interfaces, so this is documentation.
 * @typedef {object} MemoryBackend
 * @property {() => number} sizePages
 * @property {(delta: number) => number} growPages
 * @property {(pageIdx: number, dst: Uint8Array) => void} readPage
 * @property {(pageIdx: number, src: Uint8Array) => void} writePage
 */

/** Pure-JS in-memory backend. Stores each page as a Uint8Array in a Map.
 *  Missing pages zero-fill on read. */
export function createInMemoryBackend(initialPages = 0) {
  const pages = new Map();
  let size = initialPages;

  return {
    sizePages() { return size; },
    growPages(delta) {
      const old = size;
      size += delta;
      return old;
    },
    readPage(pageIdx, dst) {
      const stored = pages.get(pageIdx);
      if (stored) {
        dst.set(stored);
      } else {
        dst.fill(0);
      }
    },
    writePage(pageIdx, src) {
      // Store a copy so subsequent writes to the hot window don't
      // silently mutate our stored version.
      pages.set(pageIdx, new Uint8Array(src));
    },
  };
}
