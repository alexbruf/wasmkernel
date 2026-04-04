/*
 * Phase 2 test: spawn 8 threads, all complete.
 * Each thread writes its TID to a slot in shared memory.
 */
#include <stdint.h>
#include <stdio.h>

__attribute__((import_module("wasi"), import_name("thread-spawn")))
int32_t __imported_wasi_thread_spawn(int32_t start_arg);

__attribute__((export_name("wasi_thread_start")))
void wasi_thread_start(int32_t tid, int32_t start_arg);

#define NUM_THREADS 8

static volatile int32_t g_results[NUM_THREADS];
static volatile int32_t g_done_count = 0;

void wasi_thread_start(int32_t tid, int32_t start_arg)
{
    int32_t idx = start_arg;
    if (idx >= 0 && idx < NUM_THREADS) {
        g_results[idx] = tid;
    }

    __atomic_fetch_add((int32_t *)&g_done_count, 1, __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify((int32_t *)&g_done_count, 1);
}

int main(void)
{
    int32_t tids[NUM_THREADS];

    for (int i = 0; i < NUM_THREADS; i++) {
        tids[i] = __imported_wasi_thread_spawn(i);
        if (tids[i] <= 0) {
            printf("FAIL: thread_spawn %d returned %d\n", i, tids[i]);
            return 1;
        }
    }

    /* Wait for all threads */
    while (__atomic_load_n((int32_t *)&g_done_count, __ATOMIC_SEQ_CST)
           < NUM_THREADS) {
        __builtin_wasm_memory_atomic_wait32(
            (int32_t *)&g_done_count,
            __atomic_load_n((int32_t *)&g_done_count, __ATOMIC_SEQ_CST),
            100000000LL);
    }

    /* Verify all threads wrote their TID */
    for (int i = 0; i < NUM_THREADS; i++) {
        if (g_results[i] != tids[i]) {
            printf("FAIL: slot %d expected tid=%d got %d\n",
                   i, tids[i], g_results[i]);
            return 1;
        }
    }

    /* Verify all TIDs are unique */
    for (int i = 0; i < NUM_THREADS; i++) {
        for (int j = i + 1; j < NUM_THREADS; j++) {
            if (tids[i] == tids[j]) {
                printf("FAIL: duplicate TID %d\n", tids[i]);
                return 1;
            }
        }
    }

    printf("many_threads ok: %d threads\n", NUM_THREADS);
    return 0;
}
