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

/* I/O operation types */
#define IO_OP_NONE        0
#define IO_OP_READ        1
#define IO_OP_WRITE       2
#define IO_OP_POLL_CLOCK  3  /* internal timer, no host involvement */
#define IO_OP_POLL_FD     4  /* fd readiness check via host */

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

    /* Asyncify data buffer for yield/resume.
       Only used when a blocking host call (sched_yield, wait32 from inside
       kernel_call_indirect) needs to suspend mid-execution. Pure fuel
       exhaustion uses the YIELD flag mechanism without asyncify. */
    uint8_t asyncify_buf[4096];
    bool asyncify_unwound; /* true if last yield used asyncify_start_unwind */

    /* For async I/O (THREAD_BLOCKED_IO) */
    uint32_t io_callback_id;
    uint32_t io_op_type;       /* IO_OP_* */
    uint64_t io_deadline_us;   /* for poll_oneoff clock */
    uint32_t io_result_ptr;    /* guest-memory ptr to write nread/nwritten */
    uint32_t io_event_out_ptr; /* guest-memory ptr for poll_oneoff events */
    uint32_t io_nevents_ptr;   /* guest-memory ptr for poll_oneoff nevents */
    uint64_t io_userdata;      /* poll_oneoff userdata to echo back */
    int32_t  io_wasi_errno;    /* WASI errno to return when unblocked */
} WasmKernelThread;

typedef struct WasmKernelScheduler {
    WasmKernelThread threads[WASMKERNEL_MAX_THREADS];
    uint32_t num_threads;
    uint32_t current;          /* round-robin index */
    uint32_t fuel_per_slice;
    int32_t next_tid;
    uint32_t next_callback_id; /* for async I/O */
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

/* Block the current thread on async I/O. Returns callback_id. */
uint32_t
wasmkernel_scheduler_block_on_io(wasm_exec_env_t exec_env,
                                  uint32_t op_type, uint32_t result_ptr);

/* Block the current thread on poll_oneoff clock timeout. */
void
wasmkernel_scheduler_block_on_poll_clock(wasm_exec_env_t exec_env,
                                          uint64_t deadline_us,
                                          uint32_t event_out_ptr,
                                          uint32_t nevents_ptr,
                                          uint64_t userdata);

/* Reset the main thread (index 0) back to READY state.
   Used by kernel_call_indirect_simple to clean up after calls that
   triggered cooperative scheduling (e.g. sleep → poll_oneoff → BLOCKED_IO). */
void
wasmkernel_scheduler_reset_main_thread(void);

/* Check if a thread is in yield state (called from atomic wait/notify
   to determine if we should yield back to scheduler) */
bool
wasmkernel_scheduler_should_yield(wasm_exec_env_t exec_env);

#ifdef __cplusplus
}
#endif

#endif /* _WASMKERNEL_SCHEDULER_H */
