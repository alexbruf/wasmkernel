/*
 * Raw wasi-threads test — no pthread, no wasi-libc threading.
 * Uses the low-level thread-spawn import directly.
 */
#include <stdint.h>
#include <stdio.h>

/* Import thread-spawn from the wasi module */
__attribute__((import_module("wasi"), import_name("thread-spawn")))
int32_t __imported_wasi_thread_spawn(int32_t start_arg);

/* Export wasi_thread_start — called by runtime for new threads */
__attribute__((export_name("wasi_thread_start")))
void wasi_thread_start(int32_t tid, int32_t start_arg);

/* Shared state */
static volatile int32_t g_value = 0;
static volatile int32_t g_done = 0;
static volatile int32_t g_tid = 0;

void wasi_thread_start(int32_t tid, int32_t start_arg)
{
    g_tid = tid;
    g_value = start_arg + 100;

    /* Signal done */
    __atomic_store_n((int32_t *)&g_done, 1, __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify((int32_t *)&g_done, 1);
}

int main(void)
{
    int32_t tid = __imported_wasi_thread_spawn(42);
    if (tid <= 0) {
        printf("FAIL: thread_spawn returned %d\n", tid);
        return 1;
    }
    printf("spawned tid=%d\n", tid);

    /* Wait for done */
    while (__atomic_load_n((int32_t *)&g_done, __ATOMIC_SEQ_CST) == 0) {
        __builtin_wasm_memory_atomic_wait32((int32_t *)&g_done, 0,
                                            100000000LL);
    }

    if (g_value != 142) {
        printf("FAIL: expected 142 got %d\n", g_value);
        return 1;
    }
    printf("thread_raw ok: tid=%d value=%d\n", g_tid, g_value);
    return 0;
}
