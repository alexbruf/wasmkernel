/**
 * CF Worker + Durable Object with paged guest memory.
 *
 * Routes:
 *   POST /oxc     — parse a JS source with oxc-parser
 *   POST /rolldown — load rolldown binding (report if init succeeds)
 *
 * Both guests run in the same DO. Cold pages spill to the DO's sync
 * SQLite storage. Hot window = 100 pages (~6.4 MB) — tight on purpose.
 *
 * Test:
 *   wrangler dev
 *   curl :8787/oxc -d 'const x = 1 + 2;'
 *   curl :8787/rolldown
 */

import wasmkernelModule from "@alexbruf/wasmkernel/wasmkernel.wasm";
import oxcParserBytes from "./oxc-parser.wasm.bin";
import rolldownBytes from "./rolldown.wasm.bin";
import { instantiateNapiModule } from "@alexbruf/wasmkernel/worker";
import { WASI } from "@bjorn3/browser_wasi_shim";
import { createSqliteBackend } from "@alexbruf/wasmkernel/backends/sqlite-do";

export class BundlerDO {
  constructor(state) {
    this.state = state;
    this.sql = state.storage.sql;
    this.oxcPromise = null;
    this.rolldownPromise = null;
  }

  async _load(name, bytes) {
    const wasi = new WASI([], [], [], { debug: false });
    // Each guest gets its own paging table — use per-guest sqlite schema
    // via a table-prefix. Simpler: just share; different DO IDs could
    // isolate further.
    const backend = createSqliteBackend(this.sql);
    const t0 = Date.now();
    const { napiModule, kernel } = await instantiateNapiModule(
      new Uint8Array(bytes),
      {
        wasi,
        kernelModule: wasmkernelModule,
        memoryBackend: backend,
        hotWindowPages: 100,
        minInitialPages: 0,
        // Cap shared-memory pre-allocation at 1280 pages (80 MB) so the
        // kernel + JS heap + guest memory fit within CF Workers' 128 MB
        // isolate cap. WAMR pre-allocates the full max for shared
        // memories (required — see wasm_allocate_linear_memory), so the
        // cap is a hard bound on what the guest allocator can consume.
        sharedMemMaxPages: 1280,
      }
    );
    // Count resident pages post-load. If paging didn't activate we'd have
    // all logicalPages resident (identity mode); with paging, only seeded
    // pages are resident.
    const logicalPages = kernel.kernel_logical_page_count();
    const ptAddr = kernel.kernel_page_table_ptr();
    const pt = new Uint16Array(kernel.memory.buffer, ptAddr, logicalPages);
    let resident = 0;
    for (let i = 0; i < logicalPages; i++) if (pt[i] !== 0xFFFF) resident++;
    const paging = { logicalPages, residentAfterLoad: resident };
    return { exports: napiModule.exports, loadMs: Date.now() - t0, paging };
  }

  async _getOxc() {
    if (!this.oxcPromise) this.oxcPromise = this._load("oxc", oxcParserBytes);
    return this.oxcPromise;
  }

  async _getRolldown() {
    if (!this.rolldownPromise)
      this.rolldownPromise = this._load("rolldown", rolldownBytes);
    return this.rolldownPromise;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/oxc" && request.method === "POST") {
      const src = await request.text();
      const { exports, loadMs, paging } = await this._getOxc();
      const t = Date.now();
      const r = exports.parseSync("input.ts", src);
      const parseMs = Date.now() - t;
      const { node } = JSON.parse(r.program);
      return Response.json({
        ok: true,
        topLevelNodeTypes: (node?.body ?? []).map(n => n?.type ?? "?"),
        loadMs,
        parseMs,
        paging,
      });
    }

    if (url.pathname === "/rolldown" && request.method === "POST") {
      try {
        const { exports, loadMs } = await this._getRolldown();
        const src = (await request.text()) || "const x: number = 1 + 2;";
        const t = Date.now();
        // rolldown exposes transformSync / parseSync at the binding level.
        const result = exports.transformSync(
          "input.ts",
          src,
          JSON.stringify({ lang: "ts" }),
        );
        const transformMs = Date.now() - t;
        return Response.json({
          ok: true,
          loadMs,
          transformMs,
          srcBytes: src.length,
          codeLen: (result?.code ?? "").length,
          errorCount: (result?.errors ?? []).length,
          errorsFirst: (result?.errors ?? []).slice(0, 3),
          codePreview: (result?.code ?? "").slice(0, 200),
          resultKeys: Object.keys(result ?? {}),
        });
      } catch (e) {
        return Response.json(
          { ok: false, error: e.message, stack: e.stack },
          { status: 500 });
      }
    }

    return new Response(
      "POST /oxc with JS source\nPOST /rolldown\n",
      { headers: { "content-type": "text/plain" } });
  }
}

export default {
  async fetch(request, env) {
    // New singleton per deploy to avoid stale cached DO state.
    const id = env.BUNDLER.idFromName("singleton-v6");
    return env.BUNDLER.get(id).fetch(request);
  },
};
