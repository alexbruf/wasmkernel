/*
 * Asyncify stub functions — replaced by wasm-opt --asyncify post-build.
 * These exist only to satisfy the linker during compilation.
 */

void asyncify_start_unwind(void *data) { (void)data; }
void asyncify_stop_unwind(void) {}
void asyncify_start_rewind(void *data) { (void)data; }
void asyncify_stop_rewind(void) {}
int asyncify_get_state(void) { return 0; /* normal */ }
