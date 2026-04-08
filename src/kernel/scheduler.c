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
#include "thread_manager.h"

#include <string.h>
#include <stdio.h>
#include <time.h>
#include <errno.h>

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

/* Get asyncify data buffer for the thread owning this exec_env.
   Returns NULL for the main thread during kernel_step (uses old YIELD).
   Returns buffer for main thread during kernel_call_indirect (needs
   asyncify for multi-depth calls like pthread_create → wait32). */
bool g_main_thread_asyncify_enabled = false;

void *
wasmkernel_get_asyncify_buf(wasm_exec_env_t exec_env)
{
    for (uint32_t i = 0; i < g_scheduler.num_threads; i++) {
        if (g_scheduler.threads[i].exec_env == exec_env) {
            if (i == 0 && !g_main_thread_asyncify_enabled) return NULL;
            uint8_t *buf = g_scheduler.threads[i].asyncify_buf;
            uint32_t *header = (uint32_t *)buf;
            header[0] = (uint32_t)(uintptr_t)(buf + 8);
            header[1] = (uint32_t)(uintptr_t)(buf + 4096);
            /* Mark that this thread is unwinding via asyncify so the scheduler
               knows to use asyncify_start_rewind on resume (rather than the
               YIELD flag fast path). */
            g_scheduler.threads[i].asyncify_unwound = true;
            return buf;
        }
    }
    return NULL;
}

int32_t
wasmkernel_scheduler_register_thread(wasm_exec_env_t exec_env,
                                     void *(*start_routine)(void *),
                                     void *arg)
{
    /* Try to reclaim an exited slot before extending the table. Without
     * this, a long-running guest that spawns and joins many short-lived
     * threads would walk off the end of the slot array even though most
     * slots are dead. (WAMR's own thread manager uses live count for its
     * --max-threads check; our slot table just needs to keep up.) */
    uint32_t idx = WASMKERNEL_MAX_THREADS;
    for (uint32_t i = 0; i < g_scheduler.num_threads; i++) {
        if (g_scheduler.threads[i].state == THREAD_EXITED
            || g_scheduler.threads[i].state == THREAD_UNUSED) {
            idx = i;
            break;
        }
    }
    if (idx == WASMKERNEL_MAX_THREADS) {
        if (g_scheduler.num_threads >= WASMKERNEL_MAX_THREADS)
            return -1;
        idx = g_scheduler.num_threads++;
    }

    int32_t tid = g_scheduler.next_tid++;

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

/* Track addresses where notify fired but no thread was waiting */
#define MAX_PENDING_NOTIFIES 64
static void *g_pending_notify_addrs[MAX_PENDING_NOTIFIES];
static uint32_t g_pending_notify_count = 0;

void
wasmkernel_scheduler_block_on_wait(wasm_exec_env_t exec_env,
                                   void *addr, int64_t timeout_us)
{
    /* Check for pending notify on this address — if found, don't block */
    for (uint32_t i = 0; i < g_pending_notify_count; i++) {
        if (g_pending_notify_addrs[i] == addr) {
            /* Consume the pending notify */
            g_pending_notify_addrs[i] =
                g_pending_notify_addrs[--g_pending_notify_count];
            /* Still yield to give other threads a chance */
            WASM_SUSPEND_FLAGS_FETCH_OR(exec_env->suspend_flags,
                                        WASM_SUSPEND_FLAG_YIELD);
            return;
        }
    }

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

    /* If nobody was waiting, record as pending notify */
    if (woken == 0 && g_pending_notify_count < MAX_PENDING_NOTIFIES) {
        g_pending_notify_addrs[g_pending_notify_count++] = addr;
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

    /* Wall-clock watchdog: if the host set a deadline and we've passed
     * it, kill everything. This bounds how long a guest can hold the
     * scheduler before the host regains control, defending against
     * infinite loops and slow pathological workloads. The host resets
     * the deadline via kernel_set_watchdog_ms before each batch. */
    if (g_scheduler.watchdog_deadline_us != 0
        && get_time_us() > g_scheduler.watchdog_deadline_us) {
        g_scheduler.watchdog_tripped = true;
        g_scheduler.has_trap = true;
        terminate_all_threads();
        return -1;
    }

    /* Check wait timeouts and I/O completions */
    check_wait_timeouts();
    check_io_completions();

    /* Pick next ready thread */
    WasmKernelThread *thread = pick_next_thread();

    if (!thread) {
        /* All threads blocked — check if any could ever wake */
        if (all_threads_exited())
            return 1;

        /* Deadlock: no READY threads but some are BLOCKED_WAIT.
           Wake them all as spurious wakeups — musl/wasi-libc handles
           spurious returns from wait32 by rechecking conditions. */
        bool woke_any = false;
        for (uint32_t i = 0; i < g_scheduler.num_threads; i++) {
            WasmKernelThread *t = &g_scheduler.threads[i];
            if (t->state == THREAD_BLOCKED_WAIT) {
                t->state = THREAD_READY;
                t->wait_address = NULL;
                woke_any = true;
            }
        }
        if (woke_any) {
            thread = pick_next_thread();
        }
        if (!thread)
            return 0; /* truly stuck (I/O wait) */
    }

    thread->state = THREAD_RUNNING;

    /* Set fuel for this time slice */
    if (thread->exec_env) {
        thread->exec_env->instructions_to_execute = g_scheduler.fuel_per_slice;
        /* Enable spin yield only for spawned threads (not main thread) */
        thread->exec_env->_spin_yield_enabled = (thread->start_routine != NULL);
    }

    /* Note: do NOT clear the YIELD flag here. If set, it signals to the
       wasm interpreter that this is a resume from a previous yield, and
       it should continue from the saved frame instead of starting fresh.
       The YIELD path inside wasm_interp_call_wasm/wasm_interp_call_func_bytecode
       clears the flag itself once the saved state has been restored. */

    /* Asyncify functions (added by wasm-opt --asyncify post-build) */
    extern void asyncify_stop_unwind(void);
    extern void asyncify_start_rewind(void *data);
    extern void asyncify_stop_rewind(void);
    extern int asyncify_get_state(void);

    if (!thread->started) {
        /* First run */
        thread->started = true;

        wasm_module_inst_t inst = wasm_runtime_get_module_inst(
            thread->exec_env);

        if (thread->start_routine) {
            /* Spawned thread: call wasi_thread_start directly */
            wasm_function_inst_t wasi_start =
                wasm_runtime_lookup_function(inst, "wasi_thread_start");
            void *targ = thread->exec_env->thread_arg;
            if (wasi_start && targ) {
                uint32_t arg = *(uint32_t *)((char *)targ + 4);
                int32_t tid = *(int32_t *)((char *)targ + 8);
                uint32_t argv[2] = { (uint32_t)tid, arg };
                wasm_exec_env_set_thread_info(thread->exec_env);
                wasm_runtime_call_wasm(thread->exec_env, wasi_start, 2, argv);
            } else {
                thread->start_routine(thread->exec_env);
            }
        } else {
            /* Main thread: look up entry point. For reactor/library modules
             * (no _start and no _initialize), the wasm `start` section has
             * already run during instantiation and there's nothing else to
             * do — do NOT fall back to wasm_application_execute_main, which
             * sets a sticky "entry point symbol not found" exception that
             * poisons subsequent kernel_call invocations. */
            wasm_function_inst_t start_func =
                wasm_runtime_lookup_function(inst, "_start");
            if (!start_func)
                start_func = wasm_runtime_lookup_function(inst, "_initialize");
            if (start_func) {
                wasm_runtime_call_wasm(thread->exec_env, start_func, 0, NULL);
            }
            /* else: nothing to run; this thread will transition to EXITED
             * below, which is exactly right for a library-style module. */
        }

        /* If asyncify is unwinding (fuel ran out), stop the unwind */
        if (asyncify_get_state() == 1) {
            asyncify_stop_unwind();
        }
    } else if (thread->start_routine) {
        wasm_module_inst_t inst = wasm_runtime_get_module_inst(
            thread->exec_env);
        wasm_function_inst_t wasi_start =
            wasm_runtime_lookup_function(inst, "wasi_thread_start");
        void *targ = thread->exec_env->thread_arg;

        if (thread->asyncify_unwound) {
            /* Resume via asyncify rewind: a host call (sched_yield, wait32
               from inside kernel_call_indirect) suspended mid-execution. */
            thread->asyncify_unwound = false;
            asyncify_start_rewind(thread->asyncify_buf);
            if (wasi_start && targ) {
                uint32_t arg = *(uint32_t *)((char *)targ + 4);
                int32_t tid = *(int32_t *)((char *)targ + 8);
                uint32_t argv[2] = { (uint32_t)tid, arg };
                wasm_runtime_call_wasm(thread->exec_env, wasi_start, 2, argv);
            }
            if (asyncify_get_state() == 1)
                asyncify_stop_unwind();
            else if (asyncify_get_state() == 2)
                asyncify_stop_rewind();
        } else {
            /* Resume via YIELD flag: pure wasm interpreter pause (fuel
               exhaustion or wait32). The wasm_interp_call_wasm YIELD path
               picks up the preserved frame from the exec_env. */
            if (wasi_start && targ) {
                uint32_t arg = *(uint32_t *)((char *)targ + 4);
                int32_t tid = *(int32_t *)((char *)targ + 8);
                uint32_t argv[2] = { (uint32_t)tid, arg };
                wasm_runtime_call_wasm(thread->exec_env, wasi_start, 2, argv);
            }
        }
    } else {
        /* Resume main thread via old YIELD mechanism */
        WASM_SUSPEND_FLAGS_FETCH_OR(thread->exec_env->suspend_flags,
                                     WASM_SUSPEND_FLAG_YIELD);

        wasm_module_inst_t inst = wasm_runtime_get_module_inst(
            thread->exec_env);
        wasm_function_inst_t func =
            wasm_runtime_lookup_function(inst, "_start");
        if (!func)
            func = wasm_runtime_lookup_function(inst, "_initialize");
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

    /* For spawned threads, release the exec_env back to WAMR's cluster
     * so its `cluster_max_thread_num` accounting (which gates further
     * thread_spawn calls) reflects reality. Without this, a guest that
     * spawns and joins many threads will hit "maximum number of threads
     * exceeded" even though no threads are actually live. We never do
     * this for the main thread — its exec_env is owned by the kernel
     * session and torn down via kernel_unload. */
    if (thread != &g_scheduler.threads[0] && thread->exec_env) {
        WASMCluster *cluster = wasm_exec_env_get_cluster(thread->exec_env);
        if (cluster) {
            os_mutex_lock(&cluster->lock);
            wasm_cluster_del_exec_env(cluster, thread->exec_env);
            os_mutex_unlock(&cluster->lock);
        }
        thread->exec_env = NULL;
    }

    /* Per wasi-threads semantics, when the main thread (index 0) returns,
     * the process exits with main's status — any still-running child
     * threads are terminated, even if they would have trapped or run
     * longer. Child threads are detached, and joining is the user's
     * responsibility. Without this, a long-running child can race past
     * main and observe (or cause) state we'd otherwise miss. */
    if (thread == &g_scheduler.threads[0]) {
        terminate_all_threads();
        return 1;
    }

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
    /* When called from kernel_call_indirect_simple (non-cooperative context),
     * we can't yield — the host has called us synchronously expecting the
     * guest function to run to completion. Actually wait for the deadline
     * via nanosleep, then write the event result and return. This preserves
     * sleep() semantics for guest code (e.g. async work Execute callbacks)
     * without breaking the synchronous call contract.
     *
     * For cooperative threads, fall through to the normal block-and-yield
     * path so other threads can run during the wait. */
    extern bool g_main_thread_asyncify_enabled;
    if (!g_main_thread_asyncify_enabled && g_scheduler.threads[0].exec_env == exec_env) {
        /* Compute remaining time and sleep on the host. */
        uint64_t now_us = get_time_us();
        if (deadline_us > now_us) {
            uint64_t remaining_us = deadline_us - now_us;
            /* Cap at 60s to avoid pathological waits if the deadline is huge */
            if (remaining_us > 60ULL * 1000 * 1000) remaining_us = 60ULL * 1000 * 1000;
            struct timespec ts = {
                .tv_sec  = (time_t)(remaining_us / 1000000ULL),
                .tv_nsec = (long)((remaining_us % 1000000ULL) * 1000ULL),
            };
            /* Loop in case nanosleep is interrupted by a signal */
            while (nanosleep(&ts, &ts) == -1 && errno == EINTR) { /* retry */ }
        }

        /* Write a successful clock event so the guest sees poll_oneoff succeed */
        wasm_module_inst_t inst = wasm_runtime_get_module_inst(exec_env);
        uint8_t *evt = (uint8_t *)wasm_runtime_addr_app_to_native(
            inst, (uint64_t)event_out_ptr);
        uint32_t *nev = (uint32_t *)wasm_runtime_addr_app_to_native(
            inst, (uint64_t)nevents_ptr);
        if (evt) {
            memset(evt, 0, 32);
            memcpy(evt, &userdata, 8);
            /* type = clock (0) at offset 10, error = 0 */
        }
        if (nev) *nev = 1;
        return;
    }

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

void
wasmkernel_scheduler_reset_main_thread(void)
{
    WasmKernelThread *t = &g_scheduler.threads[0];
    if (t->state == THREAD_BLOCKED_IO || t->state == THREAD_BLOCKED_WAIT) {
        t->state = THREAD_READY;
        t->io_op_type = IO_OP_NONE;
    }
}

bool
wasmkernel_scheduler_should_yield(wasm_exec_env_t exec_env)
{
    return (WASM_SUSPEND_FLAGS_GET(exec_env->suspend_flags)
            & WASM_SUSPEND_FLAG_YIELD) != 0;
}
