/**
 * GuestMemory — host-side wrapper for reading/writing guest linear memory.
 *
 * The kernel runs WAMR inside kernel.wasm's WebAssembly.Memory. Guest
 * linear memory is a region inside that memory. When paging is active,
 * only a subset of the guest's logical pages are resident (in the hot
 * window); the rest live in a host-provided backend.
 *
 * GuestMemory encapsulates the page-table lookup so host code (NAPI
 * bridge, WASI bridge, etc.) can read and write guest memory by guest
 * address without knowing whether paging is on.
 *
 * In the default identity mode (hot window == full guest memory), every
 * access is a direct view over k.memory.buffer — same as pre-paging.
 * When paging is active, misses trigger a page fault via the PageCache.
 */

const INVALID_SLOT = 0xFFFF;
const PAGE_SIZE = 65536;

export class GuestMemory {
  /**
   * @param {object} kernelExports  kernel.wasm's exports object
   * @param {object|null} pageCache optional PageCache; if null, assumes
   *   identity mode (every logical page is resident in its identity slot).
   */
  constructor(kernelExports, pageCache = null) {
    this.k = kernelExports;
    this.pc = pageCache;
    this._refresh();
  }

  /** Re-read the hot window layout from the kernel. Call after
   *  memory.grow (which detaches k.memory.buffer) or whenever the kernel
   *  might have relocated the hot window / page table. */
  _refresh() {
    this.hotBase = this.k.kernel_hot_window_base();
    this.hotSize = this.k.kernel_hot_window_size();
    this.pageTableAddr = this.k.kernel_page_table_ptr();
  }

  /** Returns the current k.memory.buffer. WebAssembly detaches the old
   *  ArrayBuffer after memory.grow, so we must always fetch fresh. */
  buffer() { return this.k.memory.buffer; }

  /** Returns a Uint16Array view over the kernel's flat page table.
   *  Indexed by logical page, value is slot index or INVALID_SLOT. */
  _pageTable() {
    const count = this.k.kernel_logical_page_count();
    return new Uint16Array(this.buffer(), this.pageTableAddr, count);
  }

  /** Translate logical page → slot, faulting if needed.
   *  Routes through `kernel_ensure_page_resident` when a page cache is
   *  present, so kernel bookkeeping (page table + slot-to-page map) is
   *  updated through the same path the interpreter uses. That avoids
   *  JS-side state diverging from kernel-side state when the host
   *  bridge reads guest memory between guest opcodes. */
  _slotFor(logicalPage) {
    const pt = this._pageTable();
    let slot = pt[logicalPage];
    if (slot !== INVALID_SLOT) return slot;
    // Route through kernel_ensure_page_resident so the C-side
    // bookkeeping (g_page_table + g_slot_to_page) is updated atomically
    // with the backend I/O — avoids divergence between JS-side
    // slot_to_page and kernel-side state.
    if (this.k.kernel_ensure_page_resident) {
      return this.k.kernel_ensure_page_resident(logicalPage);
    }
    if (!this.pc) {
      throw new Error(
        `GuestMemory: page ${logicalPage} not resident and no page cache`);
    }
    return this.pc.onPageFault(logicalPage);
  }

  /** Guest addr → physical offset inside k.memory.buffer.
   *  Requires the containing page to be resident.
   *
   *  Before translating, commit any pending cross-page scratch back to
   *  its logical pages. The interpreter's CHECK_MEMORY_OVERFLOW macro
   *  stages cross-page scalar accesses in a scratch buffer that's only
   *  flushed at the next macro call or explicit flush. Host-side readers
   *  compute the physical address directly from the page table, so they
   *  would see stale bytes in the hot window if we didn't flush here. */
  _phys(guestAddr) {
    if (this.k.kernel_flush_cross_scratch)
      this.k.kernel_flush_cross_scratch();
    const pg = guestAddr >>> 16;
    const po = guestAddr & 0xFFFF;
    const slot = this._slotFor(pg);
    return this.hotBase + slot * PAGE_SIZE + po;
  }

  _markDirty(guestAddr, len) {
    if (!this.pc) return;
    let pg = guestAddr >>> 16;
    const lastPg = (guestAddr + len - 1) >>> 16;
    for (; pg <= lastPg; pg++) this.pc.markDirty(pg);
  }

  // ---------- scalar reads ----------

  readU8(guestAddr) {
    return new DataView(this.buffer()).getUint8(this._phys(guestAddr));
  }

  readU16(guestAddr) {
    return new DataView(this.buffer()).getUint16(this._phys(guestAddr), true);
  }

  readU32(guestAddr) {
    return new DataView(this.buffer()).getUint32(this._phys(guestAddr), true);
  }

  readI32(guestAddr) {
    return new DataView(this.buffer()).getInt32(this._phys(guestAddr), true);
  }

  readU64(guestAddr) {
    return new DataView(this.buffer()).getBigUint64(this._phys(guestAddr), true);
  }

  readI64(guestAddr) {
    return new DataView(this.buffer()).getBigInt64(this._phys(guestAddr), true);
  }

  readF64(guestAddr) {
    return new DataView(this.buffer()).getFloat64(this._phys(guestAddr), true);
  }

  // ---------- scalar writes ----------

  writeU8(guestAddr, v) {
    const p = this._phys(guestAddr);
    new DataView(this.buffer()).setUint8(p, v);
    this._markDirty(guestAddr, 1);
  }

  writeU16(guestAddr, v) {
    const p = this._phys(guestAddr);
    new DataView(this.buffer()).setUint16(p, v, true);
    this._markDirty(guestAddr, 2);
  }

  writeU32(guestAddr, v) {
    const p = this._phys(guestAddr);
    new DataView(this.buffer()).setUint32(p, v, true);
    this._markDirty(guestAddr, 4);
  }

  writeI32(guestAddr, v) {
    const p = this._phys(guestAddr);
    new DataView(this.buffer()).setInt32(p, v, true);
    this._markDirty(guestAddr, 4);
  }

  writeU64(guestAddr, v) {
    const p = this._phys(guestAddr);
    new DataView(this.buffer()).setBigUint64(p, BigInt(v), true);
    this._markDirty(guestAddr, 8);
  }

  writeI64(guestAddr, v) {
    const p = this._phys(guestAddr);
    new DataView(this.buffer()).setBigInt64(p, BigInt(v), true);
    this._markDirty(guestAddr, 8);
  }

  writeF64(guestAddr, v) {
    const p = this._phys(guestAddr);
    new DataView(this.buffer()).setFloat64(p, v, true);
    this._markDirty(guestAddr, 8);
  }

  // ---------- bulk reads/writes ----------

  /** Copies `len` bytes starting at guest address `guestAddr` into a
   *  fresh Uint8Array. Handles multi-page ranges by iterating. */
  readBytes(guestAddr, len) {
    if (this.k.kernel_flush_cross_scratch)
      this.k.kernel_flush_cross_scratch();
    const out = new Uint8Array(len);
    let pos = 0;
    let addr = guestAddr >>> 0;
    while (pos < len) {
      const pg = addr >>> 16;
      const po = addr & 0xFFFF;
      const chunk = Math.min(len - pos, PAGE_SIZE - po);
      const slot = this._slotFor(pg);
      const physAddr = this.hotBase + slot * PAGE_SIZE + po;
      out.set(
        new Uint8Array(this.buffer(), physAddr, chunk),
        pos);
      pos += chunk;
      addr += chunk;
    }
    return out;
  }

  /** Writes `bytes` at guest address `guestAddr`. `bytes` is a
   *  Uint8Array. Iterates across page boundaries. */
  writeBytes(guestAddr, bytes) {
    if (this.k.kernel_flush_cross_scratch)
      this.k.kernel_flush_cross_scratch();
    const len = bytes.byteLength;
    let pos = 0;
    let addr = guestAddr >>> 0;
    while (pos < len) {
      const pg = addr >>> 16;
      const po = addr & 0xFFFF;
      const chunk = Math.min(len - pos, PAGE_SIZE - po);
      const slot = this._slotFor(pg);
      const physAddr = this.hotBase + slot * PAGE_SIZE + po;
      new Uint8Array(this.buffer(), physAddr, chunk)
        .set(bytes.subarray(pos, pos + chunk));
      if (this.pc) this.pc.markDirty(pg);
      pos += chunk;
      addr += chunk;
    }
  }

  /** UTF-8 decode `len` bytes from `guestAddr`. */
  readString(guestAddr, len) {
    return new TextDecoder().decode(this.readBytes(guestAddr, len));
  }

  /** Scan bytes starting at `guestAddr` until NUL, decode as UTF-8.
   *  `maxLen` caps the scan (default 16 MB). */
  readCString(guestAddr, maxLen = 16 * 1024 * 1024) {
    if (this.k.kernel_flush_cross_scratch)
      this.k.kernel_flush_cross_scratch();
    // Scan page by page for NUL. For single-page strings (the common
    // case) this is a single buffer view.
    let end = guestAddr;
    const limit = guestAddr + maxLen;
    while (end < limit) {
      const pg = end >>> 16;
      const po = end & 0xFFFF;
      const slot = this._slotFor(pg);
      const physBase = this.hotBase + slot * PAGE_SIZE;
      const mem = new Uint8Array(this.buffer(), physBase, PAGE_SIZE);
      let i = po;
      while (i < PAGE_SIZE && mem[i] !== 0) i++;
      if (i < PAGE_SIZE) {
        end += i - po;
        break;
      }
      end += PAGE_SIZE - po;
    }
    return this.readString(guestAddr, end - guestAddr);
  }

  /** Encode `str` as UTF-8 and write up to `maxLen` bytes at `guestAddr`.
   *  Returns number of bytes written. */
  writeStringUtf8(guestAddr, str, maxLen) {
    const bytes = new TextEncoder().encode(str);
    const len = Math.min(bytes.byteLength, maxLen);
    this.writeBytes(guestAddr, bytes.subarray(0, len));
    return len;
  }

  /** Copy bytes from `externalBytes` (Uint8Array) into guest memory.
   *  Same as writeBytes but explicit name matching naming conventions. */
  writeHostBytes(guestAddr, externalBytes) {
    this.writeBytes(guestAddr, externalBytes);
  }
}

/** Convenience factory: builds a GuestMemory from just the kernel
 *  exports, in identity mode (no page cache, no backend). */
export function createIdentityGuestMemory(kernelExports) {
  return new GuestMemory(kernelExports, null);
}
