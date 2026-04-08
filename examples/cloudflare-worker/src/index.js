/**
 * Cloudflare Worker example for @alexbruf/wasmkernel.
 *
 * Loads the published oxc-parser wasm32-wasi binary and parses JavaScript
 * sent in the request body. A tiny serverless AST endpoint.
 *
 * workerd has two relevant constraints:
 *
 *   1. `WebAssembly.compile()` is only allowed at module-init time
 *      (top-level). Both wasm modules are pre-compiled via static imports
 *      so we never need to call compile at runtime.
 *
 *   2. `crypto.getRandomValues()` is forbidden at module-init time. The
 *      guest's `_start` (wasi-libc + mimalloc init) needs random bytes,
 *      so we must do the actual instantiation on the first request — not
 *      at top level — and cache the resulting parser in module-global
 *      state so subsequent requests are warm.
 *
 * Try it locally:
 *   bun run dev
 *   curl http://localhost:8787/ -d 'const x = 1 + 2;'
 */
import wasmkernelModule from "@alexbruf/wasmkernel/wasmkernel.wasm";
import oxcParserBytes from "./oxc-parser.wasm.bin";
import { instantiateNapiModule } from "@alexbruf/wasmkernel/worker";
import { WASI } from "@bjorn3/browser_wasi_shim";

// First-request init, cached for the lifetime of the isolate.
let oxcPromise = null;
function getOxc() {
  if (oxcPromise) return oxcPromise;
  oxcPromise = (async () => {
    const wasi = new WASI([], [], [], { debug: false });
    const { napiModule } = await instantiateNapiModule(
      new Uint8Array(oxcParserBytes),
      { wasi, kernelModule: wasmkernelModule }
    );
    return napiModule.exports;
  })();
  return oxcPromise;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        "POST JavaScript source as the request body to parse it.\n" +
          "Example: curl http://localhost:8787/ -d 'const x = 1 + 2;'\n",
        { headers: { "content-type": "text/plain" } }
      );
    }

    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    let oxc;
    try {
      oxc = await getOxc();
    } catch (e) {
      return Response.json(
        { error: `failed to instantiate oxc-parser: ${e?.message ?? e}` },
        { status: 500 }
      );
    }

    const source = await request.text();
    if (!source) return new Response("empty body", { status: 400 });

    const filename =
      url.searchParams.get("filename") ||
      (source.includes("interface ") || source.includes(": ") ? "input.ts" : "input.js");

    const t0 = Date.now();
    let result;
    try {
      result = oxc.parseSync(filename, source);
    } catch (e) {
      return Response.json(
        { error: `parse threw: ${e?.message ?? e}` },
        { status: 500 }
      );
    }
    const elapsedMs = Date.now() - t0;

    let summary;
    try {
      const { node } = JSON.parse(result.program);
      summary = {
        filename,
        sourceLength: source.length,
        parseTimeMs: elapsedMs,
        topLevel: node.body.map((s) => ({
          type: s.type,
          kind: s.kind ?? s.declaration?.type ?? null,
        })),
        errors: (result.errors || []).map((err) => err.message),
      };
    } catch (e) {
      return Response.json(
        { error: `failed to interpret oxc result: ${e?.message ?? e}` },
        { status: 500 }
      );
    }

    return Response.json(summary, {
      headers: { "x-parse-time-ms": String(elapsedMs) },
    });
  },
};
