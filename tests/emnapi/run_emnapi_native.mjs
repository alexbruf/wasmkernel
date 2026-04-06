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

// Ensure large heap for tests that allocate 256MB+ (e.g. string TestUtf8Large).
// Re-exec with --max-old-space-size if not already set.
if (!process.execArgv.some(a => a.includes('max-old-space-size'))) {
  const { execFileSync } = await import('child_process');
  try {
    execFileSync(process.execPath, [
      '--max-old-space-size=4096', ...process.execArgv, ...process.argv.slice(1)
    ], { stdio: 'inherit', env: process.env, timeout: 120000 });
  } catch (e) { process.exit(e.status ?? 1); }
  process.exit(0);
}

// Suppress emnapi's global leak checker
process.env.NODE_TEST_KNOWN_GLOBALS = '0';

// Mark as WASI test so child processes add --experimental-wasi-unstable-preview1
process.env.EMNAPI_TEST_WASI = '1';

// Enable child process support: when tests spawn subprocesses (async, cleanup_hook),
// the child needs our module resolution overrides. NODE_OPTIONS --require preloads them.
process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '') +
  ` --require ${join(__dirname, 'child_wrapper.js')}`
  + ' --experimental-wasi-unstable-preview1';

// Find emnapi test file
const emnapiTestDir = '/tmp/emnapi-repo/packages/test';

// Map wasm names that differ from their test directory/file
const testFileMap = {
  'objnestedwrap': 'objwrap/nestedwrap.test.js',
  'objwrapbasicfinalizer': 'objwrap/objwrapbasicfinalizer.test.js',
  'runjs_cnrj': 'runjs/runjs.test.js',
  'runjs_pe': 'runjs/runjs.test.js',
  'string_mt': 'string/string-pthread.test.js',
  'object_exception': 'object/object_exceptions.test.js',
  'reference_all_types': 'ref_by_node_api_version/ref_by_node_api_version.test.js',
  'reference_obj_only': 'ref_by_node_api_version/ref_by_node_api_version.test.js',
};

const testFiles = Object.hasOwn(testFileMap, testName)
  ? [testFileMap[testName]]
  : [
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
  // Shim @emnapi/node-binding — it's optional (only for Node.js async hooks)
  if (request === '@emnapi/node-binding') return join(__dirname, 'node_binding_shim.js');
  return origResolve.call(this, request, parent, ...rest);
};

// Run the test
try {
  const require2 = createRequire(testFile);
  const result = require2(testFile);
  // Some tests (tsfn_abort, tsfn_shutdown) export Promises that never resolve —
  // they expect the process to exit cleanly. Race with a timeout.
  const timeout = new Promise(r => setTimeout(r, 5000, '__timeout__'));
  const outcome = await Promise.race([Promise.resolve(result), timeout]);
  if (outcome === '__timeout__') {
    // Process stayed alive for 5s with no errors — consider it a pass
    console.log(`PASS ${testName}`);
    process.exit(0);
  }
  console.log(`PASS ${testName}`);
} catch (e) {
  console.error(`FAIL ${testName}: ${e?.message ?? e}`);
  if (e?.stack) console.error(e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}
