cmake_minimum_required(VERSION 3.16)
project(wasmkernel C)

# ===== WAMR configuration =====
set(WAMR_ROOT_DIR ${CMAKE_SOURCE_DIR}/deps/wamr)

# Platform: our custom wasi platform layer
set(WAMR_BUILD_PLATFORM "wasi")
set(SHARED_PLATFORM_CONFIG ${CMAKE_SOURCE_DIR}/src/platform_wasi/shared_platform.cmake)

# Target: X86_32 gives us 32-bit pointer semantics matching wasm32
set(WAMR_BUILD_TARGET "X86_32")

# Interpreter only — no AOT, no JIT
set(WAMR_BUILD_INTERP 1)
set(WAMR_BUILD_FAST_INTERP 1)
set(WAMR_BUILD_AOT 0)
set(WAMR_BUILD_JIT 0)
set(WAMR_BUILD_FAST_JIT 0)

# Guest libc: builtin only (no WASI SSP which requires POSIX)
set(WAMR_BUILD_LIBC_BUILTIN 1)
set(WAMR_BUILD_LIBC_WASI 0)
set(WAMR_BUILD_LIBC_UVWASI 0)

# Threading: cooperative scheduling (Phase 2)
set(WAMR_BUILD_SHARED_MEMORY 1)
set(WAMR_BUILD_THREAD_MGR 1)
set(WAMR_BUILD_LIB_WASI_THREADS 1)
set(WAMR_BUILD_LIB_PTHREAD 0)

# Use generic C invokeNative (no x86/ARM assembly in wasm32)
set(WAMR_BUILD_INVOKE_NATIVE_GENERAL 1)

# Instruction metering (fuel mechanism for cooperative scheduling)
set(WAMR_BUILD_INSTRUCTION_METERING 1)

# Misc
set(WAMR_BUILD_BULK_MEMORY 1)
set(WAMR_BUILD_REF_TYPES 1)
set(WAMR_BUILD_SIMD 0)
set(WAMR_BUILD_DEBUG_INTERP 0)
set(WAMR_BUILD_MINI_LOADER 0)
set(WAMR_BUILD_MULTI_MODULE 0)
set(WAMR_BUILD_SHRUNK_MEMORY 0)  # prevent memory shrinking that breaks memory.grow
set(WAMR_BUILD_WASM_CACHE 0)
set(WAMR_BUILD_MEMORY_TRACING 0)
set(WAMR_BUILD_MEMORY64 0)
set(WAMR_BUILD_GC 0)

# Disable HW bound check (no signals in wasm)
set(WAMR_DISABLE_HW_BOUND_CHECK 1)
set(WAMR_DISABLE_STACK_HW_BOUND_CHECK 1)
set(WAMR_DISABLE_WRITE_GS_BASE 1)
set(WAMR_DISABLE_WAKEUP_BLOCKING_OP 1)

# Include WAMR build system
include(${WAMR_ROOT_DIR}/build-scripts/runtime_lib.cmake)

# ===== WasmKernel target =====
add_executable(wasmkernel
    src/kernel/wasmkernel.c
    src/kernel/scheduler.c
    src/kernel/asyncify_stubs.c
    ${WAMR_RUNTIME_LIB_SOURCE}
)

target_include_directories(wasmkernel PRIVATE
    ${WAMR_ROOT_DIR}/core/iwasm/include
    ${WAMR_ROOT_DIR}/core/iwasm/common
    ${WAMR_ROOT_DIR}/core/shared/utils
    ${WAMR_ROOT_DIR}/core/shared/platform/include
    ${CMAKE_SOURCE_DIR}/src/platform_wasi
    ${CMAKE_SOURCE_DIR}/src/kernel
)

# Reactor model: exports individual functions, no _start
target_link_options(wasmkernel PRIVATE
    -Wl,--export=kernel_init
    -Wl,--export=kernel_alloc
    -Wl,--export=kernel_load
    -Wl,--export=kernel_step
    -Wl,--export=kernel_exit_code
    -Wl,--export=__heap_base
    -Wl,--export=__data_end
)

set_target_properties(wasmkernel PROPERTIES
    OUTPUT_NAME "wasmkernel"
    SUFFIX ".wasm"
)

# Apply asyncify + size-optimize the binary in a single wasm-opt invocation.
#
# - --asyncify: required for blocking host calls (sched_yield, wait32 inside
#   kernel_call_indirect) where the C stack must suspend mid-execution.
# - -Oz: optimise for size. Cuts the binary by ~45% with no measurable
#   runtime cost on the test suite.
# - --strip-debug --strip-producers: drops the debug + producer name
#   sections (we don't need either at runtime).
#
# Combined effect: ~989 KB → ~378 KB (~62% reduction). The smaller binary
# matters most for Cloudflare Workers (where the deployable script size is
# the constraint) and for cold-start compile time.
#
# Set WASMKERNEL_NO_ASYNCIFY=1 to skip the entire wasm-opt step (debug
# builds only — the kernel won't actually work without asyncify).
find_program(WASM_OPT wasm-opt)
if(WASM_OPT AND NOT WASMKERNEL_NO_ASYNCIFY)
    add_custom_command(TARGET wasmkernel POST_BUILD
        COMMAND ${WASM_OPT}
            --asyncify
            -Oz
            --strip-debug
            --strip-producers
            $<TARGET_FILE:wasmkernel> -o $<TARGET_FILE:wasmkernel>
        COMMENT "Applying asyncify + size optimisation (wasm-opt -Oz --strip-debug --strip-producers --asyncify)"
    )
endif()
