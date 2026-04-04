/*
 * WasmKernel — portable cooperative threading for WebAssembly
 *
 * This is the kernel entry point. It exports functions that the host
 * calls to initialize the kernel, load a guest module, and step execution.
 *
 * Build target: wasm32-wasi (reactor model, no _start)
 */

#include "bh_platform.h"
#include "wasm_export.h"
#include "scheduler.h"

#include "wasm_exec_env.h"
#include "wasm_suspend_flags.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <time.h>

/* ===== Global state ===== */

static RuntimeInitArgs g_init_args;
static bool g_initialized = false;
static wasm_module_t g_guest_module = NULL;
static wasm_module_inst_t g_guest_instance = NULL;
static wasm_exec_env_t g_guest_exec_env = NULL;
static int32_t g_exit_code = 0;
static bool g_exited_via_proc_exit = false;
static char g_error_buf[256];

/* ===== Host I/O bridge imports ===== */
__attribute__((import_module("host"), import_name("host_io_submit")))
extern void host_io_submit(uint32_t callback_id, uint32_t op_type,
                            uint32_t fd, uint32_t buf_ptr, uint32_t len);

/* ===== Minimal WASI passthrough (raw native API) ===== */
/*
 * All handlers use void func(wasm_exec_env_t, uint64 *args).
 * Use native_raw_return_type() / native_raw_get_arg() / native_raw_set_return()
 * macros from wasm_export.h.
 */

/* fd_write(fd: i32, iovs: i32, iovs_len: i32, nwritten: i32) -> i32 */
static void
wasi_fd_write(wasm_exec_env_t exec_env, uint64 *args)
{
    native_raw_return_type(uint32, args);
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(exec_env);
    native_raw_get_arg(int32, fd, args);
    native_raw_get_arg(uint32, iovs_offset, args);
    native_raw_get_arg(uint32, iovs_len, args);
    native_raw_get_arg(uint32, nw_offset, args);

    uint32_t total = 0;
    uint32_t *iovs = (uint32_t *)wasm_runtime_addr_app_to_native(
        inst, (uint64_t)iovs_offset);
    if (!iovs) { native_raw_set_return(8); return; }

    for (uint32_t i = 0; i < iovs_len; i++) {
        uint32_t buf_ptr = iovs[i * 2];
        uint32_t buf_len = iovs[i * 2 + 1];
        char *buf = (char *)wasm_runtime_addr_app_to_native(
            inst, (uint64_t)buf_ptr);
        if (!buf) continue;
        if (fd == 1 || fd == 2)
            fwrite(buf, 1, buf_len, fd == 1 ? stdout : stderr);
        total += buf_len;
    }
    if (fd == 1) fflush(stdout);
    if (fd == 2) fflush(stderr);

    uint32_t *nw = (uint32_t *)wasm_runtime_addr_app_to_native(
        inst, (uint64_t)nw_offset);
    if (nw) *nw = total;
    native_raw_set_return(0);
}

/* fd_read(fd: i32, iovs: i32, iovs_len: i32, nread: i32) -> i32
 * For stdin/real fds: submit async I/O to host, block thread.
 * Returns BADF for unknown fds until host has them open. */
static void
wasi_fd_read(wasm_exec_env_t exec_env, uint64 *args)
{
    native_raw_return_type(uint32, args);
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(exec_env);
    native_raw_get_arg(int32, fd, args);
    native_raw_get_arg(uint32, iovs_offset, args);
    native_raw_get_arg(uint32, iovs_len, args);
    native_raw_get_arg(uint32, nread_offset, args);

    /* Resolve iov list */
    uint32_t *iovs = (uint32_t *)wasm_runtime_addr_app_to_native(
        inst, (uint64_t)iovs_offset);
    if (!iovs) { native_raw_set_return(8); return; }

    /* Gather total length and first buffer pointer */
    uint32_t total_len = 0;
    uint32_t first_buf_ptr = 0;
    for (uint32_t i = 0; i < iovs_len; i++) {
        if (i == 0) first_buf_ptr = iovs[i * 2];
        total_len += iovs[i * 2 + 1];
    }
    if (total_len == 0) {
        uint32_t *nr = (uint32_t *)wasm_runtime_addr_app_to_native(
            inst, (uint64_t)nread_offset);
        if (nr) *nr = 0;
        native_raw_set_return(0);
        return;
    }

    /* Resolve first buffer to a kernel-memory address (offset) for host */
    char *buf = (char *)wasm_runtime_addr_app_to_native(
        inst, (uint64_t)first_buf_ptr);
    if (!buf) { native_raw_set_return(8); return; }
    uint32_t buf_kernel_offset = (uint32_t)(uintptr_t)buf;

    /* Submit async read to host, block this thread */
    uint32_t cb_id = wasmkernel_scheduler_block_on_io(
        exec_env, IO_OP_READ, nread_offset);
    host_io_submit(cb_id, IO_OP_READ, (uint32_t)fd,
                   buf_kernel_offset, total_len);

    /* Return value will be set when thread resumes after I/O completes.
     * The scheduler writes nread and sets io_wasi_errno. */
    native_raw_set_return(0);
}

/* fd_seek -> BADF */
static void
wasi_fd_seek(wasm_exec_env_t exec_env, uint64 *args)
{
    native_raw_return_type(uint32, args);
    (void)exec_env;
    native_raw_set_return(8);
}

/* fd_close -> success */
static void
wasi_fd_close(wasm_exec_env_t exec_env, uint64 *args)
{
    native_raw_return_type(uint32, args);
    (void)exec_env;
    native_raw_set_return(0);
}

/* fd_fdstat_get(fd: i32, buf: i32) -> i32 */
static void
wasi_fd_fdstat_get(wasm_exec_env_t exec_env, uint64 *args)
{
    native_raw_return_type(uint32, args);
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(exec_env);
    native_raw_get_arg(int32, fd, args);
    native_raw_get_arg(uint32, buf_ptr, args);

    uint8_t *buf = (uint8_t *)wasm_runtime_addr_app_to_native(
        inst, (uint64_t)buf_ptr);
    if (!buf) { native_raw_set_return(8); return; }

    memset(buf, 0, 24);
    if (fd <= 2) {
        buf[0] = 2; /* CHARACTER_DEVICE */
        uint64_t rights = 0xFFFFFFFFFFFFFFFFULL;
        memcpy(buf + 8, &rights, 8);
        memcpy(buf + 16, &rights, 8);
    }
    native_raw_set_return(0);
}

/* fd_prestat_get -> BADF */
static void
wasi_fd_prestat_get(wasm_exec_env_t exec_env, uint64 *args)
{
    native_raw_return_type(uint32, args);
    (void)exec_env;
    native_raw_set_return(8);
}

/* proc_exit(code: i32) */
static void
wasi_proc_exit(wasm_exec_env_t exec_env, uint64 *args)
{
    native_raw_get_arg(int32, code, args);
    g_exit_code = code;
    g_exited_via_proc_exit = true;
    g_scheduler.exited_via_proc_exit = true;
    g_scheduler.exit_code = code;
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(exec_env);
    wasm_runtime_set_exception(inst, "proc_exit");
}

/* environ_sizes_get(count: i32, buf_size: i32) -> i32 */
static void
wasi_environ_sizes_get(wasm_exec_env_t exec_env, uint64 *args)
{
    native_raw_return_type(uint32, args);
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(exec_env);
    native_raw_get_arg(uint32, count_ptr, args);
    native_raw_get_arg(uint32, bufsz_ptr, args);

    uint32_t *cnt = (uint32_t *)wasm_runtime_addr_app_to_native(
        inst, (uint64_t)count_ptr);
    uint32_t *bsz = (uint32_t *)wasm_runtime_addr_app_to_native(
        inst, (uint64_t)bufsz_ptr);
    if (cnt) *cnt = 0;
    if (bsz) *bsz = 0;
    native_raw_set_return(0);
}

/* environ_get -> success (empty) */
static void
wasi_environ_get(wasm_exec_env_t exec_env, uint64 *args)
{
    native_raw_return_type(uint32, args);
    (void)exec_env;
    native_raw_set_return(0);
}

/* args_sizes_get(argc: i32, buf_size: i32) -> i32 */
static void
wasi_args_sizes_get(wasm_exec_env_t exec_env, uint64 *args)
{
    native_raw_return_type(uint32, args);
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(exec_env);
    native_raw_get_arg(uint32, argc_ptr, args);
    native_raw_get_arg(uint32, bufsz_ptr, args);

    uint32_t *ac = (uint32_t *)wasm_runtime_addr_app_to_native(
        inst, (uint64_t)argc_ptr);
    uint32_t *bsz = (uint32_t *)wasm_runtime_addr_app_to_native(
        inst, (uint64_t)bufsz_ptr);
    if (ac) *ac = 0;
    if (bsz) *bsz = 0;
    native_raw_set_return(0);
}

/* args_get -> success (empty) */
static void
wasi_args_get(wasm_exec_env_t exec_env, uint64 *args)
{
    native_raw_return_type(uint32, args);
    (void)exec_env;
    native_raw_set_return(0);
}

/* clock_time_get(clock_id: i32, precision: i64, time: i32) -> i32 */
static void
wasi_clock_time_get(wasm_exec_env_t exec_env, uint64 *args)
{
    native_raw_return_type(uint32, args);
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(exec_env);
    native_raw_get_arg(uint32, clock_id, args);
    native_raw_get_arg(uint64, precision, args);
    native_raw_get_arg(uint32, time_ptr, args);
    (void)clock_id;
    (void)precision;

    uint64_t *time = (uint64_t *)wasm_runtime_addr_app_to_native(
        inst, (uint64_t)time_ptr);
    if (!time) { native_raw_set_return(28); return; }

    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    *time = (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
    native_raw_set_return(0);
}

/* poll_oneoff(in: i32, out: i32, nsubscriptions: i32, nevents: i32) -> i32
 *
 * Subscription struct (48 bytes):
 *   userdata: u64 (offset 0)
 *   u.tag: u8 (offset 8) — 0=clock, 1=fd_read, 2=fd_write
 *   u.clock.id: u32 (offset 16)
 *   u.clock.timeout: u64 (offset 24)
 *   u.clock.precision: u64 (offset 32)
 *   u.clock.flags: u16 (offset 40) — bit 0: ABSTIME
 *
 * Event struct (32 bytes):
 *   userdata: u64 (offset 0)
 *   error: u16 (offset 8)
 *   type: u8 (offset 10)
 *   pad: 5 bytes
 *   fd_readwrite.nbytes: u64 (offset 16)
 *   fd_readwrite.flags: u16 (offset 24)
 */
static void
wasi_poll_oneoff(wasm_exec_env_t exec_env, uint64 *args)
{
    native_raw_return_type(uint32, args);
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(exec_env);
    native_raw_get_arg(uint32, in_ptr, args);
    native_raw_get_arg(uint32, out_ptr, args);
    native_raw_get_arg(uint32, nsubs, args);
    native_raw_get_arg(uint32, nevents_ptr, args);

    uint8_t *subs = (uint8_t *)wasm_runtime_addr_app_to_native(
        inst, (uint64_t)in_ptr);
    if (!subs || nsubs == 0) { native_raw_set_return(28); return; }

    /* For now, handle single-subscription clock case (covers nanosleep).
     * Multi-subscription and fd subscriptions can be added later. */
    uint8_t tag = subs[8]; /* u.tag */

    if (tag == 0) {
        /* Clock subscription */
        uint64_t timeout_ns;
        memcpy(&timeout_ns, subs + 24, 8);
        uint16_t flags;
        memcpy(&flags, subs + 40, 2);
        uint64_t userdata;
        memcpy(&userdata, subs + 0, 8);

        uint64_t now_us = 0;
        struct timespec ts;
        clock_gettime(CLOCK_MONOTONIC, &ts);
        now_us = (uint64_t)ts.tv_sec * 1000000ULL
               + (uint64_t)ts.tv_nsec / 1000;

        uint64_t deadline_us;
        if (flags & 1) {
            /* ABSTIME: timeout is absolute timestamp in nanoseconds */
            deadline_us = timeout_ns / 1000;
        } else {
            /* Relative timeout */
            deadline_us = now_us + timeout_ns / 1000;
        }

        /* Block this thread until deadline */
        wasmkernel_scheduler_block_on_poll_clock(
            exec_env, deadline_us, out_ptr, nevents_ptr, userdata);
        native_raw_set_return(0);
    } else if (tag == 1 || tag == 2) {
        /* fd_read/fd_write subscription — immediate ready for stdout/stderr */
        uint8_t *evt = (uint8_t *)wasm_runtime_addr_app_to_native(
            inst, (uint64_t)out_ptr);
        uint32_t *nev = (uint32_t *)wasm_runtime_addr_app_to_native(
            inst, (uint64_t)nevents_ptr);
        if (evt) {
            uint64_t userdata;
            memcpy(&userdata, subs + 0, 8);
            memset(evt, 0, 32);
            memcpy(evt, &userdata, 8);
            evt[10] = tag; /* type */
        }
        if (nev) *nev = 1;
        native_raw_set_return(0);
    } else {
        native_raw_set_return(28); /* INVAL */
    }
}

/* sched_yield -> yield to scheduler */
static void
wasi_sched_yield(wasm_exec_env_t exec_env, uint64 *args)
{
    native_raw_return_type(uint32, args);
    /* Set yield flag so the thread gives up its time slice */
    WASM_SUSPEND_FLAGS_FETCH_OR(exec_env->suspend_flags,
                                WASM_SUSPEND_FLAG_YIELD);
    native_raw_set_return(0);
}

static NativeSymbol g_wasi_symbols[] = {
    { "fd_write",           (void *)wasi_fd_write,           "(iiii)i",  NULL },
    { "fd_read",            (void *)wasi_fd_read,            "(iiii)i",  NULL },
    { "fd_seek",            (void *)wasi_fd_seek,            "(iIii)i",  NULL },
    { "fd_close",           (void *)wasi_fd_close,           "(i)i",     NULL },
    { "fd_fdstat_get",      (void *)wasi_fd_fdstat_get,      "(ii)i",    NULL },
    { "fd_prestat_get",     (void *)wasi_fd_prestat_get,     "(ii)i",    NULL },
    { "proc_exit",          (void *)wasi_proc_exit,          "(i)",      NULL },
    { "environ_sizes_get",  (void *)wasi_environ_sizes_get,  "(ii)i",    NULL },
    { "environ_get",        (void *)wasi_environ_get,        "(ii)i",    NULL },
    { "args_sizes_get",     (void *)wasi_args_sizes_get,     "(ii)i",    NULL },
    { "args_get",           (void *)wasi_args_get,           "(ii)i",    NULL },
    { "clock_time_get",     (void *)wasi_clock_time_get,     "(iIi)i",   NULL },
    { "poll_oneoff",        (void *)wasi_poll_oneoff,        "(iiii)i",  NULL },
    { "sched_yield",        (void *)wasi_sched_yield,        "()i",      NULL },
};

#define NUM_WASI_SYMBOLS (sizeof(g_wasi_symbols) / sizeof(NativeSymbol))

/* ===== Exported API ===== */

__attribute__((export_name("kernel_init")))
void
kernel_init(void)
{
    if (g_initialized)
        return;

    memset(&g_init_args, 0, sizeof(g_init_args));
    g_init_args.mem_alloc_type = Alloc_With_System_Allocator;

    if (!wasm_runtime_full_init(&g_init_args)) {
        printf("kernel_init: wasm_runtime_full_init failed\n");
        return;
    }

    /* Allow up to 64 guest threads */
    wasm_runtime_set_max_thread_num(WASMKERNEL_MAX_THREADS);

    /* Register WASI functions using raw API (uniform signature avoids
       call_indirect type mismatch in wasm32 builds) */
    if (!wasm_runtime_register_natives_raw("wasi_snapshot_preview1",
                                           g_wasi_symbols, NUM_WASI_SYMBOLS)) {
        printf("kernel_init: failed to register WASI natives\n");
        return;
    }

    g_initialized = true;
}

__attribute__((export_name("kernel_alloc")))
uint32_t
kernel_alloc(uint32_t size)
{
    void *p = malloc(size);
    return (uint32_t)(uintptr_t)p;
}

__attribute__((export_name("kernel_load")))
int32_t
kernel_load(uint32_t wasm_ptr, uint32_t wasm_len)
{
    if (!g_initialized)
        return -1;

    if (g_guest_exec_env) {
        wasm_runtime_destroy_exec_env(g_guest_exec_env);
        g_guest_exec_env = NULL;
    }
    if (g_guest_instance) {
        wasm_runtime_deinstantiate(g_guest_instance);
        g_guest_instance = NULL;
    }
    if (g_guest_module) {
        wasm_runtime_unload(g_guest_module);
        g_guest_module = NULL;
    }

    uint8_t *buf = (uint8_t *)(uintptr_t)wasm_ptr;
    g_guest_module = wasm_runtime_load(buf, wasm_len,
                                       g_error_buf, sizeof(g_error_buf));
    if (!g_guest_module) {
        printf("kernel_load: %s\n", g_error_buf);
        return -2;
    }

    /* 256KB stack, 512KB heap — enough for threading guests */
    g_guest_instance = wasm_runtime_instantiate(g_guest_module,
                                                 256 * 1024, 512 * 1024,
                                                 g_error_buf, sizeof(g_error_buf));
    if (!g_guest_instance) {
        printf("kernel_load: %s\n", g_error_buf);
        return -3;
    }

    g_guest_exec_env = wasm_runtime_create_exec_env(g_guest_instance, 256 * 1024);
    if (!g_guest_exec_env) {
        printf("kernel_load: failed to create exec env\n");
        return -4;
    }

    g_exit_code = 0;
    g_exited_via_proc_exit = false;

    /* Initialize cooperative scheduler with main thread */
    wasmkernel_scheduler_init();
    g_scheduler.exited_via_proc_exit = false;
    wasmkernel_scheduler_add_main(g_guest_exec_env);

    return 0;
}

__attribute__((export_name("kernel_step")))
int32_t
kernel_step(void)
{
    if (!g_guest_instance || !g_guest_exec_env)
        return -1;

    int32_t result = wasmkernel_scheduler_step();

    /* Sync proc_exit state from WASI handler */
    if (g_exited_via_proc_exit || g_scheduler.exited_via_proc_exit) {
        g_exited_via_proc_exit = true;
        return -2;
    }

    return result;
}

__attribute__((export_name("kernel_exit_code")))
int32_t
kernel_exit_code(void)
{
    return g_exit_code;
}

__attribute__((export_name("kernel_set_fuel")))
void
kernel_set_fuel(uint32_t fuel_per_slice)
{
    if (fuel_per_slice > 0)
        g_scheduler.fuel_per_slice = fuel_per_slice;
}

__attribute__((export_name("kernel_thread_count")))
uint32_t
kernel_thread_count(void)
{
    uint32_t live = 0;
    for (uint32_t i = 0; i < g_scheduler.num_threads; i++) {
        WasmKernelThreadState s = g_scheduler.threads[i].state;
        if (s != THREAD_EXITED && s != THREAD_UNUSED)
            live++;
    }
    return live;
}
