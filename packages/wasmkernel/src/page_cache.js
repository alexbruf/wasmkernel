/**
 * PageCache — JS-side slot allocator + fault handler for paged guest memory.
 *
 * Slot cycling: the hot window is the first `hotWindowPages` physical pages
 * of memory_data. Slots 0..hotWindowPages-1 are reused across logical pages.
 * When a fault happens for a logical page that isn't in any slot, we either
 * claim a free slot or evict one (flush to backend, zero the slot view)
 * and reuse it. This is what caps physical commits — V8 only commits the
 * first hotWindowPages * 64KB of memory_data, ever.
 *
 * The kernel's paged_mem_fault C function calls onPageFault(logicalPage)
 * synchronously via the host_func_call bridge while the interpreter is
 * paused mid-opcode. We MUST NOT re-enter kernel_step / guest wasm here;
 * the C side updates g_page_table + g_slot_to_page based on our return value.
 */

import { PAGE_SIZE } from "./memory_backend.js";

export class PageCache {
  /**
   * @param {object} k                  kernel.wasm exports
   * @param {object} backend            MemoryBackend
   * @param {number} hotWindowPages     number of slots in the hot window
   */
  constructor(k, backend, hotWindowPages) {
    this.k = k;
    this.backend = backend;
    this.hotWindowPages = hotWindowPages;
    // slot index -> logical page (or -1 for unused)
    this.slotToPage = new Int32Array(hotWindowPages).fill(-1);
    // clock refbit per slot
    this.refbit = new Uint8Array(hotWindowPages);
    this.hand = 0;
    this.scratch = new Uint8Array(PAGE_SIZE);

    // Per-page "ever faulted" bitmap. uniqueTouchedPages is an upper
    // bound on committed RSS on platforms that don't decommit (CF).
    this._everTouched = new Uint8Array(8192);
    this.uniqueTouchedPages = 0;

    // Diagnostic: poll kernel_scan_cold_region after every fault. If
    // any byte in the cold region is not the 0x5A sentinel, some WAMR
    // path bypassed our macro — log once and continue (so we can see
    // how far the guest gets before crashing).
    // Sentinel scan is opt-in: we don't actually fill 0x5A into the cold
    // region (would clobber WAMR's pre-instantiate memory_data writes), so
    // the scan is only meaningful when the caller also enables a sentinel
    // fill. Left off by default to avoid spurious "expected 0x5A" reports.
    this._corruptionReported = false;
    this._scanOutPtr = 0;
    if (process.env.PC_COLD_SCAN
        && typeof this.k.kernel_alloc === "function"
        && typeof this.k.kernel_scan_cold_region === "function") {
      this._scanOutPtr = this.k.kernel_alloc(1);
    }
  }

  _hotBase() { return this.k.kernel_hot_window_base(); }

  /** Called by GuestMemory on host-side writes. No-op in v1 — we
   *  pessimistically treat every resident slot as potentially dirty
   *  and always flush on eviction. */
  markDirty(_logicalPage) {}

  _slotView(slotIdx) {
    return new Uint8Array(
      this.k.memory.buffer,
      this._hotBase() + slotIdx * PAGE_SIZE,
      PAGE_SIZE);
  }

  _checkCorruption(contextLabel) {
    if (this._corruptionReported || !this._scanOutPtr) return;
    const offset = this.k.kernel_scan_cold_region(this._scanOutPtr);
    if (offset === 0) return;  // clean
    const byteVal = new Uint8Array(this.k.memory.buffer, this._scanOutPtr, 1)[0];
    const logicalPage = Math.floor(offset / PAGE_SIZE);
    const pageOffset = offset % PAGE_SIZE;
    // Grab surrounding bytes for fingerprinting
    const hotBase = this._hotBase();
    const around = new Uint8Array(
      this.k.memory.buffer,
      hotBase + offset - Math.min(8, offset),
      Math.min(32, this.k.memory.buffer.byteLength - (hotBase + offset))
    );
    const hex = Array.from(around).map(b => b.toString(16).padStart(2, "0")).join(" ");
    process.stderr.write(
      `[pc] CORRUPTION in cold region during ${contextLabel}: ` +
      `offset=${offset} (logical_page=${logicalPage} po=0x${pageOffset.toString(16)}) ` +
      `byte=0x${byteVal.toString(16).padStart(2, "0")} (expected 0x5A)\n` +
      `[pc]   nearby bytes (+/- 8): ${hex}\n`);
    this._corruptionReported = true;
  }

  /** Allocate a slot for `logicalPage`. Returns { slot, victim } where
   *  victim is -1 if the slot was free. Caller handles the backend I/O. */
  _allocateSlot(logicalPage) {
    // First pass: find a free slot by sweeping the clock hand.
    for (let i = 0; i < this.hotWindowPages; i++) {
      const slot = this.hand;
      this.hand = (this.hand + 1) % this.hotWindowPages;
      if (this.slotToPage[slot] === -1) {
        return { slot, victim: -1 };
      }
    }
    // Clock evict — up to 2 passes, clearing refbits on the first.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < this.hotWindowPages; i++) {
        const slot = this.hand;
        this.hand = (this.hand + 1) % this.hotWindowPages;
        const owner = this.slotToPage[slot];
        if (owner === logicalPage) continue;  // defensive; shouldn't happen
        if (this.refbit[slot]) {
          this.refbit[slot] = 0;
          continue;
        }
        return { slot, victim: owner };
      }
    }
    // Fallback: everything's hot. Evict current hand position.
    const slot = this.hand;
    this.hand = (this.hand + 1) % this.hotWindowPages;
    return { slot, victim: this.slotToPage[slot] };
  }

  /**
   * Called synchronously from the kernel's paged_mem_fault via the
   * host_func_call bridge. Returns the slot index now holding
   * `logicalPage`. Contract: by the time we return, the bytes for
   * logicalPage are materialized at memory_data[slot*64K..slot*64K+64K].
   */
  onPageFault(logicalPage) {
    if (process.env.PC_TRACE) {
      process.stderr.write(
        `[pc] fault-in logical=${logicalPage} hand=${this.hand}\n`);
    }
    if (logicalPage < this._everTouched.length
        && !this._everTouched[logicalPage]) {
      this._everTouched[logicalPage] = 1;
      this.uniqueTouchedPages++;
    }

    const { slot, victim } = this._allocateSlot(logicalPage);
    const view = this._slotView(slot);
    if (victim >= 0) {
      // Flush victim to backend before overwriting.
      this.scratch.set(view);
      this.backend.writePage(victim, this.scratch);
      view.fill(0);
      this.evictions = (this.evictions || 0) + 1;
    }
    // Load the faulting page into the slot.
    this.backend.readPage(logicalPage, view);
    this.slotToPage[slot] = logicalPage;
    this.refbit[slot] = 1;
    if (process.env.PC_TRACE) {
      const first = view.slice(0, 32);
      const hex = Array.from(first)
        .map(b => b.toString(16).padStart(2, "0")).join(" ");
      const allZero = first.every(b => b === 0);
      process.stderr.write(
        `[pc]   slot ${slot} first 32B after load ${allZero ? "(all zero)" : ""}: ${hex}\n`);
    }

    // Sentinel-diagnostic scan. Runs after every fault so the first
    // bypass surfaces close in time to whatever WAMR path caused it.
    this._checkCorruption(`fault(logical=${logicalPage},slot=${slot})`);
    return slot;
  }

  /** Not used in the normal fault path; kept for RSS-pressure heuristics. */
  evictPage(logicalPage) {
    for (let slot = 0; slot < this.hotWindowPages; slot++) {
      if (this.slotToPage[slot] === logicalPage) {
        const view = this._slotView(slot);
        this.scratch.set(view);
        this.backend.writePage(logicalPage, this.scratch);
        view.fill(0);
        this.slotToPage[slot] = -1;
        this.refbit[slot] = 0;
        if (this.k.kernel_page_table_clear) {
          this.k.kernel_page_table_clear(logicalPage);
        }
        return;
      }
    }
  }
}
