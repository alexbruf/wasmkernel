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

/* ===== Generic host function bridge ===== */
/*
 * Any guest import that the kernel doesn't handle internally gets
 * forwarded to the host via this trampoline. The host provides the
 * actual implementation (e.g. N-API, custom APIs, etc).
 *
 * func_idx:  bridge slot index (maps to module_name + field_name)
 * args_ptr:  pointer to raw uint64 args array in kernel memory
 * argc:      number of arguments
 * returns:   i64 return value (0 if void)
 */
__attribute__((import_module("host"), import_name("host_func_call")))
extern int64_t host_func_call(uint32_t func_idx, uint32_t args_ptr,
                               uint32_t argc);

#define MAX_BRIDGE_FUNCS 128

/* Bridge registry */
static uint32_t g_bridge_count = 0;
static char g_bridge_module_names[MAX_BRIDGE_FUNCS][64];
static char g_bridge_field_names[MAX_BRIDGE_FUNCS][64];
static char g_bridge_signatures[MAX_BRIDGE_FUNCS][32];
static uint16_t g_bridge_param_counts[MAX_BRIDGE_FUNCS];
static bool g_bridge_has_return[MAX_BRIDGE_FUNCS];

/* Dispatch: called by each bridge handler with its index */
static void
bridge_dispatch(uint32_t idx, wasm_exec_env_t exec_env, uint64 *args)
{
    (void)exec_env;
    uint32_t argc = g_bridge_param_counts[idx];
    int64_t ret = host_func_call(idx, (uint32_t)(uintptr_t)args, argc);
    if (g_bridge_has_return[idx]) {
        /* Write return value to args[0] (raw API convention) */
        args[0] = (uint64)ret;
    }
}

/* Generate 128 bridge handler functions via macro */
#define B(N) static void bfn_##N(wasm_exec_env_t e, uint64 *a) { bridge_dispatch(N, e, a); }

B(0)   B(1)   B(2)   B(3)   B(4)   B(5)   B(6)   B(7)
B(8)   B(9)   B(10)  B(11)  B(12)  B(13)  B(14)  B(15)
B(16)  B(17)  B(18)  B(19)  B(20)  B(21)  B(22)  B(23)
B(24)  B(25)  B(26)  B(27)  B(28)  B(29)  B(30)  B(31)
B(32)  B(33)  B(34)  B(35)  B(36)  B(37)  B(38)  B(39)
B(40)  B(41)  B(42)  B(43)  B(44)  B(45)  B(46)  B(47)
B(48)  B(49)  B(50)  B(51)  B(52)  B(53)  B(54)  B(55)
B(56)  B(57)  B(58)  B(59)  B(60)  B(61)  B(62)  B(63)
B(64)  B(65)  B(66)  B(67)  B(68)  B(69)  B(70)  B(71)
B(72)  B(73)  B(74)  B(75)  B(76)  B(77)  B(78)  B(79)
B(80)  B(81)  B(82)  B(83)  B(84)  B(85)  B(86)  B(87)
B(88)  B(89)  B(90)  B(91)  B(92)  B(93)  B(94)  B(95)
B(96)  B(97)  B(98)  B(99)  B(100) B(101) B(102) B(103)
B(104) B(105) B(106) B(107) B(108) B(109) B(110) B(111)
B(112) B(113) B(114) B(115) B(116) B(117) B(118) B(119)
B(120) B(121) B(122) B(123) B(124) B(125) B(126) B(127)

#undef B

typedef void (*bridge_fn_t)(wasm_exec_env_t, uint64 *);
static bridge_fn_t g_bridge_fns[MAX_BRIDGE_FUNCS] = {
    bfn_0,   bfn_1,   bfn_2,   bfn_3,   bfn_4,   bfn_5,   bfn_6,   bfn_7,
    bfn_8,   bfn_9,   bfn_10,  bfn_11,  bfn_12,  bfn_13,  bfn_14,  bfn_15,
    bfn_16,  bfn_17,  bfn_18,  bfn_19,  bfn_20,  bfn_21,  bfn_22,  bfn_23,
    bfn_24,  bfn_25,  bfn_26,  bfn_27,  bfn_28,  bfn_29,  bfn_30,  bfn_31,
    bfn_32,  bfn_33,  bfn_34,  bfn_35,  bfn_36,  bfn_37,  bfn_38,  bfn_39,
    bfn_40,  bfn_41,  bfn_42,  bfn_43,  bfn_44,  bfn_45,  bfn_46,  bfn_47,
    bfn_48,  bfn_49,  bfn_50,  bfn_51,  bfn_52,  bfn_53,  bfn_54,  bfn_55,
    bfn_56,  bfn_57,  bfn_58,  bfn_59,  bfn_60,  bfn_61,  bfn_62,  bfn_63,
    bfn_64,  bfn_65,  bfn_66,  bfn_67,  bfn_68,  bfn_69,  bfn_70,  bfn_71,
    bfn_72,  bfn_73,  bfn_74,  bfn_75,  bfn_76,  bfn_77,  bfn_78,  bfn_79,
    bfn_80,  bfn_81,  bfn_82,  bfn_83,  bfn_84,  bfn_85,  bfn_86,  bfn_87,
    bfn_88,  bfn_89,  bfn_90,  bfn_91,  bfn_92,  bfn_93,  bfn_94,  bfn_95,
    bfn_96,  bfn_97,  bfn_98,  bfn_99,  bfn_100, bfn_101, bfn_102, bfn_103,
    bfn_104, bfn_105, bfn_106, bfn_107, bfn_108, bfn_109, bfn_110, bfn_111,
    bfn_112, bfn_113, bfn_114, bfn_115, bfn_116, bfn_117, bfn_118, bfn_119,
    bfn_120, bfn_121, bfn_122, bfn_123, bfn_124, bfn_125, bfn_126, bfn_127,
};

/* Build raw API signature string from WASMFuncType */
#include "wasm.h"  /* for WASMModule, WASMImport, WASMFuncType */

static void
build_raw_signature(WASMFuncType *ft, char *buf, size_t bufsz)
{
    /* Raw API signature: "(params)ret" where
     * i=i32, I=i64, f=f32, F=f64
     * No return char if void */
    size_t pos = 0;
    buf[pos++] = '(';
    for (uint16_t i = 0; i < ft->param_count && pos < bufsz - 3; i++) {
        switch (ft->types[i]) {
            case VALUE_TYPE_I32: buf[pos++] = 'i'; break;
            case VALUE_TYPE_I64: buf[pos++] = 'I'; break;
            case VALUE_TYPE_F32: buf[pos++] = 'f'; break;
            case VALUE_TYPE_F64: buf[pos++] = 'F'; break;
            default: buf[pos++] = 'i'; break; /* fallback */
        }
    }
    buf[pos++] = ')';
    if (ft->result_count > 0) {
        switch (ft->types[ft->param_count]) {
            case VALUE_TYPE_I32: buf[pos++] = 'i'; break;
            case VALUE_TYPE_I64: buf[pos++] = 'I'; break;
            case VALUE_TYPE_F32: buf[pos++] = 'f'; break;
            case VALUE_TYPE_F64: buf[pos++] = 'F'; break;
            default: buf[pos++] = 'i'; break;
        }
    }
    buf[pos] = '\0';
}

/* Scan guest module imports and register bridge handlers for unknown modules.
 * Must be called after wasm_runtime_load but before wasm_runtime_instantiate.
 * Functions the kernel handles internally are skipped; everything else is bridged. */
static void
register_bridge_imports(wasm_module_t module,
                        NativeSymbol *wasi_syms, uint32_t num_wasi_syms)
{
    WASMModule *m = (WASMModule *)module;
    /* Don't reset g_bridge_count — preserve pre-registered entries from kernel_init */
    uint32_t bridge_start = g_bridge_count;

    /* Collect imports that need bridging — skip only functions
       the kernel handles internally */
    for (uint32_t i = 0; i < m->import_function_count; i++) {
        WASMFunctionImport *fi = &m->import_functions[i].u.function;

        /* Skip wasi.thread-spawn — handled by lib-wasi-threads */
        if (strcmp(fi->module_name, "wasi") == 0)
            continue;

        /* Skip ALL wasi_snapshot_preview1 — handled by internal table
           plus catch-all bridge entries added below */
        if (strcmp(fi->module_name, "wasi_snapshot_preview1") == 0)
            continue;

        if (g_bridge_count >= MAX_BRIDGE_FUNCS) {
            fprintf(stderr, "wasmkernel: too many bridge imports (max %d)\n",
                    MAX_BRIDGE_FUNCS);
            break;
        }

        uint32_t idx = g_bridge_count;
        strncpy(g_bridge_module_names[idx], fi->module_name, 63);
        g_bridge_module_names[idx][63] = '\0';
        strncpy(g_bridge_field_names[idx], fi->field_name, 63);
        g_bridge_field_names[idx][63] = '\0';
        build_raw_signature(fi->func_type, g_bridge_signatures[idx], 32);
        g_bridge_param_counts[idx] = fi->func_type->param_count;
        g_bridge_has_return[idx] = fi->func_type->result_count > 0;
        g_bridge_count++;
    }

    /* Register bridge natives grouped by module name */
    if (g_bridge_count == bridge_start)
        return;

    /* We need to register per-module. Group by module name. */
    for (uint32_t i = bridge_start; i < g_bridge_count; i++) {
        /* Check if this module was already registered */
        bool already = false;
        for (uint32_t j = 0; j < i; j++) {
            if (strcmp(g_bridge_module_names[i],
                       g_bridge_module_names[j]) == 0) {
                already = true;
                break;
            }
        }
        if (already)
            continue;

        /* Count functions in this module */
        uint32_t count = 0;
        for (uint32_t j = i; j < g_bridge_count; j++) {
            if (strcmp(g_bridge_module_names[i],
                       g_bridge_module_names[j]) == 0)
                count++;
        }

        /* Build NativeSymbol array for this module (use static to avoid heap issues) */
        static NativeSymbol syms[MAX_BRIDGE_FUNCS];

        uint32_t si = 0;
        for (uint32_t j = i; j < g_bridge_count && si < count; j++) {
            if (strcmp(g_bridge_module_names[i],
                       g_bridge_module_names[j]) != 0)
                continue;
            syms[si].symbol = g_bridge_field_names[j];
            syms[si].func_ptr = (void *)g_bridge_fns[j];
            syms[si].signature = g_bridge_signatures[j];
            syms[si].attachment = NULL;
            si++;
        }

        if (!wasm_runtime_register_natives_raw(
                g_bridge_module_names[i], syms, count)) {
            fprintf(stderr, "wasmkernel: failed to register bridge for '%s' (%d funcs)\n",
                    g_bridge_module_names[i], count);
        }
        /* Note: syms must stay alive — WAMR references it.
           We leak intentionally (loaded once per guest). */
    }
}

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

/* Bridge-backed WASI stubs for filesystem ops.
 * These use bridge slots 120-127, forwarding to host_func_call.
 * Host implements them with real fs operations. */

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
    /* Filesystem/misc stubs — bridged to host via slots 120-127 */
    { "path_open",          (void *)bfn_120,    "(iiiiiIiii)i", NULL },
    { "fd_readdir",         (void *)bfn_121,    "(iiiIi)i",     NULL },
    { "fd_filestat_get",    (void *)bfn_122,    "(ii)i",        NULL },
    { "path_filestat_get",  (void *)bfn_123,    "(iiiii)i",     NULL },
    { "fd_prestat_dir_name",(void *)bfn_124,    "(iii)i",       NULL },
    { "random_get",         (void *)bfn_125,    "(ii)i",        NULL },
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

    /* Pre-register env.napi functions for modules that import them.
     * IMPORTANT: This table is already sorted alphabetically because
     * WAMR's register_natives sorts it and uses binary search. The bridge
     * slot (bfn_N) index matches the sorted position, so the host's
     * bridge discovery (kernel_bridge_info) returns them in the same order. */
    {
        static NativeSymbol env_napi[] = {
            { "napi_call_function",              (void *)bfn_0,  "(iiiiii)i", NULL },
            { "napi_coerce_to_object",           (void *)bfn_1,  "(iii)i",    NULL },
            { "napi_coerce_to_string",           (void *)bfn_2,  "(iii)i",    NULL },
            { "napi_create_array_with_length",   (void *)bfn_3,  "(iii)i",    NULL },
            { "napi_create_error",               (void *)bfn_4,  "(iiii)i",   NULL },
            { "napi_create_function",            (void *)bfn_5,  "(iiiiii)i", NULL },
            { "napi_create_int64",               (void *)bfn_6,  "(iIi)i",    NULL },
            { "napi_create_object",              (void *)bfn_7,  "(ii)i",     NULL },
            { "napi_create_reference",           (void *)bfn_8,  "(iiii)i",   NULL },
            { "napi_create_string_utf8",         (void *)bfn_9,  "(iiii)i",   NULL },
            { "napi_create_threadsafe_function", (void *)bfn_10, "(iiiiiiiiiii)i", NULL },
            { "napi_define_class",               (void *)bfn_11, "(iiiiiiii)i",    NULL },
            { "napi_delete_reference",           (void *)bfn_12, "(ii)i",     NULL },
            { "napi_get_and_clear_last_exception",(void *)bfn_13,"(ii)i",     NULL },
            { "napi_get_array_length",           (void *)bfn_14, "(iii)i",    NULL },
            { "napi_get_cb_info",                (void *)bfn_15, "(iiiiii)i", NULL },
            { "napi_get_element",                (void *)bfn_16, "(iiii)i",   NULL },
            { "napi_get_global",                 (void *)bfn_17, "(ii)i",     NULL },
            { "napi_get_named_property",         (void *)bfn_18, "(iiii)i",   NULL },
            { "napi_get_property",               (void *)bfn_19, "(iiii)i",   NULL },
            { "napi_get_reference_value",        (void *)bfn_20, "(iii)i",    NULL },
            { "napi_get_undefined",              (void *)bfn_21, "(ii)i",     NULL },
            { "napi_get_value_bool",             (void *)bfn_22, "(iii)i",    NULL },
            { "napi_get_value_string_utf8",      (void *)bfn_23, "(iiiii)i",  NULL },
            { "napi_is_array",                   (void *)bfn_24, "(iii)i",    NULL },
            { "napi_is_error",                   (void *)bfn_25, "(iii)i",    NULL },
            { "napi_is_exception_pending",       (void *)bfn_26, "(ii)i",     NULL },
            { "napi_reference_unref",            (void *)bfn_27, "(iii)i",    NULL },
            { "napi_set_element",                (void *)bfn_28, "(iiii)i",   NULL },
            { "napi_set_named_property",         (void *)bfn_29, "(iiii)i",   NULL },
            { "napi_set_property",               (void *)bfn_30, "(iiii)i",   NULL },
            { "napi_throw",                      (void *)bfn_31, "(ii)i",     NULL },
            { "napi_throw_error",                (void *)bfn_32, "(iii)i",    NULL },
            { "napi_typeof",                     (void *)bfn_33, "(iii)i",    NULL },
            { "napi_unref_threadsafe_function",  (void *)bfn_34, "(ii)i",     NULL },
            { "napi_unwrap",                     (void *)bfn_35, "(iii)i",    NULL },
            { "napi_wrap",                       (void *)bfn_36, "(iiiiii)i", NULL },
        };
        /* Also populate bridge metadata so host can discover these via
           kernel_bridge_info. Use same indices as bfn_N. */
        static const char *env_names[] = {
            "napi_call_function", "napi_coerce_to_object", "napi_coerce_to_string",
            "napi_create_array_with_length", "napi_create_error", "napi_create_function",
            "napi_create_int64", "napi_create_object", "napi_create_reference",
            "napi_create_string_utf8", "napi_create_threadsafe_function",
            "napi_define_class", "napi_delete_reference",
            "napi_get_and_clear_last_exception", "napi_get_array_length",
            "napi_get_cb_info", "napi_get_element", "napi_get_global",
            "napi_get_named_property", "napi_get_property", "napi_get_reference_value",
            "napi_get_undefined", "napi_get_value_bool", "napi_get_value_string_utf8",
            "napi_is_array", "napi_is_error", "napi_is_exception_pending",
            "napi_reference_unref", "napi_set_element", "napi_set_named_property",
            "napi_set_property", "napi_throw", "napi_throw_error", "napi_typeof",
            "napi_unref_threadsafe_function", "napi_unwrap", "napi_wrap",
        };
        uint32_t n_env = sizeof(env_napi) / sizeof(NativeSymbol);
        for (uint32_t i = 0; i < n_env; i++) {
            strncpy(g_bridge_module_names[i], "env", 63);
            strncpy(g_bridge_field_names[i], env_names[i], 63);
            /* Parse param count from signature string */
            const char *sig = env_napi[i].signature;
            uint32_t pc = 0;
            if (sig) {
                const char *p = sig;
                if (*p == '(') p++;
                while (*p && *p != ')') { pc++; p++; }
            }
            g_bridge_param_counts[i] = pc;
            g_bridge_has_return[i] = true;
        }
        g_bridge_count = n_env; /* 37 */

        if (!wasm_runtime_register_natives_raw("env", env_napi, n_env)) {
            fprintf(stderr, "kernel_init: failed to register env.napi\n");
        }
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

    /* Scan guest imports and register bridge handlers for any
       import the kernel doesn't handle internally */
    register_bridge_imports(g_guest_module, g_wasi_symbols, NUM_WASI_SYMBOLS);

    /* Register bridge metadata for WASI filesystem stubs (slots 120-127)
       so the host can discover them via kernel_bridge_info.
       Must be AFTER register_bridge_imports which resets g_bridge_count. */
    {
        static const struct { uint32_t slot; const char *name; } wasi_bridge[] = {
            { 120, "path_open" },
            { 121, "fd_readdir" },
            { 122, "fd_filestat_get" },
            { 123, "path_filestat_get" },
            { 124, "fd_prestat_dir_name" },
            { 125, "random_get" },
        };
        for (uint32_t i = 0; i < sizeof(wasi_bridge)/sizeof(wasi_bridge[0]); i++) {
            uint32_t s = wasi_bridge[i].slot;
            strncpy(g_bridge_module_names[s], "wasi_snapshot_preview1", 63);
            strncpy(g_bridge_field_names[s], wasi_bridge[i].name, 63);
            g_bridge_param_counts[s] = 2;
            g_bridge_has_return[s] = true;
            if (s >= g_bridge_count) g_bridge_count = s + 1;
        }
    }

    /* Cap guest max memory on wasm32 — we can't allocate 4GB inside
       the kernel's own 4GB address space. 256MB is generous. */
    {
        WASMModule *m = (WASMModule *)g_guest_module;
        uint32_t cap = 256 * 1024 * 1024 / 65536; /* 4096 pages = 256MB */
        for (uint32_t i = 0; i < m->import_memory_count; i++) {
            if (m->import_memories[i].u.memory.mem_type.max_page_count > cap)
                m->import_memories[i].u.memory.mem_type.max_page_count = cap;
        }
        for (uint32_t i = 0; i < m->memory_count; i++) {
            if (m->memories[i].max_page_count > cap)
                m->memories[i].max_page_count = cap;
        }
    }

    /* 256KB stack, 64MB heap — large guests like oxide need ~62MB shared memory */
    g_guest_instance = wasm_runtime_instantiate(g_guest_module,
                                                 256 * 1024, 64 * 1024 * 1024,
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

/* Call a guest export function by name.
 * For reactor modules — call after _initialize completes.
 * func_name_ptr: pointer to null-terminated function name in kernel memory
 * argv_ptr: pointer to uint32 args array in kernel memory
 * argc: number of arguments
 * Returns: 0 on success, sets up scheduler for stepped execution if needed */
__attribute__((export_name("kernel_call")))
int32_t
kernel_call(uint32_t func_name_ptr, uint32_t argv_ptr, uint32_t argc)
{
    if (!g_guest_instance || !g_guest_exec_env)
        return -1;

    const char *name = (const char *)(uintptr_t)func_name_ptr;
    wasm_function_inst_t func =
        wasm_runtime_lookup_function(g_guest_instance, name);
    if (!func) {
        printf("kernel_call: function '%s' not found\n", name);
        return -2;
    }

    /* Call directly (single-shot, no scheduling needed for short calls) */
    uint32_t *argv = argv_ptr ? (uint32_t *)(uintptr_t)argv_ptr : NULL;
    if (!wasm_runtime_call_wasm(g_guest_exec_env, func, argc, argv)) {
        const char *exc = wasm_runtime_get_exception(g_guest_instance);
        if (exc) {
            fprintf(stderr, "kernel_call(%s): %s\n", name, exc);
            wasm_runtime_clear_exception(g_guest_instance);
        }
        return -3;
    }

    /* Return value is in argv[0] if the function returns something */
    return 0;
}

/* Call a guest function by its indirect table index.
 * Used for N-API callbacks — the guest registers function pointers
 * (table indices) that the host needs to call back into.
 * argv_ptr points to uint32 args in kernel memory.
 * Return value written to argv[0]. Returns 0 on success. */
__attribute__((export_name("kernel_call_indirect")))
int32_t
kernel_call_indirect(uint32_t table_idx, uint32_t argc, uint32_t argv_ptr)
{
    if (!g_guest_instance || !g_guest_exec_env)
        return -1;

    uint32_t *argv = argv_ptr ? (uint32_t *)(uintptr_t)argv_ptr : NULL;
    if (!wasm_runtime_call_indirect(g_guest_exec_env, table_idx, argc, argv)) {
        const char *exc = wasm_runtime_get_exception(g_guest_instance);
        if (exc) {
            fprintf(stderr, "kernel_call_indirect(%u): %s\n", table_idx, exc);
            wasm_runtime_clear_exception(g_guest_instance);
        }
        return -3;
    }
    return 0;
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

/* ===== Guest memory access exports ===== */
/* The host needs to read/write guest memory for bridge functions.
 * Guest memory lives inside the kernel's linear memory at an offset
 * determined by WAMR. These exports let the host find it. */

__attribute__((export_name("kernel_guest_memory_base")))
uint32_t
kernel_guest_memory_base(void)
{
    if (!g_guest_instance)
        return 0;
    uint32_t size;
    uint8_t *base = (uint8_t *)wasm_runtime_addr_app_to_native(
        g_guest_instance, 0);
    (void)size;
    return base ? (uint32_t)(uintptr_t)base : 0;
}

__attribute__((export_name("kernel_guest_memory_size")))
uint32_t
kernel_guest_memory_size(void)
{
    if (!g_guest_instance)
        return 0;
    wasm_memory_inst_t mem = wasm_runtime_get_default_memory(g_guest_instance);
    if (!mem) return 0;
    return wasm_memory_get_cur_page_count(mem)
           * wasm_memory_get_bytes_per_page(mem);
}

/* ===== Bridge introspection exports ===== */
/* Host calls these after kernel_load to discover bridge mappings */

__attribute__((export_name("kernel_bridge_count")))
uint32_t
kernel_bridge_count(void)
{
    return g_bridge_count;
}

/* Write bridge info for slot idx into buf: "module\0field\0signature\0"
 * Returns bytes written, or 0 if idx out of range */
__attribute__((export_name("kernel_bridge_info")))
uint32_t
kernel_bridge_info(uint32_t idx, uint32_t buf_ptr, uint32_t buf_len)
{
    if (idx >= g_bridge_count)
        return 0;

    char *buf = (char *)(uintptr_t)buf_ptr;
    uint32_t pos = 0;

    const char *mod = g_bridge_module_names[idx];
    const char *field = g_bridge_field_names[idx];
    const char *sig = g_bridge_signatures[idx];

    uint32_t ml = strlen(mod) + 1;
    uint32_t fl = strlen(field) + 1;
    uint32_t sl = strlen(sig) + 1;

    if (pos + ml + fl + sl > buf_len)
        return 0;

    memcpy(buf + pos, mod, ml); pos += ml;
    memcpy(buf + pos, field, fl); pos += fl;
    memcpy(buf + pos, sig, sl); pos += sl;
    return pos;
}
