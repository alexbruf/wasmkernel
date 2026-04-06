/*
 * WasmKernel cooperative scheduler
 *
 * Manages guest threads on a single host thread using round-robin
 * scheduling with fuel-based preemption.
 */

#include "scheduler.h"
#include "bh_platform.h"
#include "wasm_export.h"
#include "wasm_exec_env.h"
#include "wasm_suspend_flags.h"

#include <string.h>
#include <stdio.h>
#include <time.h>

/* Global scheduler instance */
WasmKernelScheduler g_scheduler;

static uint64_t
get_time_us(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000ULL + (uint64_t)ts.tv_nsec / 1000;
}

void
wasmkernel_scheduler_init(void)
{
    memset(&g_scheduler, 0, sizeof(g_scheduler));
    g_scheduler.fuel_per_slice = WASMKERNEL_DEFAULT_FUEL;
    g_scheduler.next_tid = 1;
}

int32_t
wasmkernel_scheduler_add_main(wasm_exec_env_t exec_env)
{
    WasmKernelThread *t = &g_scheduler.threads[0];
    t->exec_env = exec_env;
    t->tid = 0; /* main thread */
    t->state = THREAD_READY;
    t->started = false;
    t->start_routine = NULL;
    t->start_arg = NULL;
    g_scheduler.num_threads = 1;
    return 0;
}

int32_t
wasmkernel_scheduler_register_thread(wasm_exec_env_t exec_env,
                                     void *(*start_routine)(void *),
                                     void *arg)
{
    if (g_scheduler.num_threads >= WASMKERNEL_MAX_THREADS)
        return -1;

    int32_t tid = g_scheduler.next_tid++;
    uint32_t idx = g_scheduler.num_threads++;

    WasmKernelThread *t = &g_scheduler.threads[idx];
    t->exec_env = exec_env;
    t->tid = tid;
    t->state = THREAD_READY;
    t->started = false;
    t->start_routine = start_routine;
    t->start_arg = arg;
    t->wait_address = NULL;

    return tid;
}

void
wasmkernel_scheduler_block_on_wait(wasm_exec_env_t exec_env,
                                   void *addr, int64_t timeout_us)
{
    /* Find the thread for this exec_env */
    for (uint32_t i = 0; i < g_scheduler.num_threads; i++) {
        WasmKernelThread *t = &g_scheduler.threads[i];
        if (t->exec_env == exec_env) {
            t->state = THREAD_BLOCKED_WAIT;
            t->wait_address = addr;
            t->wait_timeout_us = timeout_us;
            t->wait_start_us = get_time_us();

            /* Set YIELD flag to cause interpreter to return */
            WASM_SUSPEND_FLAGS_FETCH_OR(exec_env->suspend_flags,
                                        WASM_SUSPEND_FLAG_YIELD);
            return;
        }
    }
}

uint32_t
wasmkernel_scheduler_wake_waiters(void *addr, uint32_t count)
{
    uint32_t woken = 0;

    for (uint32_t i = 0; i < g_scheduler.num_threads && woken < count; i++) {
        WasmKernelThread *t = &g_scheduler.threads[i];
        if (t->state == THREAD_BLOCKED_WAIT && t->wait_address == addr) {
            t->state = THREAD_READY;
            t->wait_address = NULL;
            woken++;
        }
    }

    return woken;
}

/* Host I/O bridge imports */
__attribute__((import_module("host"), import_name("host_io_check")))
extern uint32_t host_io_check(uint32_t callback_id);

__attribute__((import_module("host"), import_name("host_io_result_bytes")))
extern uint32_t host_io_result_bytes(uint32_t callback_id);

__attribute__((import_module("host"), import_name("host_io_result_error")))
extern uint32_t host_io_result_error(uint32_t callback_id);

/* Check wait timeouts */
static void
check_wait_timeouts(void)
{
    uint64_t now = get_time_us();

    for (uint32_t i = 0; i < g_scheduler.num_threads; i++) {
        WasmKernelThread *t = &g_scheduler.threads[i];
        if (t->state == THREAD_BLOCKED_WAIT && t->wait_timeout_us >= 0) {
            uint64_t elapsed = now - t->wait_start_us;
            if (elapsed >= (uint64_t)t->wait_timeout_us) {
                t->state = THREAD_READY;
                t->wait_address = NULL;
            }
        }
    }
}

/* Check I/O completions */
static void
check_io_completions(void)
{
    uint64_t now = get_time_us();

    for (uint32_t i = 0; i < g_scheduler.num_threads; i++) {
        WasmKernelThread *t = &g_scheduler.threads[i];
        if (t->state != THREAD_BLOCKED_IO)
            continue;

        if (t->io_op_type == IO_OP_POLL_CLOCK) {
            /* Internal timer — check deadline */
            if (now >= t->io_deadline_us) {
                /* Write poll_oneoff event to guest memory */
                if (t->io_event_out_ptr && t->exec_env) {
                    wasm_module_inst_t inst =
                        wasm_runtime_get_module_inst(t->exec_env);
                    /* event struct: userdata(8) + error(2) + type(1) + pad(5) + fd_readwrite(16) = 32 bytes */
                    uint8_t *evt = (uint8_t *)wasm_runtime_addr_app_to_native(
                        inst, (uint64_t)t->io_event_out_ptr);
                    if (evt) {
                        memset(evt, 0, 32);
                        memcpy(evt, &t->io_userdata, 8); /* userdata */
                        /* error = 0, type = 0 (clock) — already zeroed */
                    }
                    uint32_t *nev = (uint32_t *)wasm_runtime_addr_app_to_native(
                        inst, (uint64_t)t->io_nevents_ptr);
                    if (nev) *nev = 1;
                }
                t->state = THREAD_READY;
                t->io_op_type = IO_OP_NONE;
            }
        } else if (t->io_op_type == IO_OP_READ || t->io_op_type == IO_OP_WRITE) {
            /* Host async I/O — poll the host */
            if (host_io_check(t->io_callback_id)) {
                uint32_t bytes = host_io_result_bytes(t->io_callback_id);
                uint32_t error = host_io_result_error(t->io_callback_id);

                /* Write nread/nwritten to guest memory */
                if (t->io_result_ptr && t->exec_env) {
                    wasm_module_inst_t inst =
                        wasm_runtime_get_module_inst(t->exec_env);
                    uint32_t *nrw = (uint32_t *)wasm_runtime_addr_app_to_native(
                        inst, (uint64_t)t->io_result_ptr);
                    if (nrw) *nrw = bytes;
                }
                t->io_wasi_errno = (int32_t)error;
                t->state = THREAD_READY;
                t->io_op_type = IO_OP_NONE;
            }
        }
    }
}

/* Find next READY thread (round-robin) */
static WasmKernelThread *
pick_next_thread(void)
{
    uint32_t n = g_scheduler.num_threads;
    if (n == 0)
        return NULL;

    for (uint32_t i = 0; i < n; i++) {
        uint32_t idx = (g_scheduler.current + i) % n;
        WasmKernelThread *t = &g_scheduler.threads[idx];
        if (t->state == THREAD_READY) {
            g_scheduler.current = (idx + 1) % n;
            return t;
        }
    }

    return NULL;
}

/* Check if all threads have exited */
static bool
all_threads_exited(void)
{
    for (uint32_t i = 0; i < g_scheduler.num_threads; i++) {
        if (g_scheduler.threads[i].state != THREAD_EXITED
            && g_scheduler.threads[i].state != THREAD_UNUSED)
            return false;
    }
    return true;
}

/* Check if any non-exited threads exist */
static bool
has_live_threads(void)
{
    for (uint32_t i = 0; i < g_scheduler.num_threads; i++) {
        WasmKernelThreadState s = g_scheduler.threads[i].state;
        if (s != THREAD_EXITED && s != THREAD_UNUSED)
            return true;
    }
    return false;
}

/* Terminate all threads (for trap/proc_exit propagation) */
static void
terminate_all_threads(void)
{
    for (uint32_t i = 0; i < g_scheduler.num_threads; i++) {
        WasmKernelThread *t = &g_scheduler.threads[i];
        if (t->state != THREAD_EXITED && t->state != THREAD_UNUSED) {
            t->state = THREAD_EXITED;
            if (t->exec_env) {
                WASM_SUSPEND_FLAGS_FETCH_OR(
                    t->exec_env->suspend_flags,
                    WASM_SUSPEND_FLAG_TERMINATE);
            }
        }
    }
}

int32_t
wasmkernel_scheduler_step(void)
{
    if (!has_live_threads())
        return 1; /* all done */

    /* Check wait timeouts and I/O completions */
    check_wait_timeouts();
    check_io_completions();

    /* Pick next ready thread */
    WasmKernelThread *thread = pick_next_thread();

    if (!thread) {
        /* All threads blocked — check if any could ever wake */
        if (all_threads_exited())
            return 1;
        /* Deadlock or waiting for I/O — return 0 to let host wait */
        return 0;
    }

    thread->state = THREAD_RUNNING;

    /* Set fuel for this time slice */
    if (thread->exec_env)
        thread->exec_env->instructions_to_execute = g_scheduler.fuel_per_slice;

    /* Clear yield flag before running */
    WASM_SUSPEND_FLAGS_FETCH_AND(thread->exec_env->suspend_flags,
                                 ~WASM_SUSPEND_FLAG_YIELD);

    if (!thread->started) {
        /* First run */
        thread->started = true;

        wasm_module_inst_t inst = wasm_runtime_get_module_inst(
            thread->exec_env);

        if (thread->start_routine) {
            /* Spawned thread: call wasi_thread_start directly via
               wasm_runtime_call_wasm (not through lib-wasi-threads's
               thread_start, which doesn't handle yield/resume).
               The ThreadStartArg is stored in exec_env->thread_arg. */
            wasm_function_inst_t wasi_start =
                wasm_runtime_lookup_function(inst, "wasi_thread_start");
            void *targ = thread->exec_env->thread_arg;
            if (wasi_start && targ) {
                /* ThreadStartArg: { func_ptr(4), arg(4), thread_id(4) } */
                uint32_t arg = *(uint32_t *)((char *)targ + 4);
                int32_t tid = *(int32_t *)((char *)targ + 8);
                uint32_t argv[2] = { (uint32_t)tid, arg };
                wasm_exec_env_set_thread_info(thread->exec_env);
                wasm_runtime_call_wasm(thread->exec_env, wasi_start, 2, argv);
            } else {
                /* Fallback: call start_routine directly (old behavior) */
                thread->start_routine(thread->exec_env);
            }
        } else {
            /* Main thread: look up entry point */
            wasm_function_inst_t start_func =
                wasm_runtime_lookup_function(inst, "_start");
            if (!start_func)
                start_func = wasm_runtime_lookup_function(inst, "_initialize");
            if (start_func) {
                wasm_runtime_call_wasm(thread->exec_env, start_func, 0, NULL);
            } else {
                wasm_application_execute_main(inst, 0, NULL);
            }
        }
    } else {
        /* Resume from yield: call wasm_runtime_call_wasm which detects
           YIELD flag... but we cleared it. We need to re-enter the
           interpreter. The YIELD flag was set when the interpreter returned,
           and it's still set on exec_env. We cleared it above because
           wasm_interp_call_wasm checks it for resume.

           Actually, we need to SET the YIELD flag again so the resume
           path is taken in wasm_interp_call_wasm. */
        WASM_SUSPEND_FLAGS_FETCH_OR(thread->exec_env->suspend_flags,
                                     WASM_SUSPEND_FLAG_YIELD);

        wasm_module_inst_t inst = wasm_runtime_get_module_inst(
            thread->exec_env);
        /* Function arg doesn't matter for resume (YIELD flag causes
           interpreter to restore from saved frame). Try multiple names. */
        wasm_function_inst_t func =
            wasm_runtime_lookup_function(inst, "_start");
        if (!func)
            func = wasm_runtime_lookup_function(inst, "wasi_thread_start");
        if (!func)
            func = wasm_runtime_lookup_function(inst, "__main_argc_argv");
        if (func)
            wasm_runtime_call_wasm(thread->exec_env, func, 0, NULL);
    }

    /* Determine what happened */
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(thread->exec_env);

    /* Check proc_exit flag (set by WASI handler, may be on any thread) */
    if (g_scheduler.exited_via_proc_exit) {
        terminate_all_threads();
        return -2;
    }

    /* Check if yielded (fuel exhausted or atomic.wait) */
    if (thread->exec_env
        && (WASM_SUSPEND_FLAGS_GET(thread->exec_env->suspend_flags)
            & WASM_SUSPEND_FLAG_YIELD)) {
        /* Thread yielded — it's already READY or BLOCKED_WAIT */
        if (thread->state == THREAD_RUNNING)
            thread->state = THREAD_READY;
        return 0; /* still running */
    }

    /* Check for exception/trap */
    const char *exc = wasm_runtime_get_exception(inst);
    if (exc) {
        /* Check if it's our proc_exit marker */
        if (strcmp(exc, "proc_exit") == 0) {
            wasm_runtime_clear_exception(inst);
            g_scheduler.exited_via_proc_exit = true;
            terminate_all_threads();
            return -2;
        }
        /* Real trap — kill all threads */
        g_scheduler.has_trap = true;
        terminate_all_threads();
        return -1;
    }

    /* Thread returned normally */
    thread->state = THREAD_EXITED;

    if (all_threads_exited())
        return 1; /* all done */

    return 0; /* other threads still running */
}

uint32_t
wasmkernel_scheduler_block_on_io(wasm_exec_env_t exec_env,
                                  uint32_t op_type, uint32_t result_ptr)
{
    uint32_t cb_id = ++g_scheduler.next_callback_id;

    for (uint32_t i = 0; i < g_scheduler.num_threads; i++) {
        WasmKernelThread *t = &g_scheduler.threads[i];
        if (t->exec_env == exec_env) {
            t->state = THREAD_BLOCKED_IO;
            t->io_callback_id = cb_id;
            t->io_op_type = op_type;
            t->io_result_ptr = result_ptr;
            t->io_wasi_errno = 0;

            WASM_SUSPEND_FLAGS_FETCH_OR(exec_env->suspend_flags,
                                        WASM_SUSPEND_FLAG_YIELD);
            return cb_id;
        }
    }
    return 0;
}

void
wasmkernel_scheduler_block_on_poll_clock(wasm_exec_env_t exec_env,
                                          uint64_t deadline_us,
                                          uint32_t event_out_ptr,
                                          uint32_t nevents_ptr,
                                          uint64_t userdata)
{
    for (uint32_t i = 0; i < g_scheduler.num_threads; i++) {
        WasmKernelThread *t = &g_scheduler.threads[i];
        if (t->exec_env == exec_env) {
            t->state = THREAD_BLOCKED_IO;
            t->io_op_type = IO_OP_POLL_CLOCK;
            t->io_deadline_us = deadline_us;
            t->io_event_out_ptr = event_out_ptr;
            t->io_nevents_ptr = nevents_ptr;
            t->io_userdata = userdata;

            WASM_SUSPEND_FLAGS_FETCH_OR(exec_env->suspend_flags,
                                        WASM_SUSPEND_FLAG_YIELD);
            return;
        }
    }
}

bool
wasmkernel_scheduler_should_yield(wasm_exec_env_t exec_env)
{
    return (WASM_SUSPEND_FLAGS_GET(exec_env->suspend_flags)
            & WASM_SUSPEND_FLAG_YIELD) != 0;
}
