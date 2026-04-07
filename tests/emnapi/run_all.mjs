#!/usr/bin/env node
/**
 * Run multiple emnapi tests sequentially as subprocesses, each via the
 * real test runner (run_emnapi_native.mjs). Outputs JSON pass/fail per test.
 *
 * Usage: node run_all.mjs <test1> <test2> ...
 */
import { spawnSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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

const results = {};
for (const testName of tests) {
  const nodeBin = (NODE24_PATH && TESTS_NEEDING_NODE24.has(testName))
    ? NODE24_PATH : process.execPath;
  const r = spawnSync(
    nodeBin,
    ["--expose-gc", "--experimental-wasi-unstable-preview1", RUNNER, testName],
    { encoding: "utf8", timeout: 60000 }
  );
  const passed = r.stdout.includes("PASS " + testName) || r.stdout.includes("PASS\n");
  results[testName] = passed ? "pass" : `fail (exit=${r.status})`;
}

const passed = Object.values(results).filter(r => r === "pass").length;
const failed = Object.values(results).filter(r => r !== "pass").length;
for (const [name, result] of Object.entries(results)) {
  if (result !== "pass") console.error(`FAIL ${name}: ${result}`);
}
console.log(JSON.stringify({ passed, failed, total: tests.length }));
process.exit(failed > 0 ? 1 : 0);
