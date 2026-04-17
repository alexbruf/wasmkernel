/* bigalloc — capacity test for wasmkernel's paged guest memory.
 *
 * Allocates a big chunk of wasm-heap memory (default 512 MB), writes a
 * deterministic pattern across every page, then reads every page back
 * and verifies. Pattern is position-dependent so missed/misdirected
 * pages corrupt the checksum immediately.
 *
 * Build: wasi-sdk clang --target=wasm32-wasi -O2 tests/guest/bigalloc.c \
 *        -o tests/guest/bigalloc.wasm \
 *        -Wl,--max-memory=1073741824  (1 GB max memory)
 *
 * Run: the host instantiates with a small hot window (e.g. 100 pages)
 * and either an in-memory or SQLite backend. The guest accesses far more
 * logical memory than the hot window contains, forcing heavy slot
 * cycling. Measures throughput as a side effect (total bytes touched
 * / wall-clock seconds).
 *
 * Pass via: command-line argv[1] = chunk size in MB (default 512). */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>

#define PAGE 65536u

/* Per-page tag: mix offset + a constant so the byte at (page, off) is
   deterministic but cheap to compute. Guest never stores the tag — it's
   pure function of the address — so any paging bug shows up as checksum
   mismatch. */
static inline uint8_t tag(uint64_t addr) {
    return (uint8_t)((addr * 0x9e3779b1u) >> 24);
}

int main(int argc, char **argv) {
    /* Size via BIGALLOC_MB env var (parsed via getenv). Default 128 MB. */
    const char *env = getenv("BIGALLOC_MB");
    size_t mb = env ? (size_t)atoll(env) : 128;
    (void)argc; (void)argv;
    size_t total_bytes = mb * 1024u * 1024u;

    printf("bigalloc: requesting %zu MB (%zu bytes)\n", mb, total_bytes);

    /* Allocate in chunks so we can fit within the wasi-libc allocator's
       per-request limits and see progress if the allocator fails. */
    size_t chunk_bytes = 1u * 1024u * 1024u;  /* 1 MB per chunk */
    size_t n_chunks = total_bytes / chunk_bytes;
    uint8_t **chunks = (uint8_t **)malloc(n_chunks * sizeof(uint8_t *));
    if (!chunks) { printf("FAIL: chunk array alloc\n"); return 1; }

    for (size_t i = 0; i < n_chunks; i++) {
        chunks[i] = (uint8_t *)malloc(chunk_bytes);
        if (!chunks[i]) {
            printf("FAIL: chunk %zu alloc (total so far %zu MB)\n",
                   i, i * chunk_bytes / (1024*1024));
            return 1;
        }
        if ((i & 0xf) == 0)
            printf("  alloc progress: %zu / %zu chunks\n", i + 1, n_chunks);
    }
    printf("alloc done: %zu chunks of %zu MB each\n",
           n_chunks, chunk_bytes / (1024*1024));

    /* Write pattern. Every byte at global offset `g` (relative to the
       logical start of chunk 0) gets tag(g). Using a per-byte tag is
       wasteful but it means a single swapped byte is detectable — we
       don't want to assume the paging code is correct at sub-byte level. */
    printf("writing pattern...\n");
    for (size_t i = 0; i < n_chunks; i++) {
        uint8_t *c = chunks[i];
        for (size_t j = 0; j < chunk_bytes; j++) {
            c[j] = tag((uint64_t)i * chunk_bytes + j);
        }
        if ((i & 0xf) == 0)
            printf("  write progress: %zu / %zu chunks\n", i + 1, n_chunks);
    }
    printf("write done.\n");

    /* Read back and verify. Pick a few representative offsets per chunk
       plus the chunk boundaries where cross-page accesses happen. */
    printf("verifying...\n");
    size_t mismatches = 0;
    for (size_t i = 0; i < n_chunks; i++) {
        uint8_t *c = chunks[i];
        /* Sweep the full chunk — any bad byte from a paging miss would
           show up as a checksum mismatch. */
        for (size_t j = 0; j < chunk_bytes; j++) {
            uint8_t expect = tag((uint64_t)i * chunk_bytes + j);
            if (c[j] != expect) {
                if (mismatches < 5) {
                    printf("  MISMATCH chunk=%zu off=%zu expect=0x%02x got=0x%02x\n",
                           i, j, expect, c[j]);
                }
                mismatches++;
            }
        }
        if ((i & 0xf) == 0)
            printf("  verify progress: %zu / %zu chunks (mismatches so far=%zu)\n",
                   i + 1, n_chunks, mismatches);
    }

    if (mismatches) {
        printf("FAIL: %zu byte mismatches across %zu MB\n", mismatches, mb);
        return 1;
    }
    printf("PASS: verified %zu MB across %zu chunks — all pattern bytes match\n",
           mb, n_chunks);

    /* Don't free: exit is faster and the point is to hold the whole
       working set live. */
    return 0;
}
