import { defineConfig } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync } from "fs";

function copyOxcWasm() {
  return {
    name: "copy-oxc-wasm",
    buildStart() {
      const srcWasm = resolve(
        __dirname,
        "..",
        "..",
        "tests",
        "pkgs",
        "oxc",
        "package",
        "parser.wasm32-wasi.wasm"
      );
      mkdirSync(resolve(__dirname, "public"), { recursive: true });
      copyFileSync(srcWasm, resolve(__dirname, "public", "oxc-parser.wasm"));
    },
  };
}

export default defineConfig({
  plugins: [copyOxcWasm()],
  optimizeDeps: {
    exclude: ["@alexbruf/wasmkernel"],
  },
  worker: {
    format: "es",
  },
  server: {
    fs: {
      // The wasmkernel package lives at ../../packages/wasmkernel — Vite
      // blocks fs access outside the project root by default (403 on /@fs/),
      // so we explicitly allow the repo root.
      allow: [resolve(__dirname, "..", "..")],
    },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
