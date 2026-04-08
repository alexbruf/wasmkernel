# Web Worker example — `@alexbruf/wasmkernel`

Same idea as the browser example, but everything heavy runs on a **Web
Worker** (browser thread). The main thread only forwards parse requests
and renders results. For the **Cloudflare Workers** (workerd) edge
runtime, see [`../cloudflare-worker/`](../cloudflare-worker).

## Run

From this directory:

```sh
bun install      # or npm install
bun run dev      # or npm run dev
```

Open the printed URL (typically `http://localhost:5173`).

## What this shows

- `@alexbruf/wasmkernel/worker` is the Worker entry — the same code as
  `@alexbruf/wasmkernel/browser`, exported under a separate condition so
  bundlers can pick it up.
- The worker fetches `oxc-parser.wasm` from the same origin, instantiates
  it through wasmkernel, and replies to `postMessage` parse requests.
- All wasmkernel + oxc-parser work happens off-main-thread; even very
  large parse trees never block UI scrolling, animation, or input.
- Worker bundling is configured via `vite.config.js` (`worker.format = "es"`)
  so the worker entry is emitted as an ES module — needed because
  `@alexbruf/wasmkernel/worker` itself is ESM and uses dynamic imports.

## Notes

- Like the browser example, this doesn't strictly need the COOP/COEP
  cross-origin isolation headers, but they're set as a sensible default for
  any deployment that may want to enable threads later.
- For real workloads, you can pool multiple workers with simple round-robin
  message routing — wasmkernel's instances are fully isolated so this scales
  linearly until you hit the per-instance memory budget (256 MB by default).
