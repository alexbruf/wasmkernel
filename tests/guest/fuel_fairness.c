/*
 * fuel_fairness: Two threads run busy loops, both should make progress.
 * Each thread increments its own counter. After both finish,
 * verify both counters advanced (neither starved).
 */
#include <stdint.h>
#include <stdio.h>

__attribute__((import_module("wasi"), import_name("thread-spawn")))
int32_t __imported_wasi_thread_spawn(int32_t start_arg);

__attribute__((export_name("wasi_thread_start")))
void wasi_thread_start(int32_t tid, int32_t start_arg);

#define ITERATIONS 1000

static volatile int32_t g_counter_a = 0;
static volatile int32_t g_counter_b = 0;
static volatile int32_t g_done = 0;

void wasi_thread_start(int32_t tid, int32_t start_arg)
{
    (void)tid;
    (void)start_arg;

    /* Thread B: increment its counter */
    for (int32_t i = 0; i < ITERATIONS; i++) {
        g_counter_b++;
    }

    __atomic_fetch_add((int32_t *)&g_done, 1, __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify((int32_t *)&g_done, 1);
}

int main(void)
{
    int32_t tid = __imported_wasi_thread_spawn(0);
    if (tid <= 0) {
        printf("FAIL: spawn returned %d\n", tid);
        return 1;
    }

    /* Thread A (main): increment its counter */
    for (int32_t i = 0; i < ITERATIONS; i++) {
        g_counter_a++;
    }

    /* Wait for thread B */
    while (__atomic_load_n((int32_t *)&g_done, __ATOMIC_SEQ_CST) < 1) {
        __builtin_wasm_memory_atomic_wait32(
            (int32_t *)&g_done, 0, 100000000LL);
    }

    if (g_counter_a == ITERATIONS && g_counter_b == ITERATIONS) {
        printf("fuel_fairness ok: a=%d b=%d\n", g_counter_a, g_counter_b);
        return 0;
    } else {
        printf("FAIL: a=%d b=%d (expected %d each)\n",
               g_counter_a, g_counter_b, ITERATIONS);
        return 1;
    }
}
