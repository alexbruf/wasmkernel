// Child process wrapper for tests that spawn subprocesses
// Sets up the same module resolution overrides as run_emnapi_native.mjs
'use strict'
const { join, dirname } = require('path')
const Module = require('module')

const __dirname2 = dirname(__filename)

const origResolve = Module._resolveFilename
Module._resolveFilename = function(request, parent, ...rest) {
  const overrides = {
    '../util': join(__dirname2, 'util.js'),
    '../util.js': join(__dirname2, 'util.js'),
    '../common': join(__dirname2, 'common.js'),
    '../common.js': join(__dirname2, 'common.js'),
    '../tmpdir': join(__dirname2, 'tmpdir.js'),
    '../tmpdir.js': join(__dirname2, 'tmpdir.js'),
    '../tick': join(__dirname2, 'tick.js'),
    '../tick.js': join(__dirname2, 'tick.js'),
    '../gc': join(__dirname2, 'gc.js'),
    '../gc.js': join(__dirname2, 'gc.js'),
  }
  if (overrides[request]) return overrides[request]
  if (request === '@emnapi/node-binding') return join(__dirname2, 'node_binding_shim.js')
  return origResolve.call(this, request, parent, ...rest)
}

process.env.NODE_TEST_KNOWN_GLOBALS = '0'
