# @alexbruf/wasmkernel

Drop-in replacement for [`@napi-rs/wasm-runtime`](https://www.npmjs.com/package/@napi-rs/wasm-runtime) backed by **wasmkernel** — a cooperatively-scheduled WAMR-based N-API runtime for JavaScript.

## Why

`@napi-rs/wasm-runtime` uses emnapi to run napi-rs addons in the browser / Node / Workers. It works, but relies on spawning Web Workers for threading, doesn't offer cooperative scheduling, and has a number of papercuts under sustained load.

`@alexbruf/wasmkernel` is a drop-in replacement that runs the same addons through our own WAMR-based interpreter with cooperative scheduling, a wall-clock watchdog, and first-class N-API compliance against Node's reference suite.

It exposes the same three functions napi-rs's published `.wasi.cjs` loaders import, so you can swap it in by redirecting the module — no changes to the published addon.

## Installation

```sh
npm install @alexbruf/wasmkernel
# or
bun add @alexbruf/wasmkernel
```

For browser/worker usage, also install the WASI shim:

```sh
npm install @bjorn3/browser_wasi_shim
```

## Usage

### As a drop-in replacement for `@napi-rs/wasm-runtime`

Most napi-rs addons ship with a `*.wasi.cjs` loader that `require('@napi-rs/wasm-runtime')`. You have two options:

1. **Module alias** — tell your bundler/resolver that `@napi-rs/wasm-runtime` resolves to `@alexbruf/wasmkernel`. In Node you can override via a custom `Module._resolveFilename` hook, in esbuild/webpack via `alias`, in Vite via `resolve.alias`.

2. **Direct usage** — call `instantiateNapiModule` yourself with the guest wasm bytes.

### Direct (Node)

```js
import { loadNapiRs } from "@alexbruf/wasmkernel/node";

const { exports: oxc } = await loadNapiRs("./parser.wasm32-wasi.wasm");
const r = oxc.parseSync("f.js", "const x = 1 + 2");
```

### Direct (Browser / Workers)

```js
import { instantiateNapiModule } from "@alexbruf/wasmkernel/browser";
import { WASI } from "@bjorn3/browser_wasi_shim";

const guestBytes = new Uint8Array(await (await fetch("./addon.wasm")).arrayBuffer());
const wasi = new WASI([], [], []);

const { napiModule } = await instantiateNapiModule(guestBytes, { wasi });
const addon = napiModule.exports;
```

## Examples

Three runnable examples live under [`examples/`](../../examples) in this repo:

- **`examples/node`** — CLI that loads the published `oxc-parser` wasm and parses a JS file
- **`examples/browser`** — HTML page that parses code typed into a textarea
- **`examples/web-worker`** — moves the addon onto a Web Worker so the main thread stays responsive
- **`examples/cloudflare-worker`** — runs the addon inside a Cloudflare Worker (workerd) and returns a parsed AST

## Exports

Same shape as `@napi-rs/wasm-runtime`:

- **`instantiateNapiModuleSync(guestBytes, options)`** — synchronous on Node, throws on browser/workers. Returns `{ instance, module, napiModule }`. Used by published `.wasi.cjs` loaders.
- **`instantiateNapiModule(guestBytes, options)`** — async version, works everywhere.
- **`getDefaultContext()`** — returns an empty context (vestigial emnapi API).
- **`createOnMessage(fsApi)`** — returns a no-op message handler. Wasmkernel doesn't use napi-rs's in-worker fs proxy.

### Subpath entries

- `@alexbruf/wasmkernel/node` — Node entry, ESM + CJS
- `@alexbruf/wasmkernel/browser` — Browser entry (async only)
- `@alexbruf/wasmkernel/worker` — Worker entry (re-exports the browser entry)

The package also resolves under conditional exports (`node`, `browser`, `worker`/`workerd`) when imported as the bare specifier `@alexbruf/wasmkernel`.

### Options

- **`wasi`** *(required)* — a WASI implementation. On Node, pass `new WASI({ version: "preview1", ... })` from `node:wasi`. On browsers, pass a `@bjorn3/browser_wasi_shim` instance or equivalent.
- **`minInitialPages`** *(default: 4000)* — minimum initial memory pages for the guest. Matches emnapi's default of a 256 MB shared memory; needed so Rust's allocator in napi-rs addons places buffers where the addon was validated.
- **`beforeInit({ instance })`** — called before `napi_register_module_v1` runs. Use this to call `__napi_register__*` exports manually. If omitted, we auto-call every one we find.
- **`wasiBridges`** — extra WASI import handlers beyond the built-in `random_get`.
- **`asyncWorkPoolSize`, `onCreateWorker`, `reuseWorker`, `context`, `overwriteImports`** — accepted for compatibility with `@napi-rs/wasm-runtime`, currently ignored.

## Differences from `@napi-rs/wasm-runtime`

| Aspect | `@napi-rs/wasm-runtime` | `@alexbruf/wasmkernel` |
|---|---|---|
| Engine | emnapi on host JS engine | WAMR compiled to wasm32-wasi |
| Threading | Web Workers | Cooperative single-process |
| Scheduling | Host engine | Fuel-based, wall-clock watchdog |
| Sync instantiate | Yes (Node) | Yes (Node), no (browser) |
| Async work pool | Real worker threads | Cooperative, single thread |
| N-API coverage | emnapi's subset | 100% of Node's `test/js-native-api` functions |

## Limitations

- **Async work runs on the main thread.** Addons that rely on true parallelism (e.g. `@napi-rs/image` scaling on multiple cores) won't see a speedup here. They'll still work — just serialized.
- **Browser path requires a WASI shim.** `@bjorn3/browser_wasi_shim` is the reference.
- **This is pre-1.0 software.** The N-API surface is complete and tested against real packages (argon2, oxc-parser, bcrypt, @tailwindcss/oxide), but the finalizer ordering and resource-accounting edges are still being hardened. See the root `CLAUDE.md` for known issues.

## License

MIT.
