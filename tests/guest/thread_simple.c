/*
 * Simplest possible thread spawn test using pthreads.
 * Thread writes 142 to shared memory, main joins it.
 */
#include <stdint.h>
#include <stdio.h>
#include <pthread.h>

static volatile int32_t g_value = 0;

static void *thread_func(void *arg)
{
    int32_t input = (int32_t)(intptr_t)arg;
    g_value = input + 100;
    return NULL;
}

int main(void)
{
    printf("before pthread_create\n");
    pthread_t t;
    int ret = pthread_create(&t, NULL, thread_func, (void *)42);
    printf("pthread_create returned %d\n", ret);
    if (ret != 0) {
        printf("FAIL: pthread_create returned %d\n", ret);
        return 1;
    }

    printf("before pthread_join\n");
    pthread_join(t, NULL);
    printf("after pthread_join\n");

    if (g_value != 142) {
        printf("FAIL: expected 142, got %d\n", g_value);
        return 1;
    }

    printf("thread_simple ok: %d\n", g_value);
    return 0;
}
