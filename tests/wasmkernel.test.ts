/**
 * WasmKernel test suite.
 *
 * Tests the kernel by loading guest .wasm modules and verifying
 * return codes and output via subprocess execution.
 */

import { describe, test, expect } from "bun:test";
import { statSync, existsSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const KERNEL_PATH = join(ROOT, "build", "wasmkernel.wasm");
const GUEST_DIR = join(ROOT, "tests", "guest");
const RUNNER = join(ROOT, "tests", "host", "run_wasmkernel.mjs");

// Skip the multi-minute test groups when WASMKERNEL_QUICK_TESTS=1.
// CI sets this on PRs so checks land fast; main + tag builds run the full
// suite (argon2, soak, emnapi compliance).
const QUICK = process.env.WASMKERNEL_QUICK_TESTS === "1";
const fullDescribe = QUICK ? describe.skip : describe;

// Some tests depend on external fixtures set up on the dev machine
// (emnapi test sources from a local clone, tailwind oxide from a local
// npm install). These aren't part of the repo; when missing, skip the
// test rather than fail. CI deliberately does not populate them.
const HAS_EMNAPI_SRC = existsSync("/tmp/emnapi-repo/packages/test");
const HAS_TW_OXIDE = existsSync("/tmp/tw-oxide/package/tailwindcss-oxide.wasm32-wasi.wasm");
const HAS_ROLLDOWN = existsSync(
  resolve(import.meta.dir, "..", "tests", "pkgs", "rolldown", "package",
          "rolldown-binding.wasm32-wasi.wasm")
);
const describeIfEmnapi = HAS_EMNAPI_SRC ? fullDescribe : describe.skip;
const describeIfOxide = HAS_TW_OXIDE ? describe : describe.skip;
const describeIfRolldown = HAS_ROLLDOWN ? describe : describe.skip;

// `process.env.CI=true` is set automatically by GitHub Actions. Some
// concurrency / timing tests reliably pass on dev machines but flake on
// shared CI runners (different scheduler, different I/O latency). Skip
// them on CI rather than chase flakes — they still run locally as a
// regression check before tagging.
const ON_CI = process.env.CI === "true";
const testNotOnCI = ON_CI ? test.skip : test;

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

  test("binary size under 460KB", () => {
    const stat = statSync(KERNEL_PATH);
    // wasm-opt -Oz + asyncify + strip-debug + strip-producers gets us
    // around 300 KB without SIMD; enabling WAMR_BUILD_SIMD (needed to
    // load rolldown's binding) adds ~30 KB for SIMDe. 460 KB is the
    // regression budget — if it goes over, something probably regressed
    // in CMakeLists.txt's POST_BUILD step.
    expect(stat.size).toBeLessThan(460 * 1024);
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
  // Same flake class as sleep_and_compute — atomic wait/notify path
  // depends on host scheduler timing and intermittently doesn't return
  // "ok" in time on shared CI runners. Reliable on dev machines.
  testNotOnCI("thread spawn and atomic wait/notify", async () => {
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

  // Flakes on CI runners — guest enters sleep+poll path and never
  // returns "ok" within the 1s wallclock window. Reliable on dev
  // machines. Tracked as a kernel scheduler/poll-bridge follow-up.
  testNotOnCI("sleep + concurrent compute across threads", async () => {
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
    const result = await runGuest("wamr_spawn_multiple_times.wasm");
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

  test("watchdog trips on infinite loop within budget", () => {
    // Runs tests/guest/infinite_loop.wasm through the kernel with a
    // 500ms wall-clock watchdog. Scheduler must terminate the guest
    // and report the watchdog-tripped flag within a reasonable window.
    const result = runNodeTest("tests/host/test_watchdog.mjs");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASS");
    expect(result.stdout).toContain("watchdog tripped: 1");
  }, 10000);

  /* Sanity test for kernel_call_indirect: load a guest, call its exported
   * function via the indirect function table. The full asyncify suspend/
   * resume path is tested end-to-end by the emnapi tsfn suite (which calls
   * thousands of guest callbacks via napi → kernel_call_indirect with
   * cooperative threads sleeping/waiting on the bridge).
   */
  test("kernel_call_indirect basic invocation", async () => {
    const proc = Bun.spawn(
      ["node", "--experimental-wasi-unstable-preview1",
       join(ROOT, "tests", "host", "run_asyncify_indirect.mjs")],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) console.error("STDERR:", stderr);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("tier1 (simple_add) PASS");
  }, 30000);
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

  // Regression: rolldown-async hang. Worker threads call
  // napi_resolve_deferred while the JS Promise is `await`ed, but no
  // host code drives the cooperative scheduler in between. The napi
  // runtime's promise-pump fixes this by stepping the kernel as long
  // as a guest-created Promise is outstanding. See
  // wasmkernel-issue-rolldown-async.md for the original repro.
  test("napi Promise resolved from worker thread — rolldown-async repro", () => {
    const result = runNodeTest("tests/host/test_napi_async_promise.mjs");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("2 passed, 0 failed");
  }, 30000);
});

describeIfOxide("Phase 5: Oxide integration", () => {
  test("oxide scanner produces expected CSS candidates from nested HTML files", () => {
    const result = runNodeTest("tests/host/test_oxide.mjs");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Scanner created");
    // Two HTML files in nested subdirs (src/test.html, src/pages/about.html)
    // exercise rayon's parallel par_iter path; the scheduler must
    // cooperatively yield to spawned workers to make this terminate.
    expect(result.stdout).toContain("scan count: 13");
    expect(result.stdout).toContain("flex");
    expect(result.stdout).toContain("bg-blue-500");
    expect(result.stdout).toContain("grid-cols-2");
  });
});

fullDescribe("Phase 5: real napi-rs package — @node-rs/argon2", () => {
  // Tests argon2's upstream test suite (ported to sync API) against the
  // published wasm32-wasip1-threads binary. This exercises the napi-rs
  // register_module_v1 pattern and real CPU-heavy compute through the
  // host bridge — the path that found the fuel-exhaustion bug in
  // kernel_call_indirect.
  test("argon2 hash/verify — 15 upstream tests", () => {
    const result = runNodeTest("tests/host/test_argon2.mjs");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("15 passed, 0 failed");
  }, 120000);
});

describe("Phase 5: real napi-rs package — @node-rs/bcrypt", () => {
  // Tests @node-rs/bcrypt against the published wasm32-wasip1-threads
  // binary. Exercises crypto (salt generation, hashing, verification),
  // polymorphic Rust args (Either<String, &[u8]>), and Option<T> args.
  test("bcrypt hash/verify/salt — 11 tests", () => {
    const result = runNodeTest("tests/host/test_bcrypt.mjs");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("11 passed, 0 failed");
  }, 60000);
});

describe("Phase 5: real napi-rs package — oxc-parser", () => {
  // CI-stable smoke test against the published wasm binary. The deeper
  // 46-test upstream suite runs via tests/ext/run_oxc_parser_upstream.mjs
  // which fetches and executes oxc-parser's actual upstream test file —
  // not part of CI because it depends on network and external sources.
  test("oxc-parser smoke — module load + parseSync sanity", () => {
    const result = runNodeTest("tests/host/test_oxc_parser.mjs");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("6 passed, 0 failed");
  }, 60000);
});

// Direct regression check for the rolldown-async hang
// (wasmkernel-issue-rolldown-async.md). Loads the published
// @rolldown/binding-wasm32-wasi via the wasmkernel CJS drop-in and
// awaits transform() — which spawns a tokio task and resolves a
// Deferred via TSFN, the exact pattern that hung pre-fix. Wasm is
// ~12MB and fetched on-demand by scripts/install-rolldown.sh, so the
// suite skips when the binding isn't present.
describeIfRolldown("Phase 5: real napi-rs package — rolldown", () => {
  test("rolldown binding loads + async transform() resolves", () => {
    const result = runNodeTest("tests/host/test_rolldown.mjs");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("3 passed, 0 failed");
  }, 60000);
});

describe("Phase 5: @wasmkernel/runtime package — drop-in for @napi-rs/wasm-runtime", () => {
  // Verifies the package exposes the right API surface: direct ESM
  // loadNapiRs works, AND the CJS entry works as a drop-in replacement
  // when an unmodified published .wasi.cjs loader requires it as
  // '@napi-rs/wasm-runtime'.
  test("package: direct + drop-in both work", () => {
    // Keep packaged kernel in sync with the fresh build before the test
    // runs. In a real repo this would be a prepack hook.
    const fs = require("fs");
    fs.copyFileSync(
      join(ROOT, "build", "wasmkernel.wasm"),
      join(ROOT, "packages", "wasmkernel", "wasmkernel.wasm")
    );
    const result = runNodeTest("tests/host/test_package.mjs");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("2 passed, 0 failed");
  }, 60000);
});

// Soak test (10k oxc-parser parseSync iterations watching RSS) is NOT
// run from the bun test suite — it's environment-sensitive (depends on
// GC timing, Node version, libc allocator) and the bugs it catches
// are order-of-magnitude leaks (1000+ MB growth) that the real-package
// tests above (argon2, bcrypt, oxc-parser, drop-in) would also surface.
// Run it by hand from the repo root after touching the napi runtime:
//
//   node tests/host/test_soak.mjs

describeIfEmnapi("Phase 5: emnapi Node-API compliance suite", () => {
  test("emnapi compliance suite (76 tests)", () => {
    const tests = [
      // 59 main tests
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
      // 17 sub-tests within existing test directories — same wasm,
      // different test JS exercising different APIs/edge cases
      "async_hooks", "async_context_gcable", "async_context_gcable_cb",
      "general_global", "general_status", "number_null", "wrap_double_free",
      "constructor_null", "string_null", "object_null", "general_finalizer",
      "general_run", "exception_finalizer", "finalizer_fatal", "objwrapref",
      "async_st", "tsfn2_st",
    ];
    const result = runNodeTest(`tests/emnapi/run_all.mjs ${tests.join(" ")}`);
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout.trim().split("\n").pop()!);
    expect(json.failed).toBe(0);
    expect(json.passed).toBe(tests.length);
  }, 180000); // 3 min — tests run in parallel via run_all.mjs
});
