/**
 * WasmKernel shim for emnapi test util.js
 * Replaces @emnapi/core with our kernel + napi_runtime bridge.
 * Makes emnapi's actual test JS files work against our implementation.
 */
'use strict'
const { join } = require('path')
const fs = require('fs')
const { WASI } = require('wasi')

// Dynamic import for ESM napi_runtime
let NapiRuntime
const napiRuntimePromise = import('../host/napi_runtime.mjs').then(m => { NapiRuntime = m.NapiRuntime })

const kernelPath = join(__dirname, '..', '..', 'build', 'wasmkernel.wasm')
const wasmDir = join(__dirname, 'wasm')

function getEntry(targetName) {
  return join(wasmDir, `${targetName}.wasm`)
}
exports.getEntry = getEntry

exports.loadPath = function (request, options) {
  return exports.load(require('path').basename(request, '.wasm'), options)
}

exports.load = async function (targetName, options = {}) {
  await napiRuntimePromise

  const kernelBytes = fs.readFileSync(kernelPath)
  const guestPath = join(wasmDir, `${targetName}.wasm`)
  const guestBytes = fs.readFileSync(guestPath)

  const wasi = new WASI({ version: 'preview1', args: [], env: {} })
  const pendingIO = new Map()
  const bridgeFunctions = new Map()

  let k
  const hostImports = {
    host_func_call(funcIdx, argsPtr, argc) {
      const handler = bridgeFunctions.get(funcIdx)
      if (!handler) return 0n
      const args = []
      for (let i = 0; i < argc; i++)
        args.push(new DataView(k.memory.buffer).getUint32(argsPtr + i * 8, true))
      try { return handler(args, argsPtr) }
      catch { return 0n }
    },
    host_io_submit(cb) { pendingIO.set(cb, { bytes: 0, error: 0 }) },
    host_io_check(cb) { return pendingIO.has(cb) ? 1 : 0 },
    host_io_result_bytes(cb) { return pendingIO.get(cb)?.bytes ?? 0 },
    host_io_result_error(cb) { const r = pendingIO.get(cb); if (r) pendingIO.delete(cb); return r?.error ?? 8 },
  }

  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(kernelBytes),
    { wasi_snapshot_preview1: wasi.wasiImport, host: hostImports }
  )
  wasi.initialize(instance)
  k = instance.exports
  k.kernel_init()

  const ptr = k.kernel_alloc(guestBytes.length)
  new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes)
  if (k.kernel_load(ptr, guestBytes.length) !== 0) {
    throw new Error(`kernel_load failed for ${targetName}`)
  }

  const napiRuntime = new NapiRuntime(k)
  if (options.filename) napiRuntime._moduleFilename = options.filename

  // Discover bridges
  const bridgeCount = k.kernel_bridge_count()
  const infoBuf = k.kernel_alloc(256)
  for (let i = 0; i < bridgeCount; i++) {
    const len = k.kernel_bridge_info(i, infoBuf, 256)
    if (!len) continue
    const bytes = new Uint8Array(k.memory.buffer, infoBuf, len)
    const parts = []; let start = 0
    for (let j = 0; j < len; j++) {
      if (bytes[j] === 0) { parts.push(new TextDecoder().decode(bytes.slice(start, j))); start = j + 1 }
    }
    const [mod, field] = parts
    if ((mod === 'env' || mod === 'emnapi' || mod === 'napi') && napiRuntime[field]) {
      const fn = field
      bridgeFunctions.set(i, (args, argsPtr) => napiRuntime.dispatch(fn, args, argsPtr))
    } else {
      bridgeFunctions.set(i, () => 0n)
    }
  }

  // Initialize reactor
  let status = 0
  while (status === 0) status = k.kernel_step()

  // Note: removed blanket clearStuckLocks — zeroing all values of 2 in
  // guest memory was destroying legitimate data. The deadlock detection
  // (spurious wakeup) in the scheduler handles stuck locks properly now.

  // Register napi module
  const exportsObj = {}
  const exportsHandle = napiRuntime._newHandle(exportsObj)

  const np = k.kernel_alloc(23)
  const nameBytes = new TextEncoder().encode('napi_register_wasm_v1')
  new Uint8Array(k.memory.buffer, np, 22).set(nameBytes)
  new Uint8Array(k.memory.buffer)[np + 21] = 0
  const ap = k.kernel_alloc(8)
  new DataView(k.memory.buffer).setUint32(ap, 1, true)
  new DataView(k.memory.buffer).setUint32(ap + 4, exportsHandle, true)
  const callResult = k.kernel_call(np, ap, 2)
  if (callResult !== 0) {
    throw new Error(`napi_register_wasm_v1 failed: ${callResult}`)
  }

  const retHandle = new DataView(k.memory.buffer).getUint32(ap, true)
  const result = napiRuntime._getHandle(retHandle) ?? exportsObj

  // Run cleanup hooks at process exit
  process.on('exit', () => { napiRuntime.runCleanupHooks() })

  // Start background stepper for cooperative threads
  result._kernel = k
  result._napiRuntime = napiRuntime
  const stepper = setInterval(() => {
    const threadCount = k.kernel_thread_count()
    if (threadCount <= 0) {
      napiRuntime.drainTsfnQueue()
      return
    }
    // Run a batch of steps to give threads time
    for (let i = 0; i < 100; i++) {
      const s = k.kernel_step()
      if (s !== 0) break // all threads done or blocked
    }
    // Drain any queued threadsafe function calls and async sends
    napiRuntime.drainTsfnQueue()
    napiRuntime.drainAsyncSendQueue()
  }, 1)
  // Don't let the stepper keep the process alive
  if (stepper.unref) stepper.unref()

  return result
}

exports.supportWeakSymbol = false
