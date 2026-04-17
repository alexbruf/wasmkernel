#include "paged_mem.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

uint8_t *g_hot_base = NULL;
uint16_t g_page_table[PAGED_MEM_MAX_LOGICAL_PAGES];
uint32_t g_logical_pages = 0;
uint32_t g_hot_window_pages = 0;
bool g_paged_init_in_progress = false;

/* Reverse map: slot -> logical page (for eviction). Used by fault handler. */
static uint32_t g_slot_to_page[PAGED_MEM_MAX_HOT_SLOTS];

/* True when hot window is a dedicated buffer (paging active).
   False during identity-mapped bringup. Exposed via the header so the
   interpreter hook macros can skip their cross-page slow path (the hot
   window covers the full memory contiguously in identity mode). */
bool g_paging_active = false;

/* Bridge slot the host has registered as its page-fault handler.
   Reuses the generic host_func_call bridge (see wasmkernel.c) so we
   don't add a new wasm import that every host would need to stub.
   0 = paging disabled / not registered. */
static uint32_t g_page_fault_bridge_slot = 0;

/* Forward the paging request through the generic host bridge. This
   declaration matches wasmkernel.c's host_func_call. */
__attribute__((import_module("host"), import_name("host_func_call")))
extern int64_t host_func_call(uint32_t func_idx, uint32_t args_ptr,
                              uint32_t argc);

void
paged_mem_set_page_fault_bridge_slot(uint32_t slot)
{
    g_page_fault_bridge_slot = slot;
}

bool
paged_mem_addr_in_hot_window(const void *addr, uint64_t size)
{
    if (!g_hot_base) return false;
    const uint8_t *p = (const uint8_t *)addr;
    const uint8_t *hot_end = g_hot_base
        + ((uint64_t)g_hot_window_pages << 16);
    return p >= g_hot_base && p + size <= hot_end;
}

void
paged_mem_on_instantiate(uint8_t *wamr_memory_data,
                         uint32_t initial_logical_pages,
                         uint32_t requested_hot_window_pages)
{
    if (initial_logical_pages > PAGED_MEM_MAX_LOGICAL_PAGES)
        initial_logical_pages = PAGED_MEM_MAX_LOGICAL_PAGES;
    g_logical_pages = initial_logical_pages;

    if (requested_hot_window_pages == 0
        || requested_hot_window_pages >= initial_logical_pages) {
        /* Identity mapping: hot window == WAMR's memory_data.
           Every logical page N maps to slot N. The paged macros reduce
           to the pre-paging behavior. */
        g_paging_active = false;
        g_hot_base = wamr_memory_data;
        g_hot_window_pages = initial_logical_pages;
        for (uint32_t i = 0; i < initial_logical_pages; i++) {
            g_page_table[i] = (uint16_t)i;
            g_slot_to_page[i] = i;
        }
        for (uint32_t i = initial_logical_pages;
             i < PAGED_MEM_MAX_LOGICAL_PAGES; i++) {
            g_page_table[i] = PAGED_MEM_INVALID_SLOT;
        }
        return;
    }

    if (requested_hot_window_pages > PAGED_MEM_MAX_HOT_SLOTS)
        requested_hot_window_pages = PAGED_MEM_MAX_HOT_SLOTS;

    /* Slot-cycling mode. Slots 0..hot_window_pages-1 occupy the first
     * `hot_window_pages * 64KB` bytes of memory_data. Cold pages live
     * only in the backend. Evicting a slot reuses its physical bytes
     * for a different logical page. Because writes only ever land in
     * those first N physical pages, V8 only commits N pages regardless
     * of the guest's logical working set.
     *
     * Cold region sentinel: fill memory_data[hot_window*64K..logical*64K)
     * with 0x5A. If any WAMR code does `memory_data + logical_offset`
     * bypassing our CHECK_MEMORY_OVERFLOW macro, it either reads 0x5A
     * bytes (detectable as garbage in guest execution) or overwrites
     * them (detectable via paged_mem_scan_cold_region). Critical for
     * finding the long-tail of unpatched deref sites in WAMR. */
    g_paging_active = true;
    g_hot_base = wamr_memory_data;
    g_hot_window_pages = requested_hot_window_pages;
    for (uint32_t i = 0; i < PAGED_MEM_MAX_LOGICAL_PAGES; i++)
        g_page_table[i] = PAGED_MEM_INVALID_SLOT;
    for (uint32_t i = 0; i < PAGED_MEM_MAX_HOT_SLOTS; i++)
        g_slot_to_page[i] = 0xFFFFFFFFu;
    /* No sentinel fill — cold region contents preserve whatever WAMR
       wrote during instantiate (active data segments plus any
       init-expr / start-fn memory writes). Host sparse-seeds those
       bytes into the backend after on_instantiate so they survive
       across subsequent paged faults. */
}

/* Scan the cold region of memory_data for bytes that differ from the
 * 0x5A sentinel. Returns the first offending byte offset (relative to
 * memory_data) or UINT64_MAX if clean. Called after every fault to
 * surface bypass sites: if a WAMR path wrote bytes outside the hot
 * window, this catches it immediately so the surrounding state is
 * still meaningful for diagnosis.
 *
 * NOTE: this only detects WRITES to the cold region. Reads from the
 * cold region produce 0x5A bytes but don't leave a trace — they show
 * up as guest-side execution errors (like reading 0x5A5A5A5A as a
 * pointer). The fault-path trace combined with the first-corruption
 * offset is usually enough to triangulate the source. */

uint64_t
paged_mem_scan_cold_region(uint64_t *out_offset, uint8_t *out_byte)
{
    if (!g_paging_active) return 0xFFFFFFFFFFFFFFFFull;
    uint64_t start = (uint64_t)g_hot_window_pages << 16;
    uint64_t end = (uint64_t)g_logical_pages << 16;
    for (uint64_t i = start; i < end; i++) {
        if (g_hot_base[i] != 0x5A) {
            if (out_offset) *out_offset = i;
            if (out_byte) *out_byte = g_hot_base[i];
            return i;
        }
    }
    return 0xFFFFFFFFFFFFFFFFull;
}

uint32_t
paged_mem_fault(uint32_t logical_page)
{
    if (logical_page >= g_logical_pages) {
        fprintf(stderr, "paged_mem_fault: out-of-range page %u (logical=%u)\n",
                logical_page, g_logical_pages);
        return 0;
    }
    if (!g_paging_active) {
        /* Should never reach: identity mapping has every page resident. */
        fprintf(stderr,
                "paged_mem_fault: called in identity mode for page %u\n",
                logical_page);
        return logical_page;
    }
    if (g_page_fault_bridge_slot == 0) {
        fprintf(stderr,
                "paged_mem_fault: paging active but no host handler registered "
                "(call kernel_register_page_fault_slot first)\n");
        return 0;
    }
    /* Pass logical_page as arg[0] of a single-arg host bridge call. The
       raw API writes args through a uint64[] — arg 0 is the page index,
       which the host's handler reads as u32. The handler returns the
       slot (via backend read/write) as i64. */
    uint64_t args_buf[1];
    args_buf[0] = (uint64_t)logical_page;
    int64_t ret = host_func_call(g_page_fault_bridge_slot,
                                 (uint32_t)(uintptr_t)args_buf, 1);
    uint32_t slot = (uint32_t)ret;
    if (slot >= g_hot_window_pages) {
        fprintf(stderr, "paged_mem_fault: host returned invalid slot %u (hot_window=%u)\n",
                slot, g_hot_window_pages);
        return 0;
    }
    /* Update bookkeeping from C to avoid JS→wasm re-entry while the
     * interpreter is paused in the middle of a load/store opcode.
     * The JS handler performs the actual backend I/O; we reconcile the
     * page table + slot-to-page map here. */
    uint32_t victim_page = g_slot_to_page[slot];
    if (victim_page != 0xFFFFFFFFu && victim_page != logical_page
        && victim_page < PAGED_MEM_MAX_LOGICAL_PAGES) {
        g_page_table[victim_page] = PAGED_MEM_INVALID_SLOT;
    }
    g_page_table[logical_page] = (uint16_t)slot;
    g_slot_to_page[slot] = logical_page;
    return slot;
}

/* Deferred-commit scratch for cross-page scalar accesses in slot-cycling
 * mode. The macro doesn't know load vs store, so we:
 *   1. Stage the current bytes from both logical pages into scratch.
 *   2. Return the scratch address.
 *   3. On the next paged memory-access macro (or an explicit flush),
 *      write scratch back to the logical pages.
 * If it was a load, the writeback is a no-op (same bytes back). If it
 * was a store, the new value is committed.
 *
 * Max scalar access size in wasm is 16 bytes (v128). Scratch is 32B
 * aligned so accesses don't straddle the scratch buffer internally. */
#define PAGED_MEM_SCRATCH_SIZE 32u
static uint8_t g_cross_scratch[PAGED_MEM_SCRATCH_SIZE]
    __attribute__((aligned(16)));
static uint64_t g_cross_offset;
static uint32_t g_cross_bytes;
static bool     g_cross_pending;

/* Flush pending scratch back to logical pages. Called at the start of
 * every CHECK_MEMORY_OVERFLOW and at interpreter exit / host boundary. */
void
paged_mem_flush_cross_scratch(void)
{
    if (!g_cross_pending) return;
    uint64_t ofs = g_cross_offset;
    uint32_t remaining = g_cross_bytes;
    uint32_t src_off = 0;
    /* Clear pending BEFORE the writes, so recursive calls from the
     * fault handler don't re-enter the flush. */
    g_cross_pending = false;
    while (remaining > 0) {
        uint32_t pg = (uint32_t)(ofs >> 16);
        uint32_t po = (uint32_t)(ofs & 0xFFFFu);
        uint32_t n = 65536u - po;
        if (n > remaining) n = remaining;
        uint16_t slot = g_page_table[pg];
        if (slot == PAGED_MEM_INVALID_SLOT)
            slot = (uint16_t)paged_mem_fault(pg);
        memcpy(g_hot_base + ((uintptr_t)slot << 16) + po,
               g_cross_scratch + src_off, n);
        ofs += n;
        src_off += n;
        remaining -= n;
    }
}

uint8_t *
paged_mem_cross_page(uint64_t offset, uint32_t bytes)
{
    /* Cross-page access spans 2+ logical pages. In identity mode, slot
       N == page N so pages are naturally contiguous in memory_data —
       return the direct pointer. */
    if (!g_paging_active) {
        return g_hot_base + offset;
    }
    /* Commit any previously staged scratch before reusing it. */
    paged_mem_flush_cross_scratch();

    if (bytes > PAGED_MEM_SCRATCH_SIZE) {
        /* Larger than our scratch (shouldn't happen for scalar ops —
         * bulk ops route through paged_mem_bulk_* helpers instead). */
        fprintf(stderr,
                "paged_mem_cross_page: access too large for scratch "
                "(ofs=0x%llx bytes=%u limit=%u) — returning OOB\n",
                (unsigned long long)offset, bytes, PAGED_MEM_SCRATCH_SIZE);
        return NULL;
    }

    uint32_t pg0 = (uint32_t)(offset >> 16);
    uint32_t pg1 = (uint32_t)((offset + bytes - 1) >> 16);

    /* Fault in every page covered by the access. */
    for (uint32_t p = pg0; p <= pg1; p++) {
        if (g_page_table[p] == PAGED_MEM_INVALID_SLOT)
            (void)paged_mem_fault(p);
    }

    /* Stage the logical bytes into scratch so loads read the right
     * data. Stores will overwrite scratch; the flush commits the new
     * value back to the logical pages. */
    uint64_t ofs = offset;
    uint32_t remaining = bytes;
    uint32_t dst_off = 0;
    while (remaining > 0) {
        uint32_t pg = (uint32_t)(ofs >> 16);
        uint32_t po = (uint32_t)(ofs & 0xFFFFu);
        uint32_t n = 65536u - po;
        if (n > remaining) n = remaining;
        uint16_t slot = g_page_table[pg];
        memcpy(g_cross_scratch + dst_off,
               g_hot_base + ((uintptr_t)slot << 16) + po, n);
        ofs += n;
        dst_off += n;
        remaining -= n;
    }

    g_cross_offset = offset;
    g_cross_bytes = bytes;
    g_cross_pending = true;
    return g_cross_scratch;
}

/* Translate a logical guest offset to a hot-window native pointer,
 * faulting the page in if necessary. Used by the bulk helpers below.
 * Returns NULL on out-of-bounds. */
static uint8_t *
_paged_xlate(uint64_t offset)
{
    uint32_t pg = (uint32_t)(offset >> 16);
    uint32_t po = (uint32_t)(offset & 0xFFFFu);
    if (pg >= g_logical_pages) return NULL;
    uint16_t slot = g_page_table[pg];
    if (slot == PAGED_MEM_INVALID_SLOT)
        slot = (uint16_t)paged_mem_fault(pg);
    return g_hot_base + ((uintptr_t)slot << 16) + po;
}

int
paged_mem_bulk_copy_from_data(uint64_t dst_offset, const uint8_t *src,
                              uint64_t bytes)
{
    if (bytes == 0) return 0;
    if (dst_offset + bytes > (uint64_t)g_logical_pages * 65536) return -1;
    paged_mem_flush_cross_scratch();
    if (!g_paging_active) {
        memcpy(g_hot_base + dst_offset, src, (size_t)bytes);
        return 0;
    }
    while (bytes > 0) {
        uint32_t po = (uint32_t)(dst_offset & 0xFFFFu);
        uint32_t room = 65536u - po;
        uint32_t n = (bytes < room) ? (uint32_t)bytes : room;
        uint8_t *dst = _paged_xlate(dst_offset);
        if (!dst) return -1;
        memcpy(dst, src, n);
        src += n;
        dst_offset += n;
        bytes -= n;
    }
    return 0;
}

int
paged_mem_bulk_fill(uint64_t dst_offset, uint8_t val, uint64_t bytes)
{
    if (bytes == 0) return 0;
    if (dst_offset + bytes > (uint64_t)g_logical_pages * 65536) return -1;
    paged_mem_flush_cross_scratch();
    if (!g_paging_active) {
        memset(g_hot_base + dst_offset, val, (size_t)bytes);
        return 0;
    }
    while (bytes > 0) {
        uint32_t po = (uint32_t)(dst_offset & 0xFFFFu);
        uint32_t room = 65536u - po;
        uint32_t n = (bytes < room) ? (uint32_t)bytes : room;
        uint8_t *dst = _paged_xlate(dst_offset);
        if (!dst) return -1;
        memset(dst, val, n);
        dst_offset += n;
        bytes -= n;
    }
    return 0;
}

/* Scratch buffer for overlapping intra-page or across-page copy that
 * needs to read before writing. A single 64K buffer is enough: we split
 * at page boundaries and stage each page chunk through scratch. */
static uint8_t g_bulk_scratch[65536];

int
paged_mem_bulk_copy(uint64_t dst_offset, uint64_t src_offset, uint64_t bytes)
{
    if (bytes == 0) return 0;
    uint64_t mem_sz = (uint64_t)g_logical_pages * 65536;
    if (dst_offset + bytes > mem_sz) return -1;
    if (src_offset + bytes > mem_sz) return -1;
    paged_mem_flush_cross_scratch();
    if (!g_paging_active) {
        memmove(g_hot_base + dst_offset, g_hot_base + src_offset, (size_t)bytes);
        return 0;
    }
    /* Decide direction: if dst is ahead of src and they overlap, copy
     * backwards so we don't clobber yet-to-be-read source bytes. */
    int reverse = (dst_offset > src_offset
                   && dst_offset < src_offset + bytes);
    if (reverse) {
        uint64_t s_end = src_offset + bytes;
        uint64_t d_end = dst_offset + bytes;
        while (bytes > 0) {
            /* Max chunk: fits in one src page AND one dst page, working
             * backwards from the end. */
            uint32_t s_po = (uint32_t)((s_end - 1) & 0xFFFFu) + 1;
            uint32_t d_po = (uint32_t)((d_end - 1) & 0xFFFFu) + 1;
            uint32_t n = s_po < d_po ? s_po : d_po;
            if ((uint64_t)n > bytes) n = (uint32_t)bytes;
            uint8_t *src = _paged_xlate(s_end - n);
            if (!src) return -1;
            memcpy(g_bulk_scratch, src, n);
            uint8_t *dst = _paged_xlate(d_end - n);
            if (!dst) return -1;
            memcpy(dst, g_bulk_scratch, n);
            s_end -= n;
            d_end -= n;
            bytes -= n;
        }
    }
    else {
        while (bytes > 0) {
            uint32_t s_po = (uint32_t)(src_offset & 0xFFFFu);
            uint32_t d_po = (uint32_t)(dst_offset & 0xFFFFu);
            uint32_t s_room = 65536u - s_po;
            uint32_t d_room = 65536u - d_po;
            uint32_t n = s_room < d_room ? s_room : d_room;
            if ((uint64_t)n > bytes) n = (uint32_t)bytes;
            uint8_t *src = _paged_xlate(src_offset);
            if (!src) return -1;
            memcpy(g_bulk_scratch, src, n);
            uint8_t *dst = _paged_xlate(dst_offset);
            if (!dst) return -1;
            memcpy(dst, g_bulk_scratch, n);
            src_offset += n;
            dst_offset += n;
            bytes -= n;
        }
    }
    return 0;
}

void
paged_mem_begin_init(void)
{
    g_paged_init_in_progress = true;
}

void
paged_mem_end_init(void)
{
    g_paged_init_in_progress = false;
}

void
paged_mem_on_grow(uint8_t *wamr_memory_data,
                  uint32_t old_pages, uint32_t new_pages)
{
    (void)old_pages;
    g_logical_pages = new_pages;
    if (!g_paging_active) {
        /* Identity mode: WAMR reallocated memory_data, refresh base and
           extend the identity table. */
        g_hot_base = wamr_memory_data;
        if (new_pages > PAGED_MEM_MAX_LOGICAL_PAGES)
            new_pages = PAGED_MEM_MAX_LOGICAL_PAGES;
        g_hot_window_pages = new_pages;
        for (uint32_t i = 0; i < new_pages; i++)
            g_page_table[i] = (uint16_t)i;
    }
    /* Paging-active grow: hot window stays fixed. New logical pages start
       un-resident; they'll fault in on first access. */
}
