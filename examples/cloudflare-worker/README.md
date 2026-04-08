# Cloudflare Worker example — `@alexbruf/wasmkernel`

A Cloudflare Worker (running on **workerd**, the Cloudflare edge runtime)
that loads the published `oxc-parser` wasm32-wasi binary through wasmkernel
and exposes a tiny serverless AST endpoint.

## Run locally

From this directory:

```sh
bun install      # or npm install
bun run dev      # spins up `wrangler dev` on http://localhost:8787
```

In another terminal:

```sh
# health check
curl http://localhost:8787/

# parse some JS
curl http://localhost:8787/ -d 'const x = 1 + 2;'

# parse some TS (heuristic on the body, or set ?filename=foo.ts)
curl 'http://localhost:8787/?filename=foo.ts' \
  -d 'interface X { y: number } const a: X = { y: 1 };'
```

You should get back JSON like:

```json
{
  "filename": "input.js",
  "sourceLength": 16,
  "parseTimeMs": 2,
  "topLevel": [
    { "type": "VariableDeclaration", "kind": "const" }
  ],
  "errors": []
}
```

## Architecture

Two wasm files are involved, loaded differently to fit Cloudflare's bundle
limits:

- **`wasmkernel.wasm` (~310 KB, ~100 KB gzipped)** is imported statically as a
  `WebAssembly.Module`:

  ```js
  import wasmkernelModule from "@alexbruf/wasmkernel/wasmkernel.wasm";
  ```

  Wrangler bundles `.wasm` imports as compiled modules by default — no
  `[wasm_modules]` config needed. We then pass the module to wasmkernel
  via `instantiateNapiModule(guestBytes, { kernelModule: wasmkernelModule })`,
  using the `kernelModule` option added for exactly this case.

- **`oxc-parser.wasm` (~1.7 MB)** lives in `public/` and is served via the
  static `[assets]` binding. On cold start the worker fetches it once,
  feeds the bytes into wasmkernel, and caches the resulting `napiModule`
  in a module-global so subsequent requests are warm.

This split keeps the deployable script bundle small while letting the
larger guest addon ride along as an asset.

## Notes

- **Free vs paid plan.** wasmkernel is ~100 KB gzipped, oxc-parser is
  ~700 KB gzipped, so the combined deployable bundle (~800 KB compressed)
  fits comfortably under the 1 MB Workers Free plan limit. Larger guest
  addons may need the paid plan, but the kernel itself is small enough
  that you have most of the budget to spend on whatever you're loading.
- **Cold-start cost.** Compiling wasmkernel + instantiating oxc-parser
  takes a few hundred ms on a fresh isolate. After that, every request
  reuses the same parser via the module-global cache, so warm requests
  are dominated by the actual parse time (single-digit ms for typical
  source files).
- **CPU time limits.** Workers paid plans give you 30 s of CPU per request
  by default. wasmkernel has its own wall-clock watchdog you can enable
  via `kernel_set_watchdog_ms` if you want to bound parse runtime more
  tightly than that.
- **No threads.** workerd doesn't expose `SharedArrayBuffer` by default,
  so wasmkernel runs single-threaded here. This is fine for parsing —
  oxc-parser doesn't use guest threads anyway.

## What this shows

- `@alexbruf/wasmkernel` works in Cloudflare Workers / workerd unmodified —
  the `worker` export condition resolves to the same code as the browser
  entry, and the new `kernelModule` option lets you avoid the
  `fetch(new URL(..., import.meta.url))` pattern that workerd doesn't
  support.
- The same published `parser.wasm32-wasi.wasm` shipped on npm runs end-to-end
  on the edge — no rebuild, no rewrap, no separate Cloudflare-specific
  loader.
