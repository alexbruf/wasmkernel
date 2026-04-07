#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Building wasmkernel.wasm ==="
cmake -B build -DCMAKE_TOOLCHAIN_FILE=cmake/wasi-sdk.cmake -DCMAKE_BUILD_TYPE=Release 2>&1 | tail -3
cmake --build build 2>&1 | tail -3

echo "=== Applying asyncify transform ==="
wasm-opt --asyncify build/wasmkernel.wasm -o build/wasmkernel.wasm
echo "  asyncify done ($(wc -c < build/wasmkernel.wasm) bytes)"

WASI_SDK="${WASI_SDK_PATH:-/tmp/wasi-sdk-25.0-arm64-macos}"
CC="$WASI_SDK/bin/clang"

echo ""
echo "=== Compiling single-threaded guest tests ==="
for src in tests/guest/hello.c tests/guest/exit42.c tests/guest/trap.c \
           tests/guest/alloc.c tests/guest/args.c tests/guest/poll_sleep.c; do
    [ -f "$src" ] || continue
    out="${src%.c}.wasm"
    "$CC" --target=wasm32-wasi -O2 "$src" -o "$out"
    echo "  $(basename "$out")"
done

# stack_overflow needs -O0 so clang doesn't optimize the recursion into a loop
if [ -f tests/guest/stack_overflow.c ]; then
    "$CC" --target=wasm32-wasi -O0 tests/guest/stack_overflow.c -o tests/guest/stack_overflow.wasm
    echo "  stack_overflow.wasm (-O0)"
fi

echo ""
echo "=== Compiling threaded guest tests ==="
THREAD_FLAGS="-matomics -mbulk-memory -Wl,--shared-memory,--import-memory,--export-memory,--max-memory=1048576 -Wl,--export=wasi_thread_start"
for src in tests/guest/thread_raw.c tests/guest/mutex_counter.c \
           tests/guest/many_threads.c tests/guest/parallel_sum.c \
           tests/guest/thread_simple.c tests/guest/thread_spawn.c \
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

echo ""
echo "=== Compiling WAMR wasi-threads test suite ==="
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
    echo "  wamr_$(basename "$src").wasm"
done

echo ""
echo "=== Binary sizes ==="
ls -la build/wasmkernel.wasm | awk '{print "  kernel: " $5 " bytes"}'

echo ""
echo "=== Running tests ==="
bun test tests/
