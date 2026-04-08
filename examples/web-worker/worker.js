/**
 * Worker: hosts the wasmkernel + oxc-parser instance, replies to parse
 * requests from the main thread.
 */
import { instantiateNapiModule } from "@alexbruf/wasmkernel/worker";
import { WASI } from "@bjorn3/browser_wasi_shim";

let oxc = null;

async function init() {
  const guestBytes = new Uint8Array(
    await (await fetch("/oxc-parser.wasm")).arrayBuffer()
  );
  const wasi = new WASI([], [], [], { debug: false });
  const { napiModule } = await instantiateNapiModule(guestBytes, { wasi });
  oxc = napiModule.exports;
  postMessage({ id: null, type: "ready" });
}

init().catch((e) => {
  postMessage({ id: null, type: "error", payload: String(e?.stack ?? e) });
});

self.addEventListener("message", (e) => {
  const { id, type, payload } = e.data;
  if (type !== "parse" || !oxc) return;

  const { filename, source } = payload;
  const t0 = performance.now();
  try {
    const result = oxc.parseSync(filename, source);
    const elapsed = performance.now() - t0;
    const { node } = JSON.parse(result.program);
    const summary = {
      parseTimeMs: elapsed,
      topLevel: node.body.map((s) => ({
        type: s.type,
        kind: s.kind ?? s.declaration?.type ?? null,
      })),
      errors: (result.errors || []).map((err) => err.message),
    };
    postMessage({ id, type: "result", payload: { summary } });
  } catch (err) {
    postMessage({
      id,
      type: "result",
      payload: { error: String(err?.stack ?? err) },
    });
  }
});
