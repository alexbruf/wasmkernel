/*
 * Parallel sum: 4 threads each sum a range of numbers.
 * Thread 0: sum(1..250), Thread 1: sum(251..500), etc.
 * Expected total: sum(1..1000) = 500500
 */
#include <stdint.h>
#include <stdio.h>

__attribute__((import_module("wasi"), import_name("thread-spawn")))
int32_t __imported_wasi_thread_spawn(int32_t start_arg);

__attribute__((export_name("wasi_thread_start")))
void wasi_thread_start(int32_t tid, int32_t start_arg);

#define NUM_THREADS 4
#define TOTAL_N 1000

static volatile int32_t g_partial_sums[NUM_THREADS];
static volatile int32_t g_done_count = 0;

void wasi_thread_start(int32_t tid, int32_t start_arg)
{
    (void)tid;
    int32_t idx = start_arg;
    int32_t chunk = TOTAL_N / NUM_THREADS;
    int32_t start = idx * chunk + 1;
    int32_t end = (idx + 1) * chunk;

    int32_t sum = 0;
    for (int32_t i = start; i <= end; i++) {
        sum += i;
    }

    g_partial_sums[idx] = sum;
    printf("  thread %d: sum(%d..%d) = %d\n", idx, start, end, sum);

    __atomic_fetch_add((int32_t *)&g_done_count, 1, __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify((int32_t *)&g_done_count, 1);
}

int main(void)
{
    printf("parallel_sum: computing sum(1..%d) with %d threads\n",
           TOTAL_N, NUM_THREADS);

    for (int i = 0; i < NUM_THREADS; i++) {
        int32_t tid = __imported_wasi_thread_spawn(i);
        if (tid <= 0) {
            printf("FAIL: spawn %d returned %d\n", i, tid);
            return 1;
        }
    }

    while (__atomic_load_n((int32_t *)&g_done_count, __ATOMIC_SEQ_CST)
           < NUM_THREADS) {
        __builtin_wasm_memory_atomic_wait32(
            (int32_t *)&g_done_count,
            __atomic_load_n((int32_t *)&g_done_count, __ATOMIC_SEQ_CST),
            100000000LL);
    }

    int32_t total = 0;
    for (int i = 0; i < NUM_THREADS; i++)
        total += g_partial_sums[i];

    int32_t expected = TOTAL_N * (TOTAL_N + 1) / 2;
    printf("total = %d (expected %d) %s\n", total, expected,
           total == expected ? "OK" : "FAIL");
    return total == expected ? 0 : 1;
}
