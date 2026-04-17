/*
 * Copyright (C) 2024 WasmKernel contributors.
 * SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
 *
 * Platform layer for wasm32-wasi: stubs all OS APIs against wasi-libc.
 * Single-threaded cooperative scheduling — all mutex/thread ops are no-ops.
 */

#include "platform_api_vmcore.h"
#include "platform_api_extension.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <time.h>

/* ===== Section: Platform init/destroy ===== */

int
bh_platform_init(void)
{
    return 0;
}

void
bh_platform_destroy(void)
{
}

/* ===== Section: Memory allocator ===== */

void *
os_malloc(unsigned size)
{
    return malloc(size);
}

void *
os_realloc(void *ptr, unsigned size)
{
    return realloc(ptr, size);
}

void
os_free(void *ptr)
{
    free(ptr);
}

/* ===== Section: Printing ===== */

int
os_printf(const char *format, ...)
{
    int ret;
    va_list ap;
    va_start(ap, format);
    ret = vprintf(format, ap);
    va_end(ap);
    return ret;
}

int
os_vprintf(const char *format, va_list ap)
{
    return vprintf(format, ap);
}

/* ===== Section: Time ===== */

uint64
os_time_get_boot_us(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64)ts.tv_sec * 1000000 + (uint64)ts.tv_nsec / 1000;
}

uint64
os_time_thread_cputime_us(void)
{
    /* No per-thread CPU time in WASI, use monotonic */
    return os_time_get_boot_us();
}

/* ===== Section: Thread identity ===== */

korp_tid
os_self_thread(void)
{
    return 0;
}

uint8 *
os_thread_get_stack_boundary(void)
{
    return NULL;
}

void
os_thread_jit_write_protect_np(bool enabled)
{
    (void)enabled;
}

/* ===== Section: Mutex (no-op, single-threaded) ===== */

int
os_mutex_init(korp_mutex *mutex)
{
    (void)mutex;
    return BHT_OK;
}

int
os_mutex_destroy(korp_mutex *mutex)
{
    (void)mutex;
    return BHT_OK;
}

int
os_mutex_lock(korp_mutex *mutex)
{
    (void)mutex;
    return BHT_OK;
}

int
os_mutex_unlock(korp_mutex *mutex)
{
    (void)mutex;
    return BHT_OK;
}

int
os_recursive_mutex_init(korp_mutex *mutex)
{
    (void)mutex;
    return BHT_OK;
}

/* ===== Section: Memory mapping (malloc-based) ===== */

void *
os_mmap(void *hint, size_t size, int prot, int flags, os_file_handle file)
{
    (void)hint;
    (void)prot;
    (void)flags;
    (void)file;

    if (size == 0)
        return NULL;

    /* Previously: malloc(size) + memset(p, 0, size).
     *
     * The memset touched every page of the allocation, which forced V8
     * to physically commit the whole region at instantiate time — for
     * a 1004-page guest that's 64 MB of RSS immediately, blowing past
     * CF's 128 MB isolate cap.
     *
     * Omitting the memset is safe: kernel.wasm's WebAssembly.Memory is
     * zero-initialized by V8 when grown via memory.grow, so freshly-
     * allocated pages from dlmalloc (which ultimately came from a
     * memory.grow when the heap last extended) are already zero. We
     * only recycle allocations after explicit free; none of the paths
     * that reach wasm_mmap_linear_memory (guest memory allocate, shared
     * heap allocate) free before reallocating, so recycled-dirty-pages
     * isn't a hazard for them.
     *
     * If we later find a caller that DOES recycle and needs zero-init,
     * add a separate os_mmap_zeroed() and update that specific caller
     * rather than re-committing the whole region here. */
    return malloc(size);
}

void
os_munmap(void *addr, size_t size)
{
    (void)size;
    free(addr);
}

int
os_mprotect(void *addr, size_t size, int prot)
{
    (void)addr;
    (void)size;
    (void)prot;
    return 0;
}

void *
os_mremap(void *old_addr, size_t old_size, size_t new_size)
{
    (void)old_size;
    return realloc(old_addr, new_size);
}

void
os_dcache_flush(void)
{
}

void
os_icache_flush(void *start, size_t len)
{
    (void)start;
    (void)len;
}

/* ===== Section: Threading (stubs — single-threaded) ===== */

int
os_thread_create(korp_tid *p_tid, thread_start_routine_t start, void *arg,
                 unsigned int stack_size)
{
    (void)p_tid;
    (void)start;
    (void)arg;
    (void)stack_size;
    return BHT_ERROR;
}

int
os_thread_create_with_prio(korp_tid *p_tid, thread_start_routine_t start,
                           void *arg, unsigned int stack_size, int prio)
{
    (void)prio;
    return os_thread_create(p_tid, start, arg, stack_size);
}

int
os_thread_join(korp_tid thread, void **retval)
{
    (void)thread;
    (void)retval;
    return BHT_ERROR;
}

int
os_thread_detach(korp_tid thread)
{
    (void)thread;
    return BHT_ERROR;
}

void
os_thread_exit(void *retval)
{
    (void)retval;
}

int
os_thread_env_init(void)
{
    return BHT_OK;
}

void
os_thread_env_destroy(void)
{
}

bool
os_thread_env_inited(void)
{
    return true;
}

/* ===== Section: Condition variables (no-op) ===== */

int
os_cond_init(korp_cond *cond)
{
    (void)cond;
    return BHT_OK;
}

int
os_cond_destroy(korp_cond *cond)
{
    (void)cond;
    return BHT_OK;
}

int
os_cond_wait(korp_cond *cond, korp_mutex *mutex)
{
    (void)cond;
    (void)mutex;
    return BHT_OK;
}

int
os_cond_reltimedwait(korp_cond *cond, korp_mutex *mutex, uint64 useconds)
{
    (void)cond;
    (void)mutex;
    (void)useconds;
    return BHT_TIMED_OUT;
}

int
os_cond_signal(korp_cond *cond)
{
    (void)cond;
    return BHT_OK;
}

int
os_cond_broadcast(korp_cond *cond)
{
    (void)cond;
    return BHT_OK;
}

/* ===== Section: Read-write locks (no-op) ===== */

int
os_rwlock_init(korp_rwlock *lock)
{
    (void)lock;
    return BHT_OK;
}

int
os_rwlock_rdlock(korp_rwlock *lock)
{
    (void)lock;
    return BHT_OK;
}

int
os_rwlock_wrlock(korp_rwlock *lock)
{
    (void)lock;
    return BHT_OK;
}

int
os_rwlock_unlock(korp_rwlock *lock)
{
    (void)lock;
    return BHT_OK;
}

int
os_rwlock_destroy(korp_rwlock *lock)
{
    (void)lock;
    return BHT_OK;
}

/* ===== Section: Semaphores (stub) ===== */

int
os_sem_close(korp_sem *sem)
{
    (void)sem;
    return BHT_OK;
}

int
os_sem_wait(korp_sem *sem)
{
    (void)sem;
    return BHT_OK;
}

int
os_sem_trywait(korp_sem *sem)
{
    (void)sem;
    return BHT_OK;
}

int
os_sem_post(korp_sem *sem)
{
    (void)sem;
    return BHT_OK;
}

int
os_sem_getvalue(korp_sem *sem, int *sval)
{
    (void)sem;
    if (sval)
        *sval = 0;
    return BHT_OK;
}

int
os_sem_unlink(const char *name)
{
    (void)name;
    return BHT_OK;
}

/* ===== Section: Blocking ops (no-op) ===== */

int
os_blocking_op_init(void)
{
    return BHT_OK;
}

void
os_begin_blocking_op(void)
{
}

void
os_end_blocking_op(void)
{
}

int
os_wakeup_blocking_op(korp_tid tid)
{
    (void)tid;
    return BHT_OK;
}

/* ===== Section: Misc ===== */

int
os_usleep(uint32 usec)
{
    (void)usec;
    return 0;
}

int
os_dumps_proc_mem_info(char *out, unsigned int size)
{
    (void)out;
    (void)size;
    return 0;
}
