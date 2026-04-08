# wasmkernel

A cooperatively-scheduled WebAssembly Micro Runtime ([WAMR](https://github.com/bytecodealliance/wasm-micro-runtime)) compiled to `wasm32-wasi`. It interprets guest wasm modules from inside another wasm host — Node, browsers, Cloudflare Workers, anywhere wasm runs.

The most direct use case is **running napi-rs addons in environments that emnapi can't reach**: published `*.wasi.cjs` loaders work unmodified, with cooperative scheduling, a wall-clock watchdog, and full N-API compliance against Node's reference test suite.

A non-obvious second use case: because wasmkernel is itself a wasm interpreter, you can ship a single statically-bundled wasm to a runtime like Cloudflare Workers (which forbids `WebAssembly.compile()` after deploy) and **interpret arbitrary wasm bytes at request time** — fetched from R2, KV, request bodies, anywhere.

## What's in here

```
.
├── src/                       # WAMR platform layer + kernel C source
├── deps/wamr/                 # WAMR submodule
├── packages/wasmkernel/       # @alexbruf/wasmkernel npm package
├── examples/
│   ├── node/                  # Node CLI loading oxc-parser
│   ├── browser/               # Vite + browser_wasi_shim
│   ├── web-worker/            # Same, but on a Web Worker
│   └── cloudflare-worker/     # Cloudflare Worker (workerd) with wrangler
├── tests/                     # bun test suite + napi compliance + real packages
├── scripts/                   # build scripts
└── cmake/                     # wasi-sdk toolchain file
```

## Quick start (use the package)

```sh
npm install @alexbruf/wasmkernel @bjorn3/browser_wasi_shim
```

```js
import { loadNapiRs } from "@alexbruf/wasmkernel/node";

const { exports: oxc } = await loadNapiRs("./parser.wasm32-wasi.wasm");
const r = oxc.parseSync("f.js", "const x = 1 + 2");
```

See [`packages/wasmkernel/README.md`](./packages/wasmkernel/README.md) for the full API and [`examples/`](./examples) for runnable demos in four different environments.

## Build from source

You need [wasi-sdk](https://github.com/WebAssembly/wasi-sdk/releases) (currently pinned to v25) and `binaryen` (for `wasm-opt`).

```sh
# install deps (macOS shown; Linux uses apt-get install binaryen)
brew install binaryen
curl -L https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-arm64-macos.tar.gz | tar -xz -C /tmp

# build kernel + guest tests + run the suite
./scripts/build.sh
```

The binary lands in `build/wasmkernel.wasm` and is copied into `packages/wasmkernel/wasmkernel.wasm` by the publish flow.

## Status

Pre-1.0. The N-API surface covers 100% of Node's `test/js-native-api` function set and is verified against real published addons (oxc-parser, @node-rs/argon2, @node-rs/bcrypt, @tailwindcss/oxide). Scheduling, watchdog, and the wasi-threads test suite are all green. Known limitations and edge cases are tracked in [`CLAUDE.md`](./CLAUDE.md).

## License

MIT — see [LICENSE](./LICENSE).
