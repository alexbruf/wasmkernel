# WasmKernel: Portable Cooperative Threading for WebAssembly

**Version:** 0.1 (Draft Spec)
**Date:** April 3, 2026
**Status:** Ready for implementation

---

## 1. Problem

WebAssembly has no native thread spawning. The host must provide it. In browsers this requires Web Workers + SharedArrayBuffer (which demands COOP/COEP headers and breaks third-party resources). On Cloudflare Workers, threading is simply unavailable.

The `wasi-threads` proposal defines a single host call (`thread-spawn`) that runtimes like Wasmtime and WAMR implement by mapping to real OS threads. This works on native hosts but not in constrained environments (browser main thread, CF Workers, embedded).

The `wasi-threads` proposal is officially legacy. Its successor (`shared-everything-threads`) is not implemented anywhere yet. There is a standards vacuum.

**WasmKernel fills the gap.** It is a WASM module that implements the `wasi-threads` host contract cooperatively on a single thread. Guest modules compiled for `wasm32-wasi-threads` run unmodified. No SharedArrayBuffer. No Web Workers. No host threading support. One binary runs in browsers, Cloudflare Durable Objects, Node.js, and native WASI runtimes.

---

## 2. Scope

### In scope

- Implement the `wasi-threads` (WASI p1) threading contract: `thread-spawn` host call and `wasi_thread_start` guest export
- Cooperative scheduling of guest threads on a single host thread
- Correct execution of `memory.atomic.wait32/64` and `memory.atomic.notify` across guest threads
- WASI p1 snapshot passthrough for all non-threading imports (`fd_read`, `fd_write`, `clock_time_get`, etc.)
- Async I/O bridge so guest threads blocking on WASI I/O calls don't stall the scheduler
- Run on: browser (in a Web Worker), Cloudflare DO, Node.js, any WASI host

### Out of scope

- True parallelism (this is cooperative concurrency, not parallel execution)
- WASI p2 / component model
- `shared-everything-threads` proposal
- Direct pthread ABI implementation (guests use wasi-libc's pthread layer which compiles down to `thread-spawn` + atomics)

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Host Environment                     │
│              (Browser / CF DO / Node / Native)           │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │                wasmkernel.wasm                      │  │
│  │          (inner runtime compiled to wasm32)         │  │
│  │                                                     │  │
│  │  ┌──────────┐  ┌───────────┐  ┌─────────────────┐  │  │
│  │  │Scheduler │  │ Atomics   │  │ I/O Bridge      │  │  │
│  │  │          │  │ Emulation │  │                  │  │  │
│  │  └────┬─────┘  └─────┬─────┘  └────────┬────────┘  │  │
│  │       │              │                  │           │  │
│  │  ┌────┴──────────────┴──────────────────┴────────┐  │  │
│  │  │          Shared Linear Memory                  │  │  │
│  │  │                                                │  │  │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐       │  │  │
│  │  │  │ Thread 0 │ │ Thread 1 │ │ Thread 2 │  ...  │  │  │
│  │  │  │ (_start) │ │ (spawned)│ │ (spawned)│       │  │  │
│  │  │  └──────────┘ └──────────┘ └──────────┘       │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

The inner runtime is a WASM interpreter (WAMR or Wasm3) compiled to `wasm32-wasi`. It loads a guest `.wasm` module, instantiates it, and interprets its instructions. When the guest calls `thread-spawn`, the inner runtime does **not** create a real thread. Instead, it creates a new interpreter context sharing the same linear memory and registers it with the cooperative scheduler.

---

## 4. The wasi-threads Contract

The entire threading API is one host function and one guest export. Everything else (mutexes, joins, condvars) is built in wasi-libc on top of `memory.atomic.wait`/`notify`.

### 4.1 Host import (provided by WasmKernel to the guest)

```wit
/// Creates a new thread.
thread-spawn: func(start-arg: u32) -> s32
```

- On success: returns a positive unique thread ID (TID)
- On failure: returns a negative error code
- The runtime must instantiate a new logical thread sharing the same memory, then call `wasi_thread_start(tid, start_arg)` on it

### 4.2 Guest export (provided by the guest module)

```wat
(func (export "wasi_thread_start") (param $tid i32) (param $start_arg i32))
```

- Called by the runtime in the new thread's context
- `start_arg` is the same value passed to `thread-spawn`
- When this function returns, the thread ends

### 4.3 Guest module requirements

- Must import shared memory: `(memory (import "env" "memory") 1 1 shared)`
- Must export `wasi_thread_start` with the above signature
- Must export `_start` as the main entry point
- Synchronization uses wasm atomics: `memory.atomic.wait32`, `memory.atomic.wait64`, `memory.atomic.notify`, `i32.atomic.rmw.*`, etc.

### 4.4 Semantics WasmKernel must uphold

- Each spawned thread gets its own call stack but shares the same linear memory
- Thread IDs are positive, unique, and never reused during a single execution
- A trap in any thread terminates all threads (per spec)
- `proc_exit` in any thread terminates all threads

---

## 5. Cooperative Scheduler

### 5.1 How it works

The inner runtime interprets guest wasm. It controls execution at the instruction level. The scheduler interleaves guest threads by running each for a bounded number of instructions (a "fuel budget"), then switching.

### 5.2 Thread states

```
READY       → eligible to be scheduled
RUNNING     → currently executing its fuel budget  
BLOCKED_IO  → waiting on a WASI I/O call to complete
BLOCKED_WAIT→ executed memory.atomic.wait, waiting for notify
EXITED      → wasi_thread_start returned or proc_exit called
```

### 5.3 Scheduler loop (pseudocode)

```
function run(guest_wasm_bytes):
    module = parse_and_validate(guest_wasm_bytes)
    shared_memory = allocate_shared_memory(module)
    
    main_thread = create_thread(module, shared_memory)
    main_thread.entry = "_start"
    main_thread.state = READY
    
    while has_non_exited_threads():
        
        // 1. Check I/O completions
        for op in pending_io:
            if host_io_check(op.id):
                result = host_io_result(op.id)
                write_to_memory(shared_memory, op.buf_ptr, result.data)
                op.thread.io_result = result.bytes_read
                op.thread.state = READY
        
        // 2. Check atomic wait wakeups
        for t in threads_blocked_on_wait:
            if t.wait_address was notified:
                t.state = READY
        
        // 3. Pick next runnable thread (round-robin)
        thread = next_ready_thread()
        
        if thread is null:
            // All threads blocked — yield to host for I/O
            host_io_wait()
            continue
        
        // 4. Run thread for N instructions
        thread.state = RUNNING
        result = interpret(thread, fuel=FUEL_PER_SLICE)
        
        match result:
            FuelExhausted →
                thread.state = READY
            
            ThreadSpawnCalled(start_arg) →
                tid = next_tid()
                new_thread = create_thread(module, shared_memory)
                new_thread.entry = "wasi_thread_start"
                new_thread.args = (tid, start_arg)
                new_thread.state = READY
                thread.return_value = tid  // return TID to caller
                thread.state = READY
            
            AtomicWait(address, expected, timeout) →
                if memory[address] != expected:
                    thread.state = READY  // immediate return (not-equal)
                else:
                    thread.wait_address = address
                    thread.wait_timeout = timeout
                    thread.state = BLOCKED_WAIT
            
            AtomicNotify(address, count) →
                woken = 0
                for t in threads_blocked_on_wait:
                    if t.wait_address == address and woken < count:
                        t.state = READY
                        woken += 1
                thread.notify_result = woken
                thread.state = READY
            
            WasiIoCall(fd, op, buf_ptr, len) →
                id = host_io_submit(fd, op, buf_ptr, len)
                thread.state = BLOCKED_IO
                pending_io.add({ id, thread, buf_ptr })
            
            WasiSyncCall(call_id, args) →
                // Non-blocking WASI: fd_seek, clock_time_get, etc.
                result = host_wasi_passthrough(call_id, args)
                thread.state = READY
            
            FunctionReturned →
                thread.state = EXITED
            
            Trapped →
                // Per spec: trap in any thread kills all
                terminate_all_threads()
                return TRAP
```

### 5.4 Fuel budget

The interpreter must support a **fuel mechanism**: a counter that decrements and causes the interpreter to return to the scheduler when exhausted.

WAMR does not have a built-in fuel mechanism, but it has the infrastructure to add one cheaply. `WASMExecEnv` already has a `suspend_flags` field that the interpreter checks between instructions. We add:

1. A `fuel` field to `WASMExecEnv`
2. A `WASM_SUSPEND_FLAG_YIELD` constant (0x08)
3. At the existing `suspend_flags` check points in `wasm_interp_fast.c` (~20 locations), decrement fuel and set the yield flag when it hits zero
4. Handle `WASM_SUSPEND_FLAG_YIELD` in the same way as `WASM_SUSPEND_FLAG_TERMINATE` but non-fatal — return to caller with a "yielded" status

This is ~50 lines of changes to existing WAMR code.

Default: **10,000 fuel units per slice.** Configurable at init. Lower values improve fairness and I/O responsiveness. Higher values reduce scheduling overhead.

### 5.5 Atomic wait/notify emulation

This is the critical piece that makes wasi-libc's `pthread_mutex_lock`, `pthread_join`, `pthread_cond_wait`, etc. work — they all compile down to `memory.atomic.wait32/64` and `memory.atomic.notify`.

The interpreter must **trap** on these instructions and hand them to the scheduler:

| Instruction | Scheduler behavior |
|---|---|
| `memory.atomic.wait32(addr, expected, timeout)` | If `memory[addr] != expected`, return `not-equal` immediately. Otherwise, block the thread until a `notify` on that address or timeout. |
| `memory.atomic.wait64(addr, expected, timeout)` | Same, 64-bit comparison. |
| `memory.atomic.notify(addr, count)` | Wake up to `count` threads blocked on `addr`. Return number woken. |

Since all execution is single-threaded, the atomic RMW instructions (`i32.atomic.rmw.add`, `i32.atomic.rmw.cmpxchg`, etc.) are trivially correct — there are no data races when only one thread runs at a time. They can be implemented as plain (non-atomic) memory operations.

---

## 6. I/O Bridge

When a guest thread makes a blocking WASI I/O call, the scheduler must not stall. It intercepts the call, submits it to the host asynchronously, and blocks only the calling guest thread.

### 6.1 Which WASI calls are blocking

| Blocking (intercept) | Non-blocking (passthrough) |
|---|---|
| `fd_read` | `fd_seek`, `fd_tell` |
| `fd_write` (to network sockets) | `fd_close` |
| `fd_pread`, `fd_pwrite` | `path_open`, `path_*` |
| `sock_recv`, `sock_send` | `clock_time_get` |
| `poll_oneoff` | `random_get` |
| | `args_get`, `environ_get` |
| | `fd_write` (to stdout/stderr — treat as sync) |

Note: `fd_write` to stdout/stderr can be treated as synchronous and passed through directly since it's typically buffered and fast.

### 6.2 Host adapter interface

WasmKernel imports these from the host. Each platform implements them.

```
// Submit an async I/O operation. Returns immediately.
host_io_submit(callback_id: u32, op_type: u32, fd: u32, buf_offset: u32, len: u32) -> void

// Check if a specific operation completed. Non-blocking.
host_io_check(callback_id: u32) -> bool

// Get result of a completed operation.
host_io_result(callback_id: u32) -> { bytes: u32, error: u32 }

// Block until at least one I/O op completes.
// Browser: await Promise.race(pending)
// CF DO:  await Promise.race(pending)
// Node:   await Promise.race(pending) or Atomics.wait
// Native: epoll_wait / kqueue
host_io_wait() -> void
```

### 6.3 Platform notes

**Browser (Web Worker):** The entire WasmKernel runs in a single Web Worker. `host_io_wait` yields to the Worker's event loop via `await`. No SharedArrayBuffer needed. No COOP/COEP needed.

**Cloudflare Durable Object:** The kernel runs inside a DO's `fetch()` handler or `alarm()`. DOs have no CPU time limit on paid plans and support long-lived async execution. `host_io_wait` is `await Promise.race(...)`. `host_io_submit` fires `fetch()` or CF socket calls.

**Node.js:** Runs in main thread or a worker_thread. `host_io_wait` uses the event loop.

**Native (for dev/test):** Runs the kernel WASM in Wasmtime/WAMR natively. `host_io_wait` calls `epoll_wait`/`kqueue`. Useful for debugging the scheduler without browser/CF complexity.

---

## 7. Inner Runtime: WAMR (WebAssembly Micro Runtime)

### 7.1 Why WAMR

WAMR is the only lightweight interpreter that already implements everything the wasi-threads contract requires:

- **Atomics: fully implemented.** All `0xFE` prefix atomic opcodes handled in both the bytecode loader (`wasm_loader.c`) and the fast interpreter (`wasm_interp_fast.c`).
- **Shared memory: fully implemented.** `wasm_shared_memory.c` handles shared linear memory with wait-address maps and notify wake logic.
- **wasi-threads: fully implemented.** `lib_wasi_threads_wrapper.c` registers the `thread-spawn` native function, allocates TIDs, creates new module instances sharing memory, and calls `wasi_thread_start`.
- **Battle-tested at scale.** Amazon Prime Video, Xiaomi (millions of devices), Intel. Bytecode Alliance maintained.
- **~50KB interpreter-only binary.** Runs on devices with 340KB RAM.
- **Well-factored platform abstraction.** Multiple RTOS ports (NuttX, Zephyr, RT-Thread, ESP-IDF, RIOT) prove the platform layer is portable.

### 7.2 What already works (no changes needed)

| Component | File(s) | Status |
|---|---|---|
| Bytecode validation (all atomics) | `wasm_loader.c` | ✅ Keep as-is |
| Fast interpreter (all atomics) | `wasm_interp_fast.c` | ✅ Keep as-is |
| Shared memory management | `wasm_shared_memory.c` | ✅ Keep structure, replace OS wait backend |
| wasi-threads ABI (thread-spawn) | `lib_wasi_threads_wrapper.c` | ✅ Keep structure, replace thread creation |
| TID allocation | `tid_allocator.c` | ✅ Keep as-is |
| Module instantiation for threads | `wasm_runtime_instantiate_internal` | ✅ Keep as-is |
| Exec environment management | `wasm_exec_env.c` | ✅ Keep as-is |
| Thread cluster bookkeeping | `thread_manager.c` | ✅ Keep structure, replace OS thread calls |

### 7.3 What we replace

**7.3.1 Platform layer: new `platform_wasi/` directory (~400-600 lines)**

| Function | Implementation |
|---|---|
| `os_malloc/realloc/free` | → wasi-libc `malloc/realloc/free` |
| `os_printf/os_vprintf` | → wasi-libc `printf/vprintf` |
| `os_time_get_boot_us` | → `clock_time_get(CLOCK_MONOTONIC)` |
| `os_self_thread` | → return current scheduler thread ID |
| `os_thread_get_stack_boundary` | → return NULL |
| `os_mutex_init/lock/unlock/destroy` | → no-op (single cooperative thread) |
| `os_mmap` | → `malloc` (no executable memory needed, interpreter-only) |
| `os_munmap` | → `free` |
| `os_mremap` | → `realloc` |
| `os_dcache_flush/os_icache_flush` | → no-op (no JIT) |

**7.3.2 Thread creation intercept (`thread_manager.c` line 750, ~50 lines)**

Replace `os_thread_create(&tid, thread_manager_start_routine, ...)` with `wasmkernel_scheduler_add_thread(new_exec_env, thread_manager_start_routine)`. Remove the `os_cond_wait` that synchronizes thread handle initialization — in cooperative mode, handle is set synchronously.

**7.3.3 Atomic wait/notify intercept (`wasm_shared_memory.c`, ~100 lines)**

`wasm_runtime_atomic_wait` (line 279) currently blocks on `os_cond_reltimedwait`. Replace the wait path with `wasmkernel_scheduler_block_on_wait(address, expect, timeout, wait64)` which marks the thread as BLOCKED_WAIT and returns to the scheduler.

`wasm_runtime_atomic_notify` (line 433) currently calls `os_cond_signal`. Replace with `wasmkernel_scheduler_wake_waiters(address, count)` which marks matching blocked threads as READY.

**7.3.4 Fuel / preemption (~50 lines)**

WAMR already has `suspend_flags` on `WASMExecEnv`. The interpreter checks these between instructions. Add `WASM_SUSPEND_FLAG_YIELD = 0x08`. Add a `fuel` field to `WASMExecEnv`. Decrement at existing `suspend_flags` check points in the fast-interp loop. Set `WASM_SUSPEND_FLAG_YIELD` when fuel hits zero. The interpreter returns to the caller with a "yielded" status.

### 7.4 Cooperative scheduler (new code, ~500-1000 lines)

```c
#define WASMKERNEL_MAX_THREADS 64

typedef enum {
    THREAD_READY, THREAD_RUNNING, THREAD_BLOCKED_WAIT,
    THREAD_BLOCKED_IO, THREAD_EXITED
} ThreadState;

typedef struct WasmKernelThread {
    wasm_exec_env_t exec_env;
    wasm_module_inst_t module_inst;
    int32_t tid;
    ThreadState state;
    void *wait_address;        // for atomic.wait
    uint64_t wait_expected;
    int64_t wait_timeout_us;
    uint64_t wait_start_us;
    bool wait64;
    uint32_t io_callback_id;   // for async I/O
    thread_start_routine_t start_routine;
    void *start_arg;
} WasmKernelThread;

typedef struct WasmKernelScheduler {
    WasmKernelThread threads[WASMKERNEL_MAX_THREADS];
    uint32_t num_threads;
    uint32_t current;
    uint32_t fuel_per_slice;
    wasm_module_t module;
    wasm_module_inst_t main_module_inst;
} WasmKernelScheduler;
```

`kernel_step()` runs one scheduler tick: check I/O completions → check wait timeouts → pick next READY thread → set fuel → call `wasm_runtime_call_wasm` → handle result (yielded / blocked / exited / trapped).

### 7.5 Build

```bash
export WASI_SDK_PATH=/opt/wasi-sdk

cmake -DCMAKE_C_COMPILER=$WASI_SDK_PATH/bin/clang \
      -DCMAKE_SYSROOT=$WASI_SDK_PATH/share/wasi-sysroot \
      -DCMAKE_C_FLAGS="--target=wasm32-wasi" \
      -DWAMR_BUILD_PLATFORM=wasi \
      -DWAMR_BUILD_TARGET=WASM32 \
      -DWAMR_BUILD_INTERP=1 \
      -DWAMR_BUILD_FAST_INTERP=1 \
      -DWAMR_BUILD_AOT=0 \
      -DWAMR_BUILD_JIT=0 \
      -DWAMR_BUILD_LIBC_BUILTIN=1 \
      -DWAMR_BUILD_LIB_WASI_THREADS=1 \
      -DWAMR_BUILD_SHARED_MEMORY=1 \
      -DWAMR_BUILD_THREAD_MGR=1 \
      -DWAMR_BUILD_LIB_PTHREAD=0 ..
```

Target output: `wasmkernel.wasm` (~200-400KB estimated)

---

## 8. API Surface

WasmKernel exposes a minimal API to the host.

```
// Initialize the kernel. Call once.
kernel_init() -> void

// Load a guest wasm module (wasm32-wasi-threads target).
// wasm_ptr/wasm_len point into the kernel's linear memory
// where the host has copied the guest .wasm bytes.
kernel_load(wasm_ptr: u32, wasm_len: u32) -> i32  // 0 = ok, <0 = error

// Set WASI args/env for the guest.
kernel_set_args(argc: u32, argv_ptr: u32) -> void
kernel_set_env(envc: u32, env_ptr: u32) -> void

// Run the guest. Returns when all threads exit or a trap occurs.
// On async hosts, this must be called in a loop interleaved
// with host_io_wait.
kernel_step() -> i32
    // Returns:
    //   0  = still running (call again after host_io_wait if needed)
    //   1  = all threads exited normally
    //  -1  = trap
    //  -2  = guest called proc_exit (exit code in kernel_exit_code())

kernel_exit_code() -> i32
```

### 8.1 Host integration (JavaScript example)

```javascript
// Browser or Cloudflare DO
const imports = {
    host: {
        host_io_submit(cb_id, op, fd, buf, len) { /* ... */ },
        host_io_check(cb_id) { /* ... */ },
        host_io_result(cb_id) { /* ... */ },
        host_io_wait() { /* return Promise.race(pending) */ },
    },
    wasi_snapshot_preview1: { /* passthrough WASI for the kernel itself */ }
};

const { instance } = await WebAssembly.instantiate(wasmkernelBytes, imports);
const k = instance.exports;

k.kernel_init();

// Copy guest .wasm into kernel memory, get pointer
const guestBytes = new Uint8Array(guestWasm);
const ptr = k.kernel_alloc(guestBytes.length);
new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);

k.kernel_load(ptr, guestBytes.length);

// Run loop
let status = 0;
while (status === 0) {
    status = k.kernel_step();
    if (status === 0) {
        await imports.host.host_io_wait();
    }
}
```

---

## 9. Correctness Constraints

### 9.1 Atomics

All atomic RMW operations (`i32.atomic.rmw.add`, `.cmpxchg`, `.xchg`, etc.) are trivially correct in single-threaded cooperative execution — only one thread runs at a time, so there are no races. They can be implemented as plain memory operations.

The interpreter **must not** reorder memory operations across a fuel-budget yield point. Since interpretation is sequential and yields happen between instructions, this is naturally satisfied.

### 9.2 Wait/notify ordering

When thread A does `atomic.notify(addr, 1)` and thread B is blocked on `atomic.wait(addr, ...)`:
- The scheduler must check `wait_address` matches
- B must be woken before any subsequently blocked thread on the same address (FIFO ordering)

### 9.3 Thread spawn ordering

After `thread-spawn` returns TID to the caller, the new thread **may or may not** have started yet. The caller must use atomics to synchronize. This matches the real wasi-threads spec — no ordering guarantee between the caller continuing and the new thread starting.

### 9.4 Trap propagation

If any guest thread traps, all threads must terminate immediately. The scheduler clears all thread states and returns a trap status.

---

## 10. Performance Expectations

This is **not** a high-performance threading solution. It's a correctness and portability solution.

| Metric | Estimate | Notes |
|---|---|---|
| Interpretation overhead | 10-15x slower than native | WAMR fast-interp; ~10x vs native in benchmarks |
| Nested interpretation penalty | Additional 10-15x | WAMR interpreting guest inside outer host running WAMR-as-wasm |
| Context switch cost | ~microseconds | Just scheduler bookkeeping, no OS involvement |
| Max practical threads | ~64 | Memory-bound (each thread needs stack + aux stack space) |
| I/O-bound workloads | Comparable to async | Most time is waiting, not computing |
| CPU-bound workloads | No speedup | Single host thread, no parallelism |
| Binary size | ~200-400KB | WAMR interpreter-only, no JIT/AOT |

**Target use cases:** Shell pipelines, I/O multiplexing, producer-consumer patterns, build systems, anything where threads are used for concurrency (not parallelism).

---

## 11. Implementation Phases

### Phase 1: WAMR self-hosting (~1-2 weeks)

- [ ] Create `core/shared/platform/wasi/` platform layer
- [ ] Stub all `platform_api_vmcore.h` functions against wasi-libc
- [ ] Configure CMake build for wasm32-wasi target (interpreter-only, no AOT/JIT)
- [ ] Compile WAMR to `wasmkernel.wasm`
- [ ] Write minimal JS host harness that loads `wasmkernel.wasm` in browser/Node
- [ ] Load and run a trivial single-threaded WASI guest (hello world) inside WAMR-in-WASM
- [ ] Verify WASI passthrough: guest prints to stdout, reads args
- [ ] Measure binary size and baseline interpretation overhead

### Phase 2: Cooperative scheduler (~2-3 weeks)

- [ ] Implement `WasmKernelScheduler` struct and thread management
- [ ] Implement `os_thread_create` → `wasmkernel_scheduler_add_thread` in platform layer
- [ ] Replace `os_thread_create` call in `thread_manager.c:750` with scheduler registration
- [ ] Replace `os_cond_wait/signal` in `wasm_shared_memory.c` with scheduler block/wake
- [ ] Add `WASM_SUSPEND_FLAG_YIELD` and fuel counter to `WASMExecEnv`
- [ ] Instrument fast-interp `suspend_flags` check points to decrement fuel
- [ ] Implement `kernel_step()` export: round-robin scheduling with fuel preemption
- [ ] Test with C program compiled to `wasm32-wasi-threads` that spawns threads and uses mutexes
- [ ] Test `pthread_join` (built on `memory.atomic.wait/notify`)

### Phase 3: I/O bridge (~1-2 weeks)

- [ ] Classify WASI imports as blocking vs. passthrough
- [ ] Implement host adapter interface (`host_io_submit/check/result/wait`)
- [ ] Intercept blocking WASI calls → submit to host, mark thread BLOCKED_IO
- [ ] Implement `poll_oneoff` interception
- [ ] Build JS host adapter for browser (Web Worker) and Cloudflare DO
- [ ] Test with a guest that does concurrent I/O across threads

### Phase 4: Hardening + spec compliance (~1-2 weeks)

- [ ] Trap propagation (any thread traps → all die)
- [ ] `proc_exit` propagation
- [ ] Stack overflow detection per guest thread
- [ ] Timeout support for `memory.atomic.wait` (check in scheduler tick)
- [ ] Fuel budget configuration API
- [ ] Run wasi-threads test suite against WasmKernel
- [ ] Test on all target platforms: browser, CF DO, Node.js

---

## 12. Open Questions

### Resolved via source analysis

1. **Does WAMR have atomics?** ✅ Yes. Full `0xFE` prefix support in both `wasm_loader.c` (validation) and `wasm_interp_fast.c` (execution). All atomic loads, stores, RMW ops, fence, wait, and notify.

2. **Does WAMR have shared memory?** ✅ Yes. `wasm_shared_memory.c` with wait-address maps, locking, notify wake. Shared flag on memory types is fully supported.

3. **Does WAMR have wasi-threads?** ✅ Yes. `lib_wasi_threads_wrapper.c` implements the full `thread-spawn` ABI. TID allocation, module instance cloning, `wasi_thread_start` dispatch.

4. **Where is the thread creation intercept?** `thread_manager.c` line 750 — single `os_thread_create` call. Clear and isolated.

5. **Where is the atomic wait intercept?** `wasm_shared_memory.c` line 279 — `wasm_runtime_atomic_wait` uses `os_cond_reltimedwait`. The compare-and-check logic is above the wait call and stays.

6. **Does WAMR have a fuel mechanism?** ❌ No. But `WASMExecEnv` already has `suspend_flags` checked between instructions. Adding `WASM_SUSPEND_FLAG_YIELD` with a fuel counter is ~50 lines.

### Still open

7. **WAMR wasm32-wasi compilation.** Has anyone compiled WAMR to wasm32-wasi before? The platform layer is well-abstracted, but there may be hidden POSIX assumptions in shared utility code (`bh_platform.h`, `bh_common.h`, etc.). First spike should focus on getting a clean compile.

8. **mmap without mmap.** WAMR's memory management uses `os_mmap` for linear memory allocation. The interpreter-only build path may still call `os_mmap` for the guest's linear memory. Mapping this to `malloc` should work (interpreter doesn't need executable pages), but verify WAMR doesn't depend on mmap semantics like fixed-address allocation or guard pages.

9. **Re-entrancy in the interpreter.** When the cooperative scheduler calls `wasm_runtime_call_wasm` for thread B while thread A's call is "suspended" (fuel exhausted), are there any global variables in the interpreter that conflict? Each thread has its own `WASMExecEnv`, but verify the interpreter is fully re-entrant.

10. **`poll_oneoff` complexity.** wasi-libc uses `poll_oneoff` for timed waits and sleeping. This is a complex WASI call that multiplexes over multiple event sources. Determine the minimum subset needed for wasi-libc's pthread implementation — likely just clock-based timeouts.

11. **Binary size.** Target is <400KB for `wasmkernel.wasm`. WAMR is larger than Wasm3. Profile the build to identify unnecessary code that can be stripped (e.g., WASI filesystem support if not needed, debug logging).

12. **WAMR's `shared_memory_lock` under cooperative scheduling.** The atomic RMW ops in the interpreter acquire `shared_memory_lock(memory)` before each operation. Under cooperative scheduling this is a no-op mutex, so it's safe, but verify there's no deadlock path where the lock is held across a yield point.

---

## 13. References

- [wasi-threads proposal](https://github.com/WebAssembly/wasi-threads) — the spec we implement
- [wasi-threads WIT definition](https://github.com/WebAssembly/wasi-threads/blob/main/wasi-threads.wit.md) — single-function API
- [WAMR GitHub](https://github.com/bytecodealliance/wasm-micro-runtime) — the inner runtime
- [WAMR wasi-threads implementation](https://bytecodealliance.github.io/wamr.dev/blog/introduction-to-wamr-wasi-threads/) — how WAMR implements thread-spawn natively
- [WAMR pthread docs](https://github.com/bytecodealliance/wasm-micro-runtime/blob/main/doc/pthread_library.md) — aux stack partitioning, build flags
- [WAMR platform porting guide](https://github.com/bytecodealliance/wasm-micro-runtime/blob/main/doc/port_wamr.md) — how to write a new platform layer
- [WebAssembly threads proposal](https://github.com/WebAssembly/threads) — the core spec for shared memory and atomics
- [Surma: Spawning a WASI Thread with raw WebAssembly](https://surma.dev/postits/wasi-threads/) — practical walkthrough of the wasi-threads ABI
- [Bytecode Alliance: Announcing wasi-threads](https://bytecodealliance.org/articles/wasi-threads) — history, motivation, instance-per-thread model
- [shared-everything-threads proposal](https://github.com/WebAssembly/shared-everything-threads) — future direction (out of scope for now)

### Key source files in WAMR

| File | Purpose | Our action |
|---|---|---|
| `core/shared/platform/include/platform_api_vmcore.h` | Required platform API | Implement for wasm32-wasi |
| `core/shared/platform/include/platform_api_extension.h` | Threading/socket API | Implement thread ops as scheduler calls |
| `core/iwasm/interpreter/wasm_interp_fast.c` | Fast interpreter (atomics included) | Add fuel check, keep rest as-is |
| `core/iwasm/common/wasm_shared_memory.c` | atomic.wait/notify impl | Replace OS condvar with scheduler block/wake |
| `core/iwasm/libraries/lib-wasi-threads/lib_wasi_threads_wrapper.c` | thread-spawn ABI | Keep as-is (calls thread_manager) |
| `core/iwasm/libraries/thread-mgr/thread_manager.c` | Thread lifecycle | Replace `os_thread_create` (line 750) with scheduler |
| `core/iwasm/common/wasm_exec_env.h` | Exec environment struct | Add fuel field, YIELD flag |
