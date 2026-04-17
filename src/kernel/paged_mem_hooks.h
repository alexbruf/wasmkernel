/*
 * Paged-memory overrides for WAMR's CHECK_MEMORY_OVERFLOW and
 * CHECK_BULK_MEMORY_OVERFLOW macros. Force-included into
 * wasm_interp_classic.c and wasm_interp_fast.c via the build system.
 *
 * Strategy: the WAMR source files #define both macros near the top of
 * the file. We let WAMR's definitions land, then emit `#include` on
 * this header AFTER them. Since CMake's `-include` only supports
 * pre-inclusion, we instead patch the WAMR sources to `#include
 * "paged_mem_hooks.h"` at the right point (after the original
 * #defines). See CMakeLists for the sed invocation.
 *
 * This header undefines WAMR's originals and installs paged versions
 * that look up the logical page in g_page_table. On a hit, maddr is
 * computed as g_hot_base + slot*65536 + (offset & 0xFFFF). On a miss,
 * we call paged_mem_fault() which drives the host to bring in the
 * page. Bounds checks against logical size are preserved; the hot
 * window's physical size is not exposed to the guest.
 */
#ifndef WASMKERNEL_PAGED_MEM_HOOKS_H
#define WASMKERNEL_PAGED_MEM_HOOKS_H

#include <stdint.h>

/* Forward declarations — defined in src/kernel/paged_mem.c */
#include <stdbool.h>
extern uint8_t *g_hot_base;
extern uint16_t g_page_table[];
extern uint32_t g_logical_pages;
extern bool     g_paging_active;

uint32_t paged_mem_fault(uint32_t logical_page);
uint8_t *paged_mem_cross_page(uint64_t offset, uint32_t bytes);
void     paged_mem_flush_cross_scratch(void);

/* Replace WAMR's macros. Both files' active branch is the
   !OS_ENABLE_HW_BOUND_CHECK / WASM_ENABLE_MEMORY64==0 variant (we have
   WAMR_DISABLE_HW_BOUND_CHECK=1 and WAMR_BUILD_MEMORY64=0 in CMakeLists). */
#undef CHECK_MEMORY_OVERFLOW
#undef CHECK_BULK_MEMORY_OVERFLOW

/* Fast path: page-table lookup for a range that fits in one logical page.
   Slow path: paged_mem_cross_page() assembles a scratch buffer.
   The bounds check uses the logical size, via WAMR's get_linear_mem_size()
   which in our build is the memory instance's size (we keep cur_page_count
   in sync with g_logical_pages via paged_mem_on_grow). */
/* `memory` is in scope at every call site (a local of type
   WASMMemoryInstance* in wasm_interp_call_func_bytecode). Until the
   kernel finishes paged_mem_on_instantiate (which happens AFTER
   wasm_runtime_instantiate returns), g_hot_base is NULL — we fall back
   to WAMR's direct memory_data access so the instantiate path (data
   segment init expressions, start functions) keeps working. */
#define CHECK_MEMORY_OVERFLOW(bytes)                                           \
    do {                                                                       \
        uint64 _ofs = (uint64)offset + (uint64)addr;                           \
        CHECK_SHARED_HEAP_OVERFLOW(_ofs, bytes, maddr)                         \
        if (!(disable_bounds_checks || _ofs + (bytes) <= get_linear_mem_size())) \
            goto out_of_bounds;                                                \
        if (g_hot_base == NULL) {                                              \
            maddr = memory->memory_data + _ofs;                                \
        } else {                                                               \
            paged_mem_flush_cross_scratch();                                   \
            uint32_t _pg = (uint32_t)(_ofs >> 16);                             \
            uint32_t _po = (uint32_t)(_ofs & 0xFFFFu);                         \
            uint16_t _slot = g_page_table[_pg];                                \
            if (_slot == 0xFFFFu)                                              \
                _slot = (uint16_t)paged_mem_fault(_pg);                        \
            if (g_paging_active && _po + (bytes) > 65536) {                    \
                maddr = paged_mem_cross_page(_ofs, (uint32_t)(bytes));         \
                if (!maddr) goto out_of_bounds;                                \
            } else {                                                           \
                maddr = g_hot_base + ((uintptr_t)_slot << 16) + _po;           \
            }                                                                  \
        }                                                                      \
    } while (0)

#define CHECK_BULK_MEMORY_OVERFLOW(start, bytes, _maddr_out)                   \
    do {                                                                       \
        uint64 _ofs = (uint32)(start);                                         \
        CHECK_SHARED_HEAP_OVERFLOW(_ofs, bytes, _maddr_out)                    \
        if (!(disable_bounds_checks || _ofs + (bytes) <= get_linear_mem_size())) \
            goto out_of_bounds;                                                \
        if (g_hot_base == NULL) {                                              \
            (_maddr_out) = memory->memory_data + _ofs;                         \
        } else {                                                               \
            paged_mem_flush_cross_scratch();                                   \
            uint32_t _pg = (uint32_t)(_ofs >> 16);                             \
            uint32_t _po = (uint32_t)(_ofs & 0xFFFFu);                         \
            uint16_t _slot = g_page_table[_pg];                                \
            if (_slot == 0xFFFFu)                                              \
                _slot = (uint16_t)paged_mem_fault(_pg);                        \
            if (g_paging_active && _po + (bytes) > 65536) {                                       \
                (_maddr_out) = paged_mem_cross_page(_ofs, (uint32_t)(bytes));  \
                if (!(_maddr_out)) goto out_of_bounds;                         \
            } else {                                                           \
                (_maddr_out) = g_hot_base + ((uintptr_t)_slot << 16) + _po;    \
            }                                                                  \
        }                                                                      \
    } while (0)

#endif
