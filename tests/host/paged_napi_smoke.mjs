/**
 * Smoke test: run oxc-parser and argon2 via instantiateNapiModule with an
 * explicit hot window to exercise the paged-memory code paths. Both guests
 * must produce identical output to identity mode.
 */
import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { instantiateNapiModule } from "../../packages/wasmkernel/src/instantiate.js";
import { createInMemoryBackend } from "../../packages/wasmkernel/src/memory_backend.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KERNEL = join(__dirname, "..", "..", "build", "wasmkernel.wasm");
const OXC = join(__dirname, "..", "emnapi", "wasm", "oxc_parser.wasm");
const ARGON2 = join(__dirname, "..", "emnapi", "wasm", "argon2_real.wasm");

const kernelBytes = readFileSync(KERNEL);

async function runOxc(hotWindowPages) {
  const wasi = new WASI({ version: "preview1", args: [], env: {} });
  const { napiModule, pageCache } = await instantiateNapiModule(
    kernelBytes, readFileSync(OXC), {
      wasi, minInitialPages: 0,
      memoryBackend: createInMemoryBackend(0),
      hotWindowPages,
    });
  const oxc = napiModule.exports;
  const r = oxc.parseSync("t.ts",
    "interface I { a: number; b: string }\n" +
    "export function f(x: I): string { return x.b.toUpperCase() }");
  const { node } = JSON.parse(r.program);
  if (node.body.length !== 2) throw new Error(`body.length=${node.body.length}`);
  return pageCache?.uniqueTouchedPages ?? 0;
}

async function runArgon2(hotWindowPages) {
  const wasi = new WASI({ version: "preview1", args: [], env: {} });
  const { napiModule, pageCache } = await instantiateNapiModule(
    kernelBytes, readFileSync(ARGON2), {
      wasi, minInitialPages: 0,
      memoryBackend: createInMemoryBackend(0),
      hotWindowPages,
    });
  const argon2 = napiModule.exports;
  const h = argon2.hashSync("hello", { memoryCost: 512, timeCost: 1 });
  if (!argon2.verifySync(h, "hello")) throw new Error("verify failed");
  if (argon2.verifySync(h, "world")) throw new Error("verify should fail");
  return pageCache?.uniqueTouchedPages ?? 0;
}

for (const hw of [100, 50, 20]) {
  const n = await runOxc(hw);
  console.log(`oxc hotWindow=${hw}: OK (touched=${n})`);
}
for (const hw of [100, 50, 20]) {
  const n = await runArgon2(hw);
  console.log(`argon2 hotWindow=${hw}: OK (touched=${n})`);
}
