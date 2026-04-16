/*
 * Reproduces the rolldown-async hang documented in
 * wasmkernel-issue-rolldown-async.md.
 *
 * Exposes runAsync(value) which:
 *   1. Creates a Promise via napi_create_promise
 *   2. Spawns a wasi-threads worker
 *   3. Returns the Promise immediately
 *
 * The worker runs entirely in the cooperative scheduler — it does some
 * "work" (sleep via memory_atomic_wait32 with a short timeout to let
 * other threads run), then calls napi_resolve_deferred from inside its
 * own context. Without the host-side step pump, the worker never gets
 * scheduled after runAsync returns and the Promise hangs forever.
 *
 * Built as a reactor with napi imports from "env".
 */
#include <stdint.h>
#include <stddef.h>

/* === Minimal napi types we need (subset of js_native_api.h) === */
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef struct napi_deferred__ *napi_deferred;
typedef int32_t napi_status;

#define NAPI_OK 0

typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

#define NAPI __attribute__((__import_module__("env")))

NAPI napi_status napi_create_promise(napi_env env, napi_deferred *deferred,
                                     napi_value *result);
NAPI napi_status napi_resolve_deferred(napi_env env, napi_deferred deferred,
                                       napi_value resolution);
NAPI napi_status napi_create_int64(napi_env env, int64_t v, napi_value *r);
NAPI napi_status napi_create_string_utf8(napi_env env, const char *str,
                                         size_t length, napi_value *result);
NAPI napi_status napi_create_function(napi_env env, const char *utf8name,
                                      size_t length, napi_callback cb,
                                      void *data, napi_value *result);
NAPI napi_status napi_set_named_property(napi_env env, napi_value object,
                                         const char *utf8name,
                                         napi_value value);
NAPI napi_status napi_get_cb_info(napi_env env, napi_callback_info cbinfo,
                                  size_t *argc, napi_value *argv,
                                  napi_value *this_arg, void **data);
NAPI napi_status napi_get_value_int32(napi_env env, napi_value v, int32_t *r);
NAPI napi_status napi_get_undefined(napi_env env, napi_value *result);

/* wasi-threads thread-spawn import */
__attribute__((import_module("wasi"), import_name("thread-spawn")))
int32_t __imported_wasi_thread_spawn(int32_t start_arg);

/* Export wasi_thread_start — called by runtime for new threads */
__attribute__((export_name("wasi_thread_start")))
void wasi_thread_start(int32_t tid, int32_t start_arg);

/* Per-job state. Static so the worker can pick it up by index. */
#define MAX_JOBS 16
typedef struct {
    napi_env env;
    napi_deferred deferred;
    int32_t input;
    volatile int32_t in_use;
} Job;
static Job g_jobs[MAX_JOBS];
static volatile int32_t g_next_job = 0;

void wasi_thread_start(int32_t tid, int32_t job_idx)
{
    (void)tid;
    if (job_idx < 0 || job_idx >= MAX_JOBS) return;
    Job *j = &g_jobs[job_idx];

    /* Simulate some work — a few short cooperative waits so the
     * scheduler has to round-trip through us multiple times. */
    for (int i = 0; i < 4; i++) {
        volatile int32_t flag = 0;
        __builtin_wasm_memory_atomic_wait32((int32_t *)&flag, 0, 1000000LL);
    }

    /* Resolve the promise from the worker. The host-side pump is what
     * makes this call reach the dispatcher: it drives kernel_step so
     * that this thread gets to execute. */
    napi_value result;
    napi_create_int64(j->env, (int64_t)(j->input + 100), &result);
    napi_resolve_deferred(j->env, j->deferred, result);

    j->in_use = 0;
}

static napi_value run_async(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

    int32_t input = 0;
    if (argc >= 1) napi_get_value_int32(env, argv[0], &input);

    /* Find a free job slot */
    int32_t idx = -1;
    for (int i = 0; i < MAX_JOBS; i++) {
        int32_t expected = 0;
        if (__atomic_compare_exchange_n(&g_jobs[i].in_use, &expected, 1,
                                         0, __ATOMIC_SEQ_CST,
                                         __ATOMIC_SEQ_CST)) {
            idx = i;
            break;
        }
    }
    if (idx < 0) {
        napi_value undef;
        napi_get_undefined(env, &undef);
        return undef;
    }

    napi_deferred deferred;
    napi_value promise;
    napi_create_promise(env, &deferred, &promise);

    g_jobs[idx].env = env;
    g_jobs[idx].deferred = deferred;
    g_jobs[idx].input = input;

    int32_t tid = __imported_wasi_thread_spawn(idx);
    if (tid <= 0) {
        /* Fall back to inline resolution so JS doesn't hang on spawn
         * failure (real-world this would reject). */
        napi_value result;
        napi_create_int64(env, (int64_t)(input + 100), &result);
        napi_resolve_deferred(env, deferred, result);
        g_jobs[idx].in_use = 0;
    }

    return promise;
}

/* === Module registration === */
NAPI napi_value napi_register_wasm_v1(napi_env env, napi_value exports);

napi_value napi_register_wasm_v1(napi_env env, napi_value exports)
{
    napi_value fn;
    napi_create_function(env, "runAsync", 8, run_async, NULL, &fn);
    napi_set_named_property(env, exports, "runAsync", fn);
    return exports;
}
