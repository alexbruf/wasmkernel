import { defineConfig } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync } from "fs";

// Vite plugin: copy the published oxc-parser wasm into public/ at startup
// so it can be fetched at runtime. In a real app this is whatever your
// build pipeline does to ship the addon binary alongside the JS bundle.
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
  // @alexbruf/wasmkernel/browser fetches its kernel.wasm at runtime via
  // `new URL("../wasmkernel.wasm", import.meta.url)`. Vite needs to leave
  // that asset reference alone — it does, by default.
  optimizeDeps: {
    // Don't try to pre-bundle our package; it has dynamic imports that
    // confuse the optimizer and the kernel asset URL must remain
    // import.meta.url-relative.
    exclude: ["@alexbruf/wasmkernel"],
  },
  server: {
    fs: {
      // The wasmkernel package lives at ../../packages/wasmkernel — Vite
      // blocks fs access outside the project root by default (403 on /@fs/),
      // so we explicitly allow the repo root.
      allow: [resolve(__dirname, "..", "..")],
    },
    // SharedArrayBuffer / threads aren't required for this example, but
    // these headers don't hurt and many napi-rs addons want them in
    // production browser deployments.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
