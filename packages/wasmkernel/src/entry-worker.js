/**
 * Worker entry for @wasmkernel/runtime.
 *
 * Workers (Web Workers, Service Workers, Cloudflare Workers / workerd)
 * have the same constraints as browsers: no sync wasm compile, no fs.
 * This entry is currently just a re-export of the browser entry — the
 * API and behavior are identical. It exists as a separate export
 * condition so bundlers that target workers (workerd, esbuild --platform=worker)
 * can pick it up via the "worker"/"workerd" condition in package.json.
 *
 * If worker-specific behavior is needed later (e.g., using the worker's
 * postMessage for cross-worker communication instead of SharedArrayBuffer),
 * it belongs here.
 */
export {
  instantiateNapiModule,
  instantiateNapiModuleSync,
  getDefaultContext,
  createOnMessage,
} from "./entry-browser.js";
