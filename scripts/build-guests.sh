#!/bin/bash
# Compile all guest C programs in tests/guest/ to wasm32-wasi (or
# wasm32-wasi-threads where applicable). Used by the test suite.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WASI_SDK="${WASI_SDK_PATH:-/tmp/wasi-sdk-25.0-arm64-macos}"
if [ ! -x "${WASI_SDK}/bin/clang" ]; then
    echo "error: wasi-sdk clang not found at ${WASI_SDK}/bin/clang" >&2
    echo "       set WASI_SDK_PATH or run scripts/install-wasi-sdk.sh first" >&2
    exit 1
fi
CC="${WASI_SDK}/bin/clang"

echo "=== single-threaded guests ==="
for src in tests/guest/hello.c tests/guest/exit42.c tests/guest/trap.c \
           tests/guest/alloc.c tests/guest/args.c tests/guest/poll_sleep.c \
           tests/guest/infinite_loop.c; do
    [ -f "$src" ] || continue
    out="${src%.c}.wasm"
    "$CC" --target=wasm32-wasi -O2 "$src" -o "$out"
    echo "  $(basename "$out")"
done

# stack_overflow needs -O0 so clang doesn't fold the recursion into a loop
if [ -f tests/guest/stack_overflow.c ]; then
    "$CC" --target=wasm32-wasi -O0 tests/guest/stack_overflow.c -o tests/guest/stack_overflow.wasm
    echo "  stack_overflow.wasm (-O0)"
fi

echo "=== threaded guests ==="
# Only compile the guests actually exercised by tests/wasmkernel.test.ts.
# thread_simple.c / thread_spawn.c / parallel_sum.c are dev-era scratch
# programs still in tests/guest/ but not part of the suite.
THREAD_FLAGS="-matomics -mbulk-memory -Wl,--shared-memory,--import-memory,--export-memory,--max-memory=1048576 -Wl,--export=wasi_thread_start"
for src in tests/guest/thread_raw.c tests/guest/mutex_counter.c \
           tests/guest/many_threads.c \
           tests/guest/sleep_and_compute.c tests/guest/fuel_fairness.c; do
    [ -f "$src" ] || continue
    out="${src%.c}.wasm"
    "$CC" --target=wasm32-wasi-threads $THREAD_FLAGS -O2 "$src" -o "$out"
    echo "  $(basename "$out")"
done

# Reactor-mode guest with indirect function table for kernel_call_indirect test
if [ -f tests/guest/asyncify_indirect.c ]; then
    "$CC" --target=wasm32-wasi-threads -O2 \
        -matomics -mbulk-memory -mexec-model=reactor \
        -Wl,--shared-memory,--import-memory,--export-memory,--max-memory=1048576 \
        -Wl,--export=get_simple_add_idx \
        -Wl,--export=get_yield_loop_idx \
        -Wl,--export=get_called_count \
        -Wl,--export=__indirect_function_table \
        tests/guest/asyncify_indirect.c \
        -o tests/guest/asyncify_indirect.wasm
    echo "  asyncify_indirect.wasm"
fi

echo "=== WAMR wasi-threads test suite ==="
WAMR_TEST_DIR="deps/wamr/core/iwasm/libraries/lib-wasi-threads/test"
WAMR_SAMPLES="deps/wamr/samples/wasi-threads/wasm-apps"
WAMR_FLAGS="-pthread -ftls-model=local-exec -z stack-size=32768"
WAMR_LINK="-Wl,--export=__heap_base -Wl,--export=__data_end -Wl,--shared-memory,--max-memory=1966080 -Wl,--export=wasi_thread_start -Wl,--export=malloc -Wl,--export=free"

for src in global_atomic spawn_multiple_times \
           nonmain_proc_exit_wait nonmain_proc_exit_busy \
           nonmain_trap_wait nonmain_trap_busy; do
    out="tests/guest/wamr_${src}.wasm"
    "$CC" -target wasm32-wasi-threads -O2 $WAMR_FLAGS $WAMR_LINK \
        -I "$WAMR_SAMPLES" \
        "$WAMR_SAMPLES/wasi_thread_start.S" \
        "$WAMR_TEST_DIR/${src}.c" \
        -o "$out"
    echo "  wamr_${src}.wasm"
done
