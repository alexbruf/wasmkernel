#!/usr/bin/env node
/**
 * Run multiple emnapi tests in parallel as subprocesses via the real test
 * runner (run_emnapi_native.mjs). Outputs JSON pass/fail per test.
 *
 * Usage: node run_all.mjs <test1> <test2> ...
 */
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { cpus } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(__dirname, "run_emnapi_native.mjs");

const tests = process.argv.slice(2);
if (tests.length === 0) {
  console.error("Usage: run_all.mjs <test1> <test2> ...");
  process.exit(2);
}

// typedarray needs Float16Array (Node v24+). If running on older Node,
// look for a v24 install via nvm and use that for typedarray.
const NODE_MAJOR = parseInt(process.versions.node.split(".")[0], 10);
let NODE24_PATH = null;
if (NODE_MAJOR < 24) {
  try {
    const fs = await import("fs");
    const home = process.env.HOME;
    if (home && fs.existsSync(`${home}/.nvm/versions/node`)) {
      const versions = fs.readdirSync(`${home}/.nvm/versions/node`)
        .filter(v => v.startsWith("v24."))
        .sort()
        .reverse();
      if (versions.length > 0) {
        NODE24_PATH = `${home}/.nvm/versions/node/${versions[0]}/bin/node`;
      }
    }
  } catch {}
}

const TESTS_NEEDING_NODE24 = new Set(["typedarray"]);

function runOne(testName) {
  return new Promise((resolve) => {
    const nodeBin = (NODE24_PATH && TESTS_NEEDING_NODE24.has(testName))
      ? NODE24_PATH : process.execPath;
    const child = spawn(
      nodeBin,
      ["--expose-gc", "--experimental-wasi-unstable-preview1", RUNNER, testName],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const passed = stdout.includes("PASS " + testName)
        || stdout.includes("PASS\n")
        || /^PASS\b/m.test(stdout);
      resolve({ testName, passed, code });
    });
  });
}

// Tests that spawn their own subprocesses get flaky under parallel load,
// so run them serially after the parallel batch.
const SERIAL_TESTS = new Set(["trap_in_thread", "tsfn_shutdown", "async"]);
const parallelTests = tests.filter(t => !SERIAL_TESTS.has(t));
const serialTests = tests.filter(t => SERIAL_TESTS.has(t));

// Run parallel tests with a concurrency limit (number of CPU cores)
const concurrency = Math.max(4, Math.min(cpus().length, 8));
const queue = parallelTests.slice();
const results = {};

async function worker() {
  while (queue.length > 0) {
    const testName = queue.shift();
    let r = await runOne(testName);
    // Retry once on failure (handles parallel-load flakiness)
    if (!r.passed) r = await runOne(testName);
    results[testName] = r.passed ? "pass" : `fail (exit=${r.code})`;
  }
}

const workers = [];
for (let i = 0; i < concurrency; i++) workers.push(worker());
await Promise.all(workers);

// Run serial tests one at a time
for (const testName of serialTests) {
  let r = await runOne(testName);
  if (!r.passed) r = await runOne(testName);
  results[testName] = r.passed ? "pass" : `fail (exit=${r.code})`;
}

const passed = Object.values(results).filter(r => r === "pass").length;
const failed = Object.values(results).filter(r => r !== "pass").length;
for (const [name, result] of Object.entries(results)) {
  if (result !== "pass") console.error(`FAIL ${name}: ${result}`);
}
console.log(JSON.stringify({ passed, failed, total: tests.length }));
process.exit(failed > 0 ? 1 : 0);
