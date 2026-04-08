# oxide Scanner ctor hang repro

Minimal standalone browser repro for the bug where loading
`@tailwindcss/oxide-wasm32-wasi` through `@alexbruf/wasmkernel` and
calling `new Scanner({ sources: [{ base, pattern, negated }] })` used
to hang forever inside `kernel_step()`. Fixed in 0.1.6+ by the
`defaultWasiBridges` change.

Useful as a test bed for any future guest-WASI behavior we need to
iterate on in a real browser.

## Setup

The repro needs two vendored files that aren't committed to the repo
because they're third-party binaries:

- `oxide.wasm` — the published oxide WASM binary
- `vendor/browser_wasi_shim/` — the browser_wasi_shim JS dist

```sh
# From the repo root, after `bun install` in any project that has
# @tailwindcss/oxide-wasm32-wasi + @bjorn3/browser_wasi_shim installed:
cp path/to/node_modules/@tailwindcss/oxide-wasm32-wasi/tailwindcss-oxide.wasm32-wasi.wasm \
   tests/ext/oxide-repro/oxide.wasm
cp -r path/to/node_modules/@bjorn3/browser_wasi_shim/dist \
   tests/ext/oxide-repro/vendor/browser_wasi_shim
```

## Run

```sh
cd tests/ext/oxide-repro
bun serve.mjs
# open http://localhost:7878/
```

The server serves the HTML and the vendored assets, plus the LIVE
`packages/wasmkernel/src/` from the repo — so edits to `entry-browser.js`
or `wasi_bridge.js` take effect immediately on reload without needing
a rebuild or republish.

## What it tests

- `new Scanner({ sources: [] })` — empty ctor, cheapest path
- `new Scanner({ sources: [{ base: "/src", pattern: "**/*.html", negated: false }] })` —
  real sources, which triggers the guest's WASI filesystem walk
- `scanner.scan()` — return candidates (empty for empty VFS)
- `scanner.scanFiles([...])` — scan in-memory file contents

Expected: all five steps complete in under a second with no candidates
returned (because the default bridge gives oxide an empty filesystem).
