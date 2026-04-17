/*
 * Paged guest memory — kernel-side runtime.
 *
 * The guest's linear memory is a logical address space. Only a small
 * "hot window" of pages is physically resident in kernel memory at a
 * time; cold pages spill to a host-provided backend (e.g. DO SQLite).
 *
 * The page table is a flat uint16_t array indexed by logical page.
 * 0xFFFF means "not resident". Otherwise the value is the hot-window
 * slot index. Slot N occupies bytes [N*65536, (N+1)*65536) of the
 * hot window.
 *
 * The WAMR interpreter's CHECK_MEMORY_OVERFLOW macros (classic + fast)
 * are rewritten (see paged_mem_hooks.h) to look up the page table
 * inline; misses call into paged_mem_fault(), which forwards to the
 * host via the host_page_fault import.
 *
 * The initial state (after kernel_init, before kernel_load completes)
 * is "identity mapping": g_hot_base == WAMR's allocated memory_data
 * and g_page_table[i] == i. In that state the paged macros are
 * mathematically identical to the original WAMR macros, so existing
 * behavior is preserved until the host opts into true paging by
 * calling kernel_set_hot_window_pages() with a value smaller than the
 * guest's declared logical page count.
 */
#ifndef WASMKERNEL_PAGED_MEM_H
#define WASMKERNEL_PAGED_MEM_H

#include <stdint.h>
#include <stdbool.h>

#define PAGED_MEM_INVALID_SLOT 0xFFFFu
#define PAGED_MEM_MAX_LOGICAL_PAGES 8192u  /* 512 MB cap, matches kernel_load */
#define PAGED_MEM_MAX_HOT_SLOTS    4096u   /* 256 MB cap on hot window */

/* Globals read inline by the paged CHECK_MEMORY_OVERFLOW macros. */
extern uint8_t *g_hot_base;
extern uint16_t g_page_table[PAGED_MEM_MAX_LOGICAL_PAGES];
extern uint32_t g_logical_pages;       /* current logical size, in pages */
extern uint32_t g_hot_window_pages;    /* slots in the hot window */
extern bool     g_paged_init_in_progress;
extern bool     g_paging_active;       /* false in identity mode */

/* Called by the interpreter macros on a page miss. Returns slot index. */
uint32_t paged_mem_fault(uint32_t logical_page);

/* Returns true if `addr..addr+size` falls inside the hot window. Used
 * by the patched WAMR range checks (atomic ops, validate_native_addr,
 * etc.) so they accept native pointers that live in the hot window as
 * valid guest memory addresses — otherwise they'd return "out of bounds"
 * for every paged access because the hot window is a separate allocation
 * from memory_data. In identity mode, g_hot_base == memory_data so this
 * still correctly covers that range. */
bool paged_mem_addr_in_hot_window(const void *addr, uint64_t size);

/* Tell the paged layer which bridge slot (as per wasmkernel.c's
   host_func_call registry) is the host's page-fault handler. 0 disables
   paging (fault path traps). */
void paged_mem_set_page_fault_bridge_slot(uint32_t slot);

/* Cross-page fallback (access straddles a 64 KB boundary). Caller passes
   byte count; function returns a pointer to a scratch area with both
   pages assembled (for loads) and registers a commit hook for stores.
   For now: traps. Callers can't currently tell load vs store, so until
   we split, we reject. Very rare path (aligned wasm accesses ≤ 16 bytes). */
uint8_t *paged_mem_cross_page(uint64_t offset, uint32_t bytes);

/* Commit any pending cross-page scratch back to the logical pages.
 * Called at the top of every CHECK_MEMORY_OVERFLOW macro and at host
 * boundaries (wasm_runtime_addr_app_to_native, kernel_call_indirect
 * entry/exit). Safe to call unconditionally. */
void paged_mem_flush_cross_scratch(void);

/* Paged-aware bulk memory operations. In identity mode these reduce to
 * plain memcpy/memset. In slot-cycling mode they walk the pages and do
 * per-page copies via the hot-window slots, faulting as needed, so they
 * work even when the logical range spans non-consecutive physical slots.
 * Return 0 on success, -1 on out-of-bounds (caller should raise the
 * WAMR exception). */
int paged_mem_bulk_copy_from_data(uint64_t dst_offset, const uint8_t *src,
                                  uint64_t bytes);
int paged_mem_bulk_fill(uint64_t dst_offset, uint8_t val, uint64_t bytes);
int paged_mem_bulk_copy(uint64_t dst_offset, uint64_t src_offset,
                        uint64_t bytes);

/* Called by kernel_load after the guest module is instantiated.
   Sets up the page table and allocates the hot window.
   Until the host explicitly calls kernel_set_hot_window_pages(),
   we use an identity mapping so WAMR's original memory layout is
   preserved and existing tests are unaffected. */
void paged_mem_on_instantiate(uint8_t *wamr_memory_data,
                              uint32_t initial_logical_pages,
                              uint32_t requested_hot_window_pages);

/* Called from kernel_load before any data-segment init. Allows the paged
   init path to stage writes through the host rather than WAMR's internal
   memcpy into memory_data. When identity mapping is active this is a
   no-op. */
void paged_mem_begin_init(void);
void paged_mem_end_init(void);

/* Tracking for memory.grow. When the guest grows, WAMR reallocates
   memory_data; the paged layer needs to update g_logical_pages and
   potentially remap. In identity mode, just refresh g_hot_base. */
void paged_mem_on_grow(uint8_t *wamr_memory_data,
                       uint32_t old_pages, uint32_t new_pages);

#endif
