# Examples

Three runnable demos for [`@alexbruf/wasmkernel`](../packages/wasmkernel) —
the same package, three deployment shapes.

| Folder | What it shows | How to run |
|---|---|---|
| [`node/`](./node) | CLI loads `oxc-parser` and parses a JS file via `@alexbruf/wasmkernel/node` | `cd node && bun install && node parse.mjs` |
| [`browser/`](./browser) | Live AST explorer in the browser via `@alexbruf/wasmkernel/browser` + `@bjorn3/browser_wasi_shim` | `cd browser && bun install && bun run dev` |
| [`web-worker/`](./web-worker) | Same as browser, but the addon runs on a Web Worker (`@alexbruf/wasmkernel/worker`) | `cd web-worker && bun install && bun run dev` |
| [`cloudflare-worker/`](./cloudflare-worker) | Cloudflare Worker (workerd) that parses JS via `@alexbruf/wasmkernel/worker` and returns an AST summary | `cd cloudflare-worker && bun install && bun run dev` |

All three load the **published** `@oxc-parser/binding-wasm32-wasi` binary
unmodified — wasmkernel acts as a drop-in replacement for emnapi /
`@napi-rs/wasm-runtime`. Swap in any other napi-rs addon's
`*.wasm32-wasi.wasm` and they should work the same way.
