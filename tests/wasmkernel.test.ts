/**
 * WasmKernel test suite.
 *
 * Tests the kernel by loading guest .wasm modules and verifying
 * return codes and output via subprocess execution.
 */

import { describe, test, expect } from "bun:test";
import { statSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const KERNEL_PATH = join(ROOT, "build", "wasmkernel.wasm");
const GUEST_DIR = join(ROOT, "tests", "guest");
const RUNNER = join(ROOT, "tests", "host", "run_wasmkernel.mjs");

/**
 * Run a guest wasm inside wasmkernel via subprocess.
 * Returns { exitCode, stdout, stderr }.
 */
async function runGuest(guestName: string) {
  const guestPath = join(GUEST_DIR, guestName);
  const proc = Bun.spawn(
    ["node", "--experimental-wasi-unstable-preview1", RUNNER, guestPath],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Parse "status: N, exitCode: M" from stderr */
function parseStatus(stderr: string) {
  const match = stderr.match(/status: (-?\d+), exitCode: (\d+)/);
  return match
    ? { status: parseInt(match[1]), exitCode: parseInt(match[2]) }
    : null;
}

describe("Phase 1: build", () => {
  test("wasmkernel.wasm exists and is valid", () => {
    const stat = statSync(KERNEL_PATH);
    expect(stat.size).toBeGreaterThan(0);
  });

  test("binary size under 400KB", () => {
    const stat = statSync(KERNEL_PATH);
    expect(stat.size).toBeLessThan(400 * 1024);
  });
});

describe("Phase 1: guest execution", () => {
  test("hello world", async () => {
    const result = await runGuest("hello.wasm");
    expect(result.stdout).toBe("hello world");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(1);
  });

  test("exit code propagation", async () => {
    const result = await runGuest("exit42.wasm");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(-2); // proc_exit
    expect(s?.exitCode).toBe(42);
    expect(result.exitCode).toBe(42);
  });

  test("trap handling", async () => {
    const result = await runGuest("trap.wasm");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(-1);
    expect(result.exitCode).toBe(1);
  });

  test("memory allocation", async () => {
    const result = await runGuest("alloc.wasm");
    expect(result.stdout).toBe("alloc ok: 65536 bytes");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(1);
  });

  test("invalid module", async () => {
    const result = await runGuest("hello.c"); // .c file is not valid wasm
    expect(result.exitCode).not.toBe(0);
  });
});

describe("Phase 2: cooperative threading", () => {
  test("thread spawn and atomic wait/notify", async () => {
    const result = await runGuest("thread_raw.wasm");
    expect(result.stdout).toContain("thread_raw ok");
    expect(result.stdout).toContain("tid=1");
    expect(result.stdout).toContain("value=142");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(1);
  });

  test("mutex-protected shared counter (4 threads x 100)", async () => {
    const result = await runGuest("mutex_counter.wasm");
    expect(result.stdout).toBe("mutex_counter ok: 400");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(1);
  });

  test("spawn 8 threads with unique TIDs", async () => {
    const result = await runGuest("many_threads.wasm");
    expect(result.stdout).toContain("many_threads ok: 8 threads");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(1);
  });
});

describe("Phase 3: I/O bridge", () => {
  test("poll_oneoff clock subscription (sleep)", async () => {
    const result = await runGuest("poll_sleep.wasm");
    expect(result.stdout).toBe("poll_sleep ok");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(1);
  });

  test("sleep + concurrent compute across threads", async () => {
    const result = await runGuest("sleep_and_compute.wasm");
    expect(result.stdout).toContain("sleep_and_compute ok");
    expect(result.stdout).toContain("sum=500500");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(1);
  });
});

describe("Phase 4: hardening (WAMR wasi-threads test suite)", () => {
  test("4 threads atomic counter (global_atomic)", async () => {
    const result = await runGuest("wamr_global_atomic.wasm");
    expect(result.stdout).toContain("Value of count after update: 4000");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(1);
  });

  test("spawn 50 sequential threads (spawn_multiple_times)", async () => {
    const result = await runGuest("wamr_spawn_multiple.wasm");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(1);
  }, 30000);

  test("proc_exit from spawned thread — atomic wait (nonmain_proc_exit_wait)", async () => {
    const result = await runGuest("wamr_nonmain_proc_exit_wait.wasm");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(-2);
    expect(s?.exitCode).toBe(33);
  });

  test("proc_exit from spawned thread — busy loop (nonmain_proc_exit_busy)", async () => {
    const result = await runGuest("wamr_nonmain_proc_exit_busy.wasm");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(-2);
    expect(s?.exitCode).toBe(33);
  });

  test("trap from spawned thread — atomic wait (nonmain_trap_wait)", async () => {
    const result = await runGuest("wamr_nonmain_trap_wait.wasm");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(-1);
  });

  test("trap from spawned thread — busy loop (nonmain_trap_busy)", async () => {
    const result = await runGuest("wamr_nonmain_trap_busy.wasm");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(-1);
  });

  test("stack overflow trapped cleanly", async () => {
    const result = await runGuest("stack_overflow.wasm");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(-1);
    expect(result.exitCode).toBe(1);
  });

  test("fuel fairness: both threads make progress", async () => {
    const result = await runGuest("fuel_fairness.wasm");
    expect(result.stdout).toContain("fuel_fairness ok");
    expect(result.stdout).toContain("a=1000");
    expect(result.stdout).toContain("b=1000");
    const s = parseStatus(result.stderr);
    expect(s?.status).toBe(1);
  });
});

/**
 * Run a Node.js test script directly (not via the wasmkernel runner).
 */
function runNodeTest(script: string): { stdout: string; stderr: string; exitCode: number } {
  const parts = script.split(" ");
  const result = Bun.spawnSync(["node", "--experimental-wasi-unstable-preview1", ...parts], {
    cwd: import.meta.dir + "/..",
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

describe("Phase 5: N-API compliance", () => {
  test("napi basic test — 14 assertions", () => {
    const result = runNodeTest("tests/host/test_napi.mjs");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASS");
    expect(result.stdout).not.toContain("FAIL");
  });

  test("napi Node.js compat — 30 assertions", () => {
    const result = runNodeTest("tests/host/test_napi_node_compat.mjs");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("30 passed, 0 failed");
  });
});

describe("Phase 5: Oxide integration", () => {
  test("oxide scanner produces expected CSS candidates", () => {
    const result = runNodeTest("tests/host/test_oxide.mjs");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Scanner created");
    expect(result.stdout).toContain("scan count: 7");
    expect(result.stdout).toContain("flex");
    expect(result.stdout).toContain("bg-blue-500");
  });
});

describe("Phase 5: emnapi Node-API compliance suite", () => {
  const passingTests = [
    "hello", "arg", "callback", "objfac", "fnfac", "function",
    "constructor", "conversion", "number", "error", "exception",
    "array", "property", "symbol", "promise", "newtarget",
    "version", "env", "date", "cbinfo", "ref", "ref_double_free",
    "general", "object", "bigint", "dataview", "scope",
    "async", "make_callback", "async_context", "tsfn2",
    "object_exception", "reference_all_types", "reference_obj_only",
    "runjs_cnrj", "runjs_pe", "buffer", "buffer_finalizer",
    "cleanup_hook", "fatal_exception", "filename", "finalizer",
    "ref_finalizer", "sharedarraybuffer", "string",
    "fnwrap", "objwrap", "objnestedwrap", "objwrapbasicfinalizer",
    "passwrap", "tsfn_abort",
    "tsfn", "pool", "uv_threadpool_size", "trap_in_thread",
    "async_cleanup_hook", "typedarray", "tsfn_shutdown", "string_mt",
  ];

  for (const name of passingTests) {
    test(`emnapi/${name}`, () => {
      const result = runNodeTest(`tests/emnapi/run_emnapi_test.mjs ${name}`);
      expect(result.exitCode).toBe(0);
    }, 15000); // some tests (string) need extra time
  }
});
