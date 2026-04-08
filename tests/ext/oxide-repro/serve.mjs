#!/usr/bin/env bun
/**
 * Tiny static server for the oxide Scanner ctor hang repro.
 *
 *  /                    -> index.html
 *  /oxide.wasm          -> ./oxide.wasm
 *  /vendor/<path>       -> ./vendor/<path>
 *  /wasmkernel/<path>   -> ../../../packages/wasmkernel/<path>   (LIVE from repo)
 *
 * Serves with COOP/COEP headers so SharedArrayBuffer is available,
 * matching what wasmkernel.wasm expects.
 */
import { file } from "bun";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dir);
const PKG_ROOT = resolve(ROOT, "..", "..", "..", "packages", "wasmkernel");

const HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cache-control": "no-store",
};

function mimeOf(path) {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "application/javascript";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".css")) return "text/css";
  return "application/octet-stream";
}

async function serveFile(diskPath) {
  const f = file(diskPath);
  if (!(await f.exists())) {
    return new Response(`404: ${diskPath}`, { status: 404, headers: HEADERS });
  }
  return new Response(f, {
    headers: { ...HEADERS, "content-type": mimeOf(diskPath) },
  });
}

const port = Number(process.env.PORT || 7878);
const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);

    // Map known prefixes
    if (p === "/" || p === "/index.html") {
      return serveFile(join(ROOT, "index.html"));
    }
    if (p.startsWith("/wasmkernel/")) {
      // Live source from packages/wasmkernel/
      return serveFile(join(PKG_ROOT, p.slice("/wasmkernel/".length)));
    }
    if (p.startsWith("/vendor/")) {
      return serveFile(join(ROOT, p.slice(1)));
    }
    // Default: serve from repro dir (oxide.wasm, etc)
    return serveFile(join(ROOT, p.slice(1)));
  },
});

console.log(`serving on http://localhost:${server.port}`);
console.log(`  / -> ${ROOT}/index.html`);
console.log(`  /oxide.wasm -> ${ROOT}/oxide.wasm`);
console.log(`  /vendor/** -> ${ROOT}/vendor/**`);
console.log(`  /wasmkernel/** -> ${PKG_ROOT}/**  (LIVE)`);
