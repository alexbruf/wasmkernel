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

/* See kernel_set_min_initial_pages comment below for what this does. */
static uint32_t g_min_initial_pages = 0;
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

#define MAX_BRIDGE_FUNCS 256

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
B(128) B(129) B(130) B(131) B(132) B(133) B(134) B(135)
B(136) B(137) B(138) B(139) B(140) B(141) B(142) B(143)
B(144) B(145) B(146) B(147) B(148) B(149) B(150) B(151)
B(152) B(153) B(154) B(155) B(156) B(157) B(158) B(159)
B(160) B(161) B(162) B(163) B(164) B(165) B(166) B(167)
B(168) B(169) B(170) B(171) B(172) B(173) B(174) B(175)
B(176) B(177) B(178) B(179) B(180) B(181) B(182) B(183)
B(184) B(185) B(186) B(187) B(188) B(189) B(190) B(191)
B(192) B(193) B(194) B(195) B(196) B(197) B(198) B(199)
B(200) B(201) B(202) B(203) B(204) B(205) B(206) B(207)
B(208) B(209) B(210) B(211) B(212) B(213) B(214) B(215)
B(216) B(217) B(218) B(219) B(220) B(221) B(222) B(223)
B(224) B(225) B(226) B(227) B(228) B(229) B(230) B(231)
B(232) B(233) B(234) B(235) B(236) B(237) B(238) B(239)
B(240) B(241) B(242) B(243) B(244) B(245) B(246) B(247)
B(248) B(249) B(250) B(251) B(252) B(253) B(254) B(255)

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
    bfn_128, bfn_129, bfn_130, bfn_131, bfn_132, bfn_133, bfn_134, bfn_135,
    bfn_136, bfn_137, bfn_138, bfn_139, bfn_140, bfn_141, bfn_142, bfn_143,
    bfn_144, bfn_145, bfn_146, bfn_147, bfn_148, bfn_149, bfn_150, bfn_151,
    bfn_152, bfn_153, bfn_154, bfn_155, bfn_156, bfn_157, bfn_158, bfn_159,
    bfn_160, bfn_161, bfn_162, bfn_163, bfn_164, bfn_165, bfn_166, bfn_167,
    bfn_168, bfn_169, bfn_170, bfn_171, bfn_172, bfn_173, bfn_174, bfn_175,
    bfn_176, bfn_177, bfn_178, bfn_179, bfn_180, bfn_181, bfn_182, bfn_183,
    bfn_184, bfn_185, bfn_186, bfn_187, bfn_188, bfn_189, bfn_190, bfn_191,
    bfn_192, bfn_193, bfn_194, bfn_195, bfn_196, bfn_197, bfn_198, bfn_199,
    bfn_200, bfn_201, bfn_202, bfn_203, bfn_204, bfn_205, bfn_206, bfn_207,
    bfn_208, bfn_209, bfn_210, bfn_211, bfn_212, bfn_213, bfn_214, bfn_215,
    bfn_216, bfn_217, bfn_218, bfn_219, bfn_220, bfn_221, bfn_222, bfn_223,
    bfn_224, bfn_225, bfn_226, bfn_227, bfn_228, bfn_229, bfn_230, bfn_231,
    bfn_232, bfn_233, bfn_234, bfn_235, bfn_236, bfn_237, bfn_238, bfn_239,
    bfn_240, bfn_241, bfn_242, bfn_243, bfn_244, bfn_245, bfn_246, bfn_247,
    bfn_248, bfn_249, bfn_250, bfn_251, bfn_252, bfn_253, bfn_254, bfn_255,
};

/* Build raw API signature string from WASMFuncType */
#include "wasm.h"          /* for WASMModule, WASMImport, WASMFuncType */
#include "wasm_runtime.h"  /* for WASMModuleInstance (global_data access) */

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

        /* env and emnapi are bridged dynamically — no skip */

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

        /* Allocate NativeSymbol array for this module — WAMR holds a pointer
           to this array, so it must outlive the module (we intentionally leak). */
        NativeSymbol *syms = (NativeSymbol *)malloc(count * sizeof(NativeSymbol));
        if (!syms) {
            fprintf(stderr, "wasmkernel: OOM allocating bridge for '%s'\n",
                    g_bridge_module_names[i]);
            continue;
        }

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
    /* Bridge to host via slot 208 */
    bridge_dispatch(208, exec_env, args);
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
    } else {
        /* For preopened dirs and opened fds — grant all rights */
        buf[0] = 3; /* DIRECTORY */
        uint64_t rights = 0xFFFFFFFFFFFFFFFFULL;
        memcpy(buf + 8, &rights, 8);
        memcpy(buf + 16, &rights, 8);
    }
    native_raw_set_return(0);
}

/* fd_prestat_get — bridged to host for preopen support */
static void
wasi_fd_prestat_get(wasm_exec_env_t exec_env, uint64 *args)
{
    /* Bridge to host via slot 126 */
    bridge_dispatch(207, exec_env, args);
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
    extern void *wasmkernel_get_asyncify_buf(wasm_exec_env_t);
    extern void asyncify_start_unwind(void *);

    native_raw_return_type(uint32, args);
    /* Set yield flag so the thread gives up its time slice */
    WASM_SUSPEND_FLAGS_FETCH_OR(exec_env->suspend_flags,
                                WASM_SUSPEND_FLAG_YIELD);
    /* For spawned threads, trigger asyncify unwind to actually yield */
    void *abuf = wasmkernel_get_asyncify_buf(exec_env);
    if (abuf) asyncify_start_unwind(abuf);
    native_raw_set_return(0);
}

/* Bridge-backed WASI stubs for filesystem ops.
 * These use bridge slots 120-127, forwarding to host_func_call.
 * Host implements them with real fs operations. */

static NativeSymbol g_wasi_symbols[] = {
    { "fd_write",           (void *)wasi_fd_write,           "(iiii)i",  NULL },
    { "fd_read",            (void *)bfn_200,                 "(iiii)i",  NULL },
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
    { "path_open",          (void *)bfn_201,    "(iiiiiIIii)i", NULL },
    { "fd_readdir",         (void *)bfn_202,    "(iiiIi)i",     NULL },
    { "fd_filestat_get",    (void *)bfn_203,    "(ii)i",        NULL },
    { "path_filestat_get",  (void *)bfn_204,    "(iiiii)i",     NULL },
    { "fd_prestat_dir_name",(void *)bfn_205,    "(iii)i",       NULL },
    { "random_get",         (void *)bfn_206,    "(ii)i",        NULL },
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

    /* All env.* and emnapi.* functions are registered dynamically by
     * register_bridge_imports() during kernel_load(). WAMR's native symbol
     * registry is a linked list — multiple registrations for the same module
     * accumulate, so this works alongside the WASI table registered above.
     * No static table needed — any function the guest imports gets a bridge
     * handler automatically, and the host provides the JS implementation. */

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

    /* Re-resolve imports — bridge natives were registered AFTER wasm_runtime_load
       already tried (and failed) to resolve env/emnapi imports */
    extern bool wasm_resolve_symbols(WASMModule *module);
    wasm_resolve_symbols((WASMModule *)g_guest_module);

    /* Register bridge metadata for WASI filesystem stubs (slots 120-127)
       so the host can discover them via kernel_bridge_info.
       Must be AFTER register_bridge_imports which resets g_bridge_count. */
    {
        static const struct { uint32_t slot; const char *name; uint16_t nparams; } wasi_bridge[] = {
            { 200, "fd_read",            4 },
            { 201, "path_open",          9 },
            { 202, "fd_readdir",         5 },
            { 203, "fd_filestat_get",    2 },
            { 204, "path_filestat_get",  5 },
            { 205, "fd_prestat_dir_name",3 },
            { 206, "random_get",         2 },
            { 207, "fd_prestat_get",     2 },
            { 208, "fd_close",           1 },
        };
        for (uint32_t i = 0; i < sizeof(wasi_bridge)/sizeof(wasi_bridge[0]); i++) {
            uint32_t s = wasi_bridge[i].slot;
            strncpy(g_bridge_module_names[s], "wasi_snapshot_preview1", 63);
            strncpy(g_bridge_field_names[s], wasi_bridge[i].name, 63);
            g_bridge_param_counts[s] = wasi_bridge[i].nparams;
            g_bridge_has_return[s] = true;
            if (s >= g_bridge_count) g_bridge_count = s + 1;
        }
    }

    /* Cap guest max memory on wasm32 — we can't allocate 4GB inside
       the kernel's own 4GB address space. 512MB is generous. */
    {
        WASMModule *m = (WASMModule *)g_guest_module;
        uint32_t cap = 512 * 1024 * 1024 / 65536; /* 8192 pages = 512MB */
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
    /* Fix: WAMR's internal processing can reduce max_page_count below the
       module's declared value. For non-shared growable memory, ensure max
       is at least 8192 (512MB) to support large allocations. Skip shared
       memory — WAMR pre-allocates the full max for shared. */
    {
        WASMModule *m = (WASMModule *)g_guest_module;
        for (uint32_t i = 0; i < m->memory_count; i++) {
            if (m->possible_memory_grow
                && !(m->memories[i].flags & 0x02) /* not shared */
                && m->memories[i].max_page_count < 8192) {
                m->memories[i].max_page_count = 8192;
            }
        }
    }

    /* Optional: bump init memory to match what an external host would
     * inject (see kernel_set_min_initial_pages comment). Only does
     * anything if the host asked. Never exceeds the module's max. */
    if (g_min_initial_pages > 0) {
        WASMModule *m = (WASMModule *)g_guest_module;
        uint32_t want = g_min_initial_pages;
        for (uint32_t i = 0; i < m->import_memory_count; i++) {
            uint32_t mx = m->import_memories[i].u.memory.mem_type.max_page_count;
            uint32_t eff = (want < mx) ? want : mx;
            if (m->import_memories[i].u.memory.mem_type.init_page_count < eff)
                m->import_memories[i].u.memory.mem_type.init_page_count = eff;
        }
        for (uint32_t i = 0; i < m->memory_count; i++) {
            uint32_t mx = m->memories[i].max_page_count;
            uint32_t eff = (want < mx) ? want : mx;
            if (m->memories[i].init_page_count < eff)
                m->memories[i].init_page_count = eff;
        }
    }
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
__attribute__((export_name("kernel_has_function")))
int32_t
kernel_has_function(uint32_t func_name_ptr)
{
    if (!g_guest_instance) return 0;
    const char *n = (const char *)(uintptr_t)func_name_ptr;
    return wasm_runtime_lookup_function(g_guest_instance, n) ? 1 : 0;
}

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
    g_guest_exec_env->instructions_to_execute = 100000000;
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
/* Simple call_indirect without asyncify or cooperative scheduling.
 * Temporarily DISABLES asyncify for the main thread so the interpreter
 * runs the guest function without asyncify state interference. */
__attribute__((export_name("kernel_call_indirect_simple")))
int32_t
kernel_call_indirect_simple(uint32_t table_idx, uint32_t argc, uint32_t argv_ptr)
{
    if (!g_guest_instance || !g_guest_exec_env)
        return -1;
    uint32_t *argv = argv_ptr ? (uint32_t *)(uintptr_t)argv_ptr : NULL;

    /* Disable asyncify for this call */
    extern bool g_main_thread_asyncify_enabled;
    bool was_enabled = g_main_thread_asyncify_enabled;
    g_main_thread_asyncify_enabled = false;

    /* Clear any stale YIELD flag so we don't accidentally resume a
     * previous yielded frame instead of starting the new call.
     * This can happen when the Execute callback calls sleep() which
     * triggers poll_oneoff → block_on_poll_clock → YIELD. */
    WASM_SUSPEND_FLAGS_FETCH_AND(g_guest_exec_env->suspend_flags,
                                  ~WASM_SUSPEND_FLAG_YIELD);
    /* Also reset the main thread's scheduler state — if a previous call
     * set it to BLOCKED_IO, we need to clear that. */
    wasmkernel_scheduler_reset_main_thread();

    g_guest_exec_env->instructions_to_execute = 100000000;
    if (!wasm_runtime_call_indirect(g_guest_exec_env, table_idx, argc, argv)) {
        const char *exc = wasm_runtime_get_exception(g_guest_instance);
        if (exc) wasm_runtime_clear_exception(g_guest_instance);
        /* Clear yield flag in case the call yielded (e.g. sleep/poll_oneoff) */
        WASM_SUSPEND_FLAGS_FETCH_AND(g_guest_exec_env->suspend_flags,
                                      ~WASM_SUSPEND_FLAG_YIELD);
        wasmkernel_scheduler_reset_main_thread();
        g_main_thread_asyncify_enabled = was_enabled;
        return -3;
    }
    /* Clear yield flag after successful return too — the call may have
     * set it via poll_oneoff but then completed within the fuel budget. */
    WASM_SUSPEND_FLAGS_FETCH_AND(g_guest_exec_env->suspend_flags,
                                  ~WASM_SUSPEND_FLAG_YIELD);
    wasmkernel_scheduler_reset_main_thread();
    g_main_thread_asyncify_enabled = was_enabled;
    return 0;
}

__attribute__((export_name("kernel_call_indirect")))
int32_t
kernel_call_indirect(uint32_t table_idx, uint32_t argc, uint32_t argv_ptr)
{
    if (!g_guest_instance || !g_guest_exec_env)
        return -1;

    uint32_t *argv = argv_ptr ? (uint32_t *)(uintptr_t)argv_ptr : NULL;
    /* Save guest stack pointer (global[0]) — if the call traps, the guest
     * function may have decremented sp without restoring it, leaking stack. */
    uint8_t *global_data = ((WASMModuleInstance *)g_guest_instance)->global_data;
    uint32_t saved_sp = 0;
    if (global_data)
        saved_sp = *(uint32_t *)global_data;

    /* Enable asyncify for main thread during kernel_call_indirect so
     * multi-depth callbacks (e.g. pthread_create → wait32) can unwind */
    extern bool g_main_thread_asyncify_enabled;
    g_main_thread_asyncify_enabled = true;

    /* Disable fuel metering for direct calls: negative value means "no
     * limit" per CHECK_INSTRUCTION_LIMIT. Host-initiated calls must run
     * to completion — if they yield mid-execution on a fuel boundary,
     * argv[0] is never written with the real return value and we'd
     * silently read a stale pre-call value instead. Real CPU-heavy
     * native addons (argon2, image codecs, parsers) can easily burn
     * hundreds of millions of instructions in a single call. */
    g_guest_exec_env->instructions_to_execute = -1;
    if (!wasm_runtime_call_indirect(g_guest_exec_env, table_idx, argc, argv)) {
        g_main_thread_asyncify_enabled = false;
        const char *exc = wasm_runtime_get_exception(g_guest_instance);
        if (exc) {
            fprintf(stderr, "kernel_call_indirect(%u): %s\n", table_idx, exc);
            wasm_runtime_clear_exception(g_guest_instance);
        }
        /* Restore stack pointer to prevent stack leak on trap */
        if (global_data)
            *(uint32_t *)global_data = saved_sp;
        return -3;
    }

    /* Cooperative scheduling: if the callback blocked (e.g. wait32 inside
     * pthread_create), step other threads until the block resolves,
     * then resume via asyncify. */
    {
        extern int asyncify_get_state(void);
        extern void asyncify_stop_unwind(void);
        extern void asyncify_start_rewind(void *data);
        extern void *wasmkernel_get_asyncify_buf(wasm_exec_env_t);

        if (asyncify_get_state() == 1) {
            /* Callback unwound via asyncify (blocked on wait32 etc.) */
            asyncify_stop_unwind();

            /* Find the main thread in the scheduler */
            WasmKernelThread *main_thread = NULL;
            for (uint32_t i = 0; i < g_scheduler.num_threads; i++) {
                if (g_scheduler.threads[i].exec_env == g_guest_exec_env) {
                    main_thread = &g_scheduler.threads[i];
                    break;
                }
            }

            /* Step other threads until the main thread is unblocked */
            if (main_thread) {
                int max_iters = 100000;
                while (main_thread->state == THREAD_BLOCKED_WAIT
                       && --max_iters > 0) {
                    wasmkernel_scheduler_step();
                }

                if (main_thread->state != THREAD_BLOCKED_WAIT) {
                    /* Resume the callback via asyncify rewind */
                    main_thread->state = THREAD_RUNNING;
                    WASM_SUSPEND_FLAGS_FETCH_AND(
                        g_guest_exec_env->suspend_flags,
                        ~WASM_SUSPEND_FLAG_YIELD);

                    void *abuf = main_thread->asyncify_buf;
                    asyncify_start_rewind(abuf);
                    g_guest_exec_env->instructions_to_execute = 100000000;
                    wasm_runtime_call_indirect(g_guest_exec_env, table_idx,
                                               argc, argv);

                    if (asyncify_get_state() == 1)
                        asyncify_stop_unwind();
                }
            }
        }
    }

    g_main_thread_asyncify_enabled = false;
    return 0;
}

/* Spawn a guest thread directly (for uv_thread_create bridge).
 * start_arg is a guest address pointing to:
 * { uint32 stack, uint32 tls_base, uint32 start_func, uint32 start_arg }
 * Returns TID on success, negative on error. */
__attribute__((export_name("kernel_thread_spawn")))
int32_t
kernel_thread_spawn(uint32_t start_arg)
{
    if (!g_guest_instance || !g_guest_exec_env)
        return -1;

    /* Call the guest's wasi.thread-spawn import indirectly.
     * WAMR's thread_spawn_wrapper handles creating the new instance
     * and registering with our cooperative scheduler. */

    /* We need to call wasm_runtime_call_indirect on the wasi.thread-spawn
     * import. But imports aren't callable via call_indirect.
     * Instead, we simulate what the guest would do: call the native
     * thread_spawn_wrapper directly. */
    extern int32_t thread_spawn_wrapper(wasm_exec_env_t, uint32_t);

    int32_t tid = thread_spawn_wrapper(g_guest_exec_env, start_arg);
    return tid;
}

__attribute__((export_name("kernel_debug_spin_addr")))
uint32_t kernel_debug_spin_addr(void) {
    for (uint32_t i = 1; i < g_scheduler.num_threads; i++) {
        if (g_scheduler.threads[i].exec_env)
            return g_scheduler.threads[i].exec_env->_spin_addr;
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

/* Minimum initial memory pages to force on the next kernel_load. Used
 * to match emnapi's `new WebAssembly.Memory({initial: 4000, ...})` that
 * the published `parser.wasi.cjs` passes in via overwriteImports, so
 * napi-rs guests see the same initial pool size as they would on V8.
 *
 * This is not a sidestep of a WAMR interpreter bug: napi-rs guests
 * actually declare initial=980 pages but emnapi REPLACES the import
 * with a 4000-page memory at load time. Our WAMR build reads the
 * declared 980, Rust's wasi-libc allocator places the heap based on
 * that, and the resulting addresses differ from V8's. Setting this
 * to 4000 before kernel_load makes us match V8's effective layout.
 *
 * 0 = don't override (use module-declared initial). */
__attribute__((export_name("kernel_set_min_initial_pages")))
void
kernel_set_min_initial_pages(uint32_t pages)
{
    g_min_initial_pages = pages;
}

/* Wall-clock watchdog. The host calls this to set a budget (in
 * milliseconds from now) for guest execution. If the scheduler finds
 * the deadline has passed, it terminates all threads and kernel_step
 * returns -1. Pass 0 to disable.
 *
 * The watchdog is checked at the top of every scheduler tick, so it
 * bounds how long a guest can run BETWEEN host-initiated calls. It
 * does not interrupt direct kernel_call / kernel_call_indirect paths,
 * which are meant for short host-initiated callbacks. The host should
 * also track wall-clock around those and kill the process if they
 * exceed a hard limit — that's a separate concern.
 *
 * A reasonable default for production: 5000 ms. Compute-heavy workloads
 * (argon2 with high memoryCost, big parser runs) might need 30000 ms. */
__attribute__((export_name("kernel_set_watchdog_ms")))
void
kernel_set_watchdog_ms(uint32_t ms)
{
    if (ms == 0) {
        g_scheduler.watchdog_deadline_us = 0;
        g_scheduler.watchdog_tripped = false;
        return;
    }
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    uint64_t now_us = (uint64_t)ts.tv_sec * 1000000ULL
                      + (uint64_t)ts.tv_nsec / 1000ULL;
    g_scheduler.watchdog_deadline_us = now_us + (uint64_t)ms * 1000ULL;
    g_scheduler.watchdog_tripped = false;
}

__attribute__((export_name("kernel_watchdog_tripped")))
uint32_t
kernel_watchdog_tripped(void)
{
    return g_scheduler.watchdog_tripped ? 1 : 0;
}

/* Set the per-instance maximum thread count. Capped at WASMKERNEL_MAX_THREADS
 * (compile-time array bound). Affects WAMR's wasi-threads spawn limit so the
 * guest sees thread_spawn return -1 once the cap is hit. */
__attribute__((export_name("kernel_set_max_threads")))
void
kernel_set_max_threads(uint32_t max_threads)
{
    if (max_threads == 0)
        max_threads = 1;
    if (max_threads > WASMKERNEL_MAX_THREADS)
        max_threads = WASMKERNEL_MAX_THREADS;
    wasm_runtime_set_max_thread_num(max_threads);
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
