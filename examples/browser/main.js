import { instantiateNapiModule } from "@alexbruf/wasmkernel/browser";
import { WASI } from "@bjorn3/browser_wasi_shim";

const statusEl = document.getElementById("status");
const srcEl = document.getElementById("src");
const outEl = document.getElementById("out");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? "status err" : "status";
}

async function load() {
  setStatus("fetching oxc-parser.wasm …");
  const guestBytes = new Uint8Array(
    await (await fetch("/oxc-parser.wasm")).arrayBuffer()
  );

  setStatus("instantiating wasmkernel + oxc-parser …");
  const wasi = new WASI([], [], [], { debug: false });
  const { napiModule } = await instantiateNapiModule(guestBytes, { wasi });
  const oxc = napiModule.exports;
  setStatus(`ready — ${guestBytes.length.toLocaleString()} bytes loaded`);

  function parse() {
    const source = srcEl.value;
    const t0 = performance.now();
    try {
      const result = oxc.parseSync("input.js", source);
      const elapsed = (performance.now() - t0).toFixed(2);
      const { node } = JSON.parse(result.program);
      const summary = {
        parseTimeMs: Number(elapsed),
        topLevel: node.body.map((s) => ({
          type: s.type,
          kind: s.kind ?? s.declaration?.type ?? null,
        })),
        errors: (result.errors || []).map((e) => e.message),
      };
      outEl.textContent = JSON.stringify(summary, null, 2);
      setStatus(`parsed in ${elapsed} ms`);
    } catch (e) {
      outEl.textContent = String(e);
      setStatus("parse failed", true);
    }
  }

  let timer = null;
  srcEl.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(parse, 120);
  });
  parse();
}

load().catch((e) => {
  console.error(e);
  setStatus(`load failed: ${e?.message ?? e}`, true);
});
