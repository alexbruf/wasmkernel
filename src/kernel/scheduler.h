/*
 * WasmKernel cooperative scheduler
 *
 * Manages guest threads on a single host thread using round-robin
 * scheduling with fuel-based preemption.
 */

#ifndef _WASMKERNEL_SCHEDULER_H
#define _WASMKERNEL_SCHEDULER_H

#include "wasm_export.h"
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define WASMKERNEL_MAX_THREADS 64
#define WASMKERNEL_DEFAULT_FUEL 10000

typedef enum {
    THREAD_UNUSED = 0,
    THREAD_READY,
    THREAD_RUNNING,
    THREAD_BLOCKED_WAIT,
    THREAD_BLOCKED_IO,
    THREAD_EXITED
} WasmKernelThreadState;

typedef struct WasmKernelThread {
    wasm_exec_env_t exec_env;
    int32_t tid;
    WasmKernelThreadState state;
    bool started;

    /* For atomic.wait */
    void *wait_address;
    int64_t wait_timeout_us;  /* -1 = infinite */
    uint64_t wait_start_us;

    /* Thread start info */
    void *(*start_routine)(void *);
    void *start_arg;
} WasmKernelThread;

typedef struct WasmKernelScheduler {
    WasmKernelThread threads[WASMKERNEL_MAX_THREADS];
    uint32_t num_threads;
    uint32_t current;          /* round-robin index */
    uint32_t fuel_per_slice;
    int32_t next_tid;
    bool has_trap;
    int32_t exit_code;
    bool exited_via_proc_exit;
} WasmKernelScheduler;

/* Global scheduler instance */
extern WasmKernelScheduler g_scheduler;

/* Initialize the scheduler */
void
wasmkernel_scheduler_init(void);

/* Add the main thread (_start) */
int32_t
wasmkernel_scheduler_add_main(wasm_exec_env_t exec_env);

/* Register a new thread (called from thread_manager.c intercept).
   Returns the thread's TID (used as handle). */
int32_t
wasmkernel_scheduler_register_thread(wasm_exec_env_t exec_env,
                                     void *(*start_routine)(void *),
                                     void *arg);

/* Run one scheduler tick.
   Returns: 0 = still running, 1 = all done, -1 = trap, -2 = proc_exit */
int32_t
wasmkernel_scheduler_step(void);

/* Block the current thread on atomic.wait */
void
wasmkernel_scheduler_block_on_wait(wasm_exec_env_t exec_env,
                                   void *addr, int64_t timeout_us);

/* Wake threads blocked on an address. Returns number woken. */
uint32_t
wasmkernel_scheduler_wake_waiters(void *addr, uint32_t count);

/* Check if a thread is in yield state (called from atomic wait/notify
   to determine if we should yield back to scheduler) */
bool
wasmkernel_scheduler_should_yield(wasm_exec_env_t exec_env);

#ifdef __cplusplus
}
#endif

#endif /* _WASMKERNEL_SCHEDULER_H */
