/**
 * Node.js entry for @wasmkernel/runtime.
 *
 * Exports the same functions as @napi-rs/wasm-runtime so published
 * napi-rs .wasi.cjs loaders work unmodified when the module resolver
 * redirects @napi-rs/wasm-runtime → @wasmkernel/runtime.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  instantiateNapiModuleSync as _instantiateSync,
  getDefaultContext,
  createOnMessage,
} from "./instantiate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KERNEL_PATH = join(__dirname, "..", "wasmkernel.wasm");

// Load the kernel once per process.
let _kernelBytes = null;
function kernelBytes() {
  if (!_kernelBytes) _kernelBytes = readFileSync(KERNEL_PATH);
  return _kernelBytes;
}

/** Drop-in replacement for @napi-rs/wasm-runtime's instantiateNapiModuleSync.
 *
 *  Signature (matching napi-rs):
 *    instantiateNapiModuleSync(wasmBytes, options) → {instance, module, napiModule}
 *
 *  Options honored:
 *    - wasi: a node:wasi instance (or compatible)
 *    - asyncWorkPoolSize, onCreateWorker, reuseWorker: accepted for compat, ignored
 *    - overwriteImports: accepted, ignored (our loader has its own bridge)
 *    - beforeInit: called with {instance} so callers can run __napi_register__* exports
 *    - context: accepted, ignored
 */
export function instantiateNapiModuleSync(guestBytes, options = {}) {
  // napi-rs loaders expect this to work synchronously. We require the
  // caller to pass a `wasi` since it's the only platform-specific piece.
  if (!options.wasi) {
    throw new Error(
      "@wasmkernel/runtime: options.wasi is required (pass a node:wasi instance)"
    );
  }
  return _instantiateSync(kernelBytes(), guestBytes, options);
}

export { getDefaultContext, createOnMessage };

/** Convenience: loadNapiRs(guestWasmPath, options) — reads the guest from
 *  disk and returns { exports } directly. This is NOT in napi-rs's API, but
 *  useful for tests and one-off usage. */
export async function loadNapiRs(guestPath, options = {}) {
  const { WASI } = await import("node:wasi");
  const wasi = new WASI({
    version: "preview1",
    args: options.args ?? [],
    env: options.env ?? process.env,
    preopens: options.preopens ?? {},
  });
  const guestBytes = readFileSync(guestPath);
  const r = instantiateNapiModuleSync(guestBytes, { ...options, wasi });
  return { exports: r.napiModule.exports, kernel: r.kernel, napiRuntime: r.napiRuntime };
}
