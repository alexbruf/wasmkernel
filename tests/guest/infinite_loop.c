/* Infinite loop guest — tests that the wall-clock watchdog trips. */
int main(void) {
    volatile int x = 0;
    while (1) { x++; }
    return x;
}
