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

    /* In-place swap model: the "hot window" IS WAMR's memory_data. Slot
     * index = logical page index (no remapping). The page table degenerates
     * into a residency bitmap — g_page_table[i] is either i (resident) or
     * INVALID (cold). Eviction zeros the page region in memory_data after
     * flushing to backend; fault reads the page back from backend into its
     * natural offset.
     *
     * This avoids the separate hot-window allocation — which required
     * patching every WAMR code path that range-checks native pointers
     * against [memory_data, memory_data_end). Keeping memory_data as the
     * single source of truth means all those paths keep working without
     * modification.
     *
     * RSS savings come from zeroing evicted pages so V8 can release them.
     * On platforms where V8 doesn't decommit on write-zeros (some CF
     * Workers configurations), RSS stays at peak working set; paging
     * still enables correctness for guests whose logical memory exceeds
     * the platform's reservation cap. */
    g_paging_active = true;
    g_hot_base = wamr_memory_data;
    g_hot_window_pages = initial_logical_pages;  /* not a cap; bookkeeping */
    for (uint32_t i = 0; i < PAGED_MEM_MAX_LOGICAL_PAGES; i++)
        g_page_table[i] = PAGED_MEM_INVALID_SLOT;
    for (uint32_t i = 0; i < PAGED_MEM_MAX_HOT_SLOTS; i++)
        g_slot_to_page[i] = 0xFFFFFFFFu;
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
    if (slot >= PAGED_MEM_MAX_LOGICAL_PAGES) {
        fprintf(stderr, "paged_mem_fault: host returned invalid slot %u\n",
                slot);
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

uint8_t *
paged_mem_cross_page(uint64_t offset, uint32_t bytes)
{
    /* In the in-place swap model, g_hot_base == memory_data and slot N
       lives at memory_data + N*64KB. Logical pages are CONTIGUOUS in the
       backing buffer, so a cross-page access is just a normal linear
       read/write — but only if both pages are resident. Fault in both
       pages, then return the natural contiguous pointer. */
    uint32_t pg0 = (uint32_t)(offset >> 16);
    uint32_t pg1 = (uint32_t)((offset + bytes - 1) >> 16);
    for (uint32_t p = pg0; p <= pg1; p++) {
        if (g_page_table[p] == PAGED_MEM_INVALID_SLOT) {
            (void)paged_mem_fault(p);
        }
    }
    return g_hot_base + offset;
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
