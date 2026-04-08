# Browser example — `@alexbruf/wasmkernel`

A live AST explorer running entirely in the browser. Uses
[`@alexbruf/wasmkernel/browser`](../../packages/wasmkernel) to interpret the
published `@oxc-parser/binding-wasm32-wasi` binary, with
`@bjorn3/browser_wasi_shim` providing WASI imports.

## Run

From this directory:

```sh
bun install      # or npm install
bun run dev      # or npm run dev
```

Then open the printed URL (typically `http://localhost:5173`).

The page contains a textarea — edit JavaScript on the left, see the parsed
top-level statement summary on the right. Each keystroke triggers a fresh
`oxc.parseSync(…)` call through wasmkernel.

## What this shows

- The browser entry of `@alexbruf/wasmkernel` resolves the kernel wasm
  relative to its own module URL (`new URL("../wasmkernel.wasm", import.meta.url)`),
  so any bundler that respects `import.meta.url` (Vite, esbuild, webpack 5,
  Rollup, Parcel 2) ships it correctly.
- The published `parser.wasm32-wasi.wasm` is fetched at runtime — wasmkernel
  doesn't require any modifications to the addon binary or its loader.
- WASI imports come from `@bjorn3/browser_wasi_shim`. wasmkernel only needs
  the common subset (`fd_write`, `random_get`, `clock_time_get`,
  `proc_exit`, …), all of which the shim provides.
- Everything is single-threaded and cooperative. Heavy parses won't lock the
  page indefinitely — see the worker example if you want to keep the main
  thread totally free.

## Notes

- The Vite config sets `Cross-Origin-Opener-Policy` and
  `Cross-Origin-Embedder-Policy`. They're not strictly required for this
  example (we don't use SharedArrayBuffer), but they're a good default for
  production deployments that may want to enable threads later.
- `vite.config.js` excludes `@alexbruf/wasmkernel` from `optimizeDeps` so
  the dev server doesn't pre-bundle it and break the asset URL.
