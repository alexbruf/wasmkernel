/**
 * PageCache — JS-side eviction and fault handler for paged guest memory.
 *
 * Owns the hot window. The kernel calls onPageFault(logicalPage) (via
 * the bridge slot registered with kernel_register_page_fault_slot)
 * when the WAMR interpreter hits a page not marked resident. On fault
 * we pick a victim slot via clock eviction, flush it to the backend
 * if dirty, read the new page from the backend into that slot, update
 * the kernel's page table, and return the slot number to the kernel.
 *
 * Dirty bits are maintained JS-side — both the host bridges (writes via
 * GuestMemory mark dirty) and the kernel (every store the interpreter
 * does would mark dirty if we had a good hook — we don't yet, so we
 * pessimistically mark every resident slot dirty as soon as any store
 * could touch it; cheap flag is "hasBeenWrittenSinceLoad"). For v1, we
 * treat every resident slot as potentially dirty and write it back on
 * eviction — safer and still correct.
 */

import { PAGE_SIZE } from "./memory_backend.js";

export class PageCache {
  /**
   * @param {object} k                  kernel.wasm exports
   * @param {object} backend            MemoryBackend
   * @param {number} hotWindowPages     slots in hot window (0..65534)
   */
  constructor(k, backend, hotWindowPages) {
    this.k = k;
    this.backend = backend;
    // hotWindowPages is the hard cap on resident pages. On fault, if we
    // exceed this, we clock-evict until we're back under. In the in-place
    // swap model each slot index IS a logical page; arrays here are
    // indexed by logical page, sized for the kernel's max (matches
    // PAGED_MEM_MAX_LOGICAL_PAGES = 8192).
    this.hotWindowPages = hotWindowPages;
    const maxPages = 8192;
    // slot -> logical page (or -1 for unused)
    this.slotToPage = new Int32Array(maxPages).fill(-1);
    // Dirty bit per slot (pessimistic: set on any write).
    this.dirty = new Uint8Array(maxPages);
    // Clock hand for eviction.
    this.hand = 0;
    // Reference bit per slot (for clock algorithm).
    this.refbit = new Uint8Array(maxPages);
    // Scratch page buffer for backend I/O (reused).
    this.scratch = new Uint8Array(PAGE_SIZE);
    this._residentCount = 0;
    // Per-page "ever faulted" bitmap. `uniqueTouchedPages` is an upper
    // bound on committed RSS on platforms that don't decommit zero-written
    // pages (CF Workers). Measured regardless of eviction — once a page
    // is counted, it stays counted for the life of this cache.
    this._everTouched = new Uint8Array(8192);
    this.uniqueTouchedPages = 0;
  }

  /** Read the current hot-window base from the kernel. */
  _hotBase() { return this.k.kernel_hot_window_base(); }

  /** Return a fresh view of a hot-window slot as a Uint8Array. */
  _slotView(slotIdx) {
    return new Uint8Array(
      this.k.memory.buffer,
      this._hotBase() + slotIdx * PAGE_SIZE,
      PAGE_SIZE);
  }

  /** Mark slot as dirty (write to hot window will be persisted on eviction). */
  markDirty(slotIdx) {
    if (slotIdx < this.hotWindowPages) this.dirty[slotIdx] = 1;
  }

  /** Mark slot as recently used (for clock eviction). */
  _touch(slotIdx) {
    if (slotIdx < this.hotWindowPages) this.refbit[slotIdx] = 1;
  }

  /** Pick a victim slot via clock algorithm. */
  _pickVictim() {
    // At most 2 full passes — guaranteed to find a victim on the 2nd.
    for (let i = 0; i < this.hotWindowPages * 2; i++) {
      const slot = this.hand;
      this.hand = (this.hand + 1) % this.hotWindowPages;
      const pg = this.slotToPage[slot];
      if (pg < 0) return slot;              // unused slot — free
      if (this.refbit[slot]) {
        this.refbit[slot] = 0;              // give second chance
        continue;
      }
      return slot;
    }
    // Fallback: all slots referenced even after clearing refbits; take hand.
    const slot = this.hand;
    this.hand = (this.hand + 1) % this.hotWindowPages;
    return slot;
  }

  /** Handle a page fault for `logicalPage`. Returns the slot it now
   *  occupies. Called synchronously from the kernel via the bridge —
   *  while the wasm interpreter is paused mid-opcode. We MUST NOT call
   *  back into the kernel here (that would nest wasm calls on top of a
   *  paused frame and can corrupt exec_env state). The kernel C-side
   *  updates g_page_table + g_slot_to_page based on the returned slot. */
  onPageFault(logicalPage) {
    // In-place swap model: slot == logical page. Each page lives at its
    // natural offset in WAMR's memory_data. Fault-in reads from backend,
    // marks the page resident, and — if we've exceeded the hot-window
    // resident cap — evicts an LRU page to make room.
    if (process.env.PC_TRACE) {
      process.stderr.write(`[pc] fault-in page=${logicalPage}\n`);
    }
    if (logicalPage < this._everTouched.length
        && !this._everTouched[logicalPage]) {
      this._everTouched[logicalPage] = 1;
      this.uniqueTouchedPages++;
    }
    const dst = this._slotView(logicalPage);
    this.backend.readPage(logicalPage, dst);
    this.slotToPage[logicalPage] = logicalPage;
    this.refbit[logicalPage] = 1;
    this._residentCount++;
    // Enforce the hot-window cap. Clock-sweep victims.
    while (this._residentCount > this.hotWindowPages) {
      const victim = this._pickLRUVictim(logicalPage);
      if (victim < 0) break;  // nothing to evict
      this.evictPage(victim);
    }
    return logicalPage;
  }

  /** Pick a clock-sweep victim, avoiding `protect`. Returns -1 if no
   *  resident page qualifies. */
  _pickLRUVictim(protect) {
    const n = this.slotToPage.length;
    // Two full passes — first clears refbits, second picks a clean one.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const pg = this.hand;
        this.hand = (this.hand + 1) % n;
        if (pg === protect) continue;
        if (this.slotToPage[pg] < 0) continue;  // already cold
        if (this.refbit[pg]) {
          this.refbit[pg] = 0;                  // give second chance
          continue;
        }
        return pg;
      }
    }
    return -1;
  }

  /** Explicitly evict a page: flush to backend, zero memory_data region
   *  so V8 may decommit. Also clears the kernel's page-table entry so the
   *  next guest access to this page faults. */
  evictPage(logicalPage) {
    if (this.slotToPage[logicalPage] < 0) return;  // already cold
    const buf = this._slotView(logicalPage);
    this.backend.writePage(logicalPage, new Uint8Array(buf));
    buf.fill(0);
    this.slotToPage[logicalPage] = -1;
    this.dirty[logicalPage] = 0;
    this.refbit[logicalPage] = 0;
    this._residentCount--;
    this.k.kernel_page_table_clear(logicalPage);
  }
}
