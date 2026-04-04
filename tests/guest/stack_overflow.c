/*
 * stack_overflow: Infinite recursion to test stack overflow detection.
 * Should trap cleanly rather than corrupting memory.
 */
#include <stdint.h>
#include <stdio.h>

volatile int32_t g_depth = 0;

int recurse(int n)
{
    g_depth++;
    return recurse(n + 1) + n;
}

int main(void)
{
    printf("stack_overflow: starting infinite recursion\n");
    int result = recurse(0);
    /* Should never reach here */
    printf("FAIL: recursion returned %d at depth %d\n", result, g_depth);
    return 1;
}
