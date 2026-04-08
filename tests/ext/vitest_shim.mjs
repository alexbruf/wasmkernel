/* Minimal vitest compat: describe/it/test/test.each/expect */
const stats = { passed: 0, failed: 0, skipped: 0, failures: [] };
const path = [];
export function describe(name, fn) {
  path.push(name);
  try { fn(); }
  catch (e) { console.error("  describe(" + name + ") threw:", e?.message || e); }
  path.pop();
}
describe.skip = (name) => { console.log("  SKIP describe(" + name + ")"); stats.skipped++; };
async function runTest(name, fn) {
  const label = [...path, name].join(" > ");
  try {
    await fn();
    console.log("  PASS " + label);
    stats.passed++;
  } catch (e) {
    console.error("  FAIL " + label + ": " + (e?.message || e));
    stats.failures.push({ label, message: e?.message || String(e) });
    stats.failed++;
  }
}
export function it(name, fn) { return runTest(name, fn); }
export function test(name, fn) { return runTest(name, fn); }
it.each = (table) => (name, fn) => {
  for (const row of table) {
    const rendered = name.replace("%s", String(row));
    runTest(rendered, () => fn(row));
  }
};
test.each = it.each;
it.skip = (name) => { console.log("  SKIP " + name); stats.skipped++; };
test.skip = it.skip;

// expect() — implement the subset the oxc-parser test file uses
import { deepStrictEqual, strictEqual, ok } from "assert";
export function expect(actual) {
  return {
    toBe(expected) { strictEqual(actual, expected); },
    toEqual(expected) { deepStrictEqual(actual, expected); },
    toStrictEqual(expected) { deepStrictEqual(actual, expected); },
    toBeDefined() { ok(actual !== undefined, "expected defined, got undefined"); },
    toBeUndefined() { strictEqual(actual, undefined); },
    toBeNull() { strictEqual(actual, null); },
    toBeTruthy() { ok(actual, "expected truthy, got " + actual); },
    toBeFalsy() { ok(!actual, "expected falsy, got " + actual); },
    toContain(x) { ok(actual.includes(x), "expected to contain " + x); },
    toThrow() {
      try { actual(); throw new Error("did not throw"); }
      catch (e) { if (e?.message === "did not throw") throw e; }
    },
    toHaveLength(n) { strictEqual(actual?.length, n); },
  };
}

export function getStats() { return stats; }
