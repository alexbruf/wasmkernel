#!/usr/bin/env node --expose-gc
/**
 * Run emnapi's actual test JS files against WasmKernel.
 * Uses their real assertions, not our defensive wrappers.
 *
 * Usage: node run_emnapi_native.mjs <test_name>
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testName = process.argv[2];
if (!testName) { console.error("Usage: run_emnapi_native.mjs <test_name>"); process.exit(1); }

// Suppress emnapi's global leak checker
process.env.NODE_TEST_KNOWN_GLOBALS = '0';

// Find emnapi test file
const emnapiTestDir = '/tmp/emnapi-repo/packages/test';
const testFiles = [
  `${testName}/${testName}.test.js`,
  `${testName}/test.js`,
  `${testName}/index.js`,
];

let testFile;
for (const f of testFiles) {
  const full = join(emnapiTestDir, f);
  try { await import('fs').then(fs => fs.accessSync(full)); testFile = full; break; }
  catch {}
}
if (!testFile) {
  // Some tests use different naming
  const fs = await import('fs');
  const entries = fs.readdirSync(join(emnapiTestDir, testName));
  const jsFile = entries.find(e => e.endsWith('.test.js') || e === 'test.js');
  if (jsFile) testFile = join(emnapiTestDir, testName, jsFile);
}
if (!testFile) { console.error(`No test JS file found for ${testName}`); process.exit(1); }

// Override require resolution to use our util.js and support files
const Module = (await import('module')).default;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
  const overrides = {
    '../util': join(__dirname, 'util.js'),
    '../util.js': join(__dirname, 'util.js'),
    '../common': join(__dirname, 'common.js'),
    '../common.js': join(__dirname, 'common.js'),
    '../tmpdir': join(__dirname, 'tmpdir.js'),
    '../tmpdir.js': join(__dirname, 'tmpdir.js'),
    '../tick': join(__dirname, 'tick.js'),
    '../tick.js': join(__dirname, 'tick.js'),
    '../gc': join(__dirname, 'gc.js'),
    '../gc.js': join(__dirname, 'gc.js'),
  };
  if (overrides[request]) return overrides[request];
  return origResolve.call(this, request, parent, ...rest);
};

// Run the test
try {
  const require2 = createRequire(testFile);
  const result = require2(testFile);
  await Promise.resolve(result);
  console.log(`PASS ${testName}`);
} catch (e) {
  console.error(`FAIL ${testName}: ${e?.message ?? e}`);
  if (e?.stack) console.error(e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}
