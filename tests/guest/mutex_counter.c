/*
 * Phase 2 test: shared counter with spinlock.
 * Spawns 4 threads that each increment a counter 100 times.
 * Uses atomic compare-and-swap for mutual exclusion.
 * Expected result: counter = 400.
 */
#include <stdint.h>
#include <stdio.h>

__attribute__((import_module("wasi"), import_name("thread-spawn")))
int32_t __imported_wasi_thread_spawn(int32_t start_arg);

__attribute__((export_name("wasi_thread_start")))
void wasi_thread_start(int32_t tid, int32_t start_arg);

#define NUM_THREADS 4
#define INCREMENTS 100

static volatile int32_t g_counter = 0;
static volatile int32_t g_lock = 0;
static volatile int32_t g_done_count = 0;

static void lock(void)
{
    while (__atomic_exchange_n((int32_t *)&g_lock, 1, __ATOMIC_ACQUIRE) != 0) {
        /* spin */
    }
}

static void unlock(void)
{
    __atomic_store_n((int32_t *)&g_lock, 0, __ATOMIC_RELEASE);
}

void wasi_thread_start(int32_t tid, int32_t start_arg)
{
    (void)tid;
    (void)start_arg;

    for (int i = 0; i < INCREMENTS; i++) {
        lock();
        g_counter++;
        unlock();
    }

    __atomic_fetch_add((int32_t *)&g_done_count, 1, __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify((int32_t *)&g_done_count, 1);
}

int main(void)
{
    for (int i = 0; i < NUM_THREADS; i++) {
        int32_t tid = __imported_wasi_thread_spawn(i);
        if (tid <= 0) {
            printf("FAIL: thread_spawn %d returned %d\n", i, tid);
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

    int32_t result = g_counter;
    int32_t expected = NUM_THREADS * INCREMENTS;

    if (result != expected) {
        printf("FAIL: counter=%d expected=%d\n", result, expected);
        return 1;
    }

    printf("mutex_counter ok: %d\n", result);
    return 0;
}
