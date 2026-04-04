/*
 * sleep_and_compute: Two threads run concurrently.
 * Thread 0: uses poll_oneoff (clock) to sleep, then checks result.
 * Thread 1: computes sum(1..1000) while thread 0 sleeps.
 *
 * Verifies that poll_oneoff clock subscriptions work and that
 * the scheduler runs other threads while one is sleeping.
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

__attribute__((import_module("wasi"), import_name("thread-spawn")))
int32_t __imported_wasi_thread_spawn(int32_t start_arg);

__attribute__((import_module("wasi_snapshot_preview1"), import_name("poll_oneoff")))
int32_t __imported_wasi_poll_oneoff(
    const void *in, void *out, uint32_t nsubscriptions, uint32_t *nevents);

__attribute__((export_name("wasi_thread_start")))
void wasi_thread_start(int32_t tid, int32_t start_arg);

static volatile int32_t g_compute_result = 0;
static volatile int32_t g_compute_done = 0;

void wasi_thread_start(int32_t tid, int32_t start_arg)
{
    (void)tid;
    (void)start_arg;

    /* Compute sum(1..1000) */
    int32_t sum = 0;
    for (int32_t i = 1; i <= 1000; i++)
        sum += i;

    g_compute_result = sum;
    __atomic_store_n((int32_t *)&g_compute_done, 1, __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify((int32_t *)&g_compute_done, 1);
}

/* poll_oneoff subscription for a relative clock timeout */
typedef struct {
    uint64_t userdata;
    uint8_t  tag;        /* 0 = clock */
    uint8_t  pad1[7];
    uint32_t clock_id;   /* 1 = MONOTONIC */
    uint32_t pad2;
    uint64_t timeout;    /* nanoseconds */
    uint64_t precision;
    uint16_t flags;      /* 0 = relative */
    uint8_t  pad3[6];
} __attribute__((packed)) poll_subscription_t;

typedef struct {
    uint64_t userdata;
    uint16_t error;
    uint8_t  type;
    uint8_t  pad[5];
    uint64_t nbytes;
    uint16_t flags;
    uint8_t  pad2[6];
} __attribute__((packed)) poll_event_t;

int main(void)
{
    printf("sleep_and_compute: starting\n");

    /* Spawn compute thread */
    int32_t tid = __imported_wasi_thread_spawn(0);
    if (tid <= 0) {
        printf("FAIL: spawn returned %d\n", tid);
        return 1;
    }

    /* Sleep for 1ms using poll_oneoff */
    poll_subscription_t sub;
    memset(&sub, 0, sizeof(sub));
    sub.userdata = 42;
    sub.tag = 0; /* clock */
    sub.clock_id = 1; /* MONOTONIC */
    sub.timeout = 1000000; /* 1ms in nanoseconds */
    sub.flags = 0; /* relative */

    poll_event_t evt;
    memset(&evt, 0, sizeof(evt));
    uint32_t nevents = 0;

    int32_t rc = __imported_wasi_poll_oneoff(&sub, &evt, 1, &nevents);
    if (rc != 0) {
        printf("FAIL: poll_oneoff returned %d\n", rc);
        return 1;
    }

    /* Wait for compute thread if not done yet */
    while (__atomic_load_n((int32_t *)&g_compute_done, __ATOMIC_SEQ_CST) == 0) {
        __builtin_wasm_memory_atomic_wait32(
            (int32_t *)&g_compute_done, 0, 100000000LL);
    }

    int32_t expected = 500500;
    if (g_compute_result == expected && nevents == 1 && evt.userdata == 42) {
        printf("sleep_and_compute ok: sum=%d nevents=%d userdata=%llu\n",
               g_compute_result, nevents, (unsigned long long)evt.userdata);
        return 0;
    } else {
        printf("FAIL: sum=%d (expected %d), nevents=%d, userdata=%llu\n",
               g_compute_result, expected, nevents,
               (unsigned long long)evt.userdata);
        return 1;
    }
}
