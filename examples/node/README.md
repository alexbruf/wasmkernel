# Node example — `@alexbruf/wasmkernel`

Loads the published `@oxc-parser/binding-wasm32-wasi` binary through wasmkernel and parses a JavaScript snippet.

## Run

From this directory:

```sh
# install the local package (file: link)
npm install

# parse a built-in inline snippet
node parse.mjs

# or parse a file
node parse.mjs ../../README.md  # works on any text file
```

You should see something like:

```
Loading oxc-parser via @alexbruf/wasmkernel ...
  ready (exports: ParseResult, parseAsync, parseSync, ...)

Parsing <inline> (208 chars) ...
  done in 1.42 ms
  4 top-level statements:
    - VariableDeclaration (const)
    - ClassDeclaration
    - ExportDefaultDeclaration
```

## What this shows

- `loadNapiRs(path)` is wasmkernel's convenience for loading a napi-rs addon
  from a `.wasm` file. It builds a `node:wasi` instance for you and returns
  the addon's exported functions.
- The addon is the same `parser.wasm32-wasi.wasm` shipped on npm — wasmkernel
  is interpreting it cooperatively, not running it on a worker thread pool.
- For drop-in replacement of `@napi-rs/wasm-runtime` (so existing
  `*.wasi.cjs` loaders work unchanged), use a `Module._resolveFilename` hook
  or your bundler's alias system. See the package README for details.
