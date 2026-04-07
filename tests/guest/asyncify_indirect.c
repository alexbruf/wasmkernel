/*
 * asyncify_indirect: tests kernel_call_indirect's asyncify suspend/resume
 * with sched_yield.
 *
 * Two tiers:
 *  1. simple_add: trivial sanity that kernel_call_indirect works at all.
 *  2. yield_loop: calls sched_yield N times in a loop, returns the count.
 *     Each sched_yield triggers asyncify_start_unwind, suspending the entire
 *     C call chain inside kernel_call_indirect. The kernel's resume logic
 *     uses asyncify_start_rewind to continue. For the loop to complete N
 *     iterations, asyncify must correctly suspend and resume across each
 *     yield without losing state (counter must reach N exactly).
 */

#include <stdint.h>
#include <sched.h>

static volatile int g_called = 0;

/* Tier 1 */
__attribute__((visibility("default")))
int simple_add(int x) {
    g_called++;
    return x * 2 + 7;
}

/* Tier 2: yield-loop. Loops N times, calling sched_yield each iteration.
 * Returns the loop counter when done. asyncify must suspend & resume across
 * each yield, preserving the loop state. */
__attribute__((visibility("default")))
int yield_loop(int n) {
    g_called++;
    int counter = 0;
    for (int i = 0; i < n; i++) {
        sched_yield();
        counter++;
    }
    return counter;
}

/* Force functions into the indirect function table */
typedef int (*int_int_fn_t)(int);
static volatile int_int_fn_t g_simple_add_fn = simple_add;
static volatile int_int_fn_t g_yield_loop_fn = yield_loop;

__attribute__((visibility("default")))
int get_simple_add_idx(void) { return (int)(intptr_t)g_simple_add_fn; }
__attribute__((visibility("default")))
int get_yield_loop_idx(void) { return (int)(intptr_t)g_yield_loop_fn; }

__attribute__((visibility("default")))
int get_called_count(void) { return g_called; }
