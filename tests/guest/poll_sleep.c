/*
 * poll_sleep: Simple test of poll_oneoff with a clock subscription.
 * Sleeps for 1ms, verifies the event is returned correctly.
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

__attribute__((import_module("wasi_snapshot_preview1"), import_name("poll_oneoff")))
int32_t __imported_wasi_poll_oneoff(
    const void *in, void *out, uint32_t nsubscriptions, uint32_t *nevents);

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
    poll_subscription_t sub;
    memset(&sub, 0, sizeof(sub));
    sub.userdata = 99;
    sub.tag = 0;
    sub.clock_id = 1; /* MONOTONIC */
    sub.timeout = 1000000; /* 1ms */
    sub.flags = 0; /* relative */

    poll_event_t evt;
    memset(&evt, 0, sizeof(evt));
    uint32_t nevents = 0;

    int32_t rc = __imported_wasi_poll_oneoff(&sub, &evt, 1, &nevents);

    if (rc == 0 && nevents == 1 && evt.userdata == 99 && evt.error == 0) {
        printf("poll_sleep ok\n");
        return 0;
    } else {
        printf("FAIL: rc=%d nevents=%d userdata=%llu error=%d\n",
               rc, nevents, (unsigned long long)evt.userdata, evt.error);
        return 1;
    }
}
