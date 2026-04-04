#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
    /* Allocate and use 64KB */
    size_t size = 64 * 1024;
    char *buf = (char *)malloc(size);
    if (!buf) {
        printf("malloc failed\n");
        return 1;
    }
    memset(buf, 'A', size);
    if (buf[0] == 'A' && buf[size - 1] == 'A') {
        printf("alloc ok: %zu bytes\n", size);
    } else {
        printf("memset failed\n");
        free(buf);
        return 1;
    }
    free(buf);
    return 0;
}
