/*
 * Phase 2 test: basic thread spawning using the wasi-threads API.
 * Spawns a thread that writes a value to shared memory.
 * Main thread waits for it using atomic wait/notify.
 */
#include <stdint.h>
#include <stdio.h>
#include <wasi/api.h>

/* Shared state between main and spawned thread */
static volatile int32_t g_done = 0;
static volatile int32_t g_value = 0;
static volatile int32_t g_tid = 0;

/* wasi_thread_start — called by the runtime in the new thread */
void __wasi_thread_start(int32_t tid, int32_t start_arg)
{
    g_tid = tid;
    g_value = start_arg + 100;

    /* Signal done */
    __atomic_store_n((int32_t *)&g_done, 1, __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify((int32_t *)&g_done, 1);
}

int main(void)
{
    /* Spawn a thread with start_arg = 42 */
    int32_t tid = __wasi_thread_spawn((void *)42);
    if (tid < 0) {
        printf("FAIL: thread_spawn returned %d\n", tid);
        return 1;
    }
    printf("spawned tid=%d\n", tid);

    /* Wait for thread to signal done */
    __builtin_wasm_memory_atomic_wait32((int32_t *)&g_done, 0,
                                        1000000000LL /* 1 sec */);

    if (g_done != 1) {
        printf("FAIL: thread did not signal done\n");
        return 1;
    }
    if (g_value != 142) {
        printf("FAIL: expected value=142, got %d\n", g_value);
        return 1;
    }
    if (g_tid != tid) {
        printf("FAIL: expected tid=%d, got %d\n", tid, g_tid);
        return 1;
    }

    printf("thread_spawn ok: tid=%d value=%d\n", g_tid, g_value);
    return 0;
}
