/**
 * Repro: rolldown transformSync on progressively larger TS input, measuring
 * committed RSS delta. Demonstrates the workload that needs real slot-cycling
 * paging to stay under CF Workers' 128 MB isolate cap.
 *
 * Run: node tests/host/repro_rolldown_rss.mjs [sizeKB]
 *      PAGED=N node ... — also runs with hotWindowPages=N and an in-memory backend
 *
 * Interpretation:
 *   - rss delta = committed physical memory this guest's work cost
 *   - external delta = V8 WebAssembly.Memory bytes reserved (virtual)
 *
 * On Node, RSS shrinks after eviction (V8 honours MADV_FREE). On CF, it
 * doesn't — so the "PAGED=N" line is an upper bound on what CF would keep
 * committed. If that number exceeds ~120 MB we can't fit in a DO regardless
 * of paging strategy, without slot cycling (which the current v0.1.9 paging
 * layer does NOT implement — see CLAUDE.md).
 */

import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";
import { spawnSync } from "node:child_process";
import { instantiateNapiModule } from "../../packages/wasmkernel/src/instantiate.js";
import { createInMemoryBackend } from "../../packages/wasmkernel/src/memory_backend.js";

const KERNEL = new URL("../../build/wasmkernel.wasm", import.meta.url).pathname;
const ROLLDOWN = new URL(
  "../pkgs/rolldown/package/rolldown-binding.wasm32-wasi.wasm",
  import.meta.url).pathname;

const kernelBytes = readFileSync(KERNEL);
const guestBytes = readFileSync(ROLLDOWN);

// Size via CLI arg (KB). Default 512 KB — enough to see real memory pressure
// without a minute-long parse.
const sizeKB = parseInt(process.argv[2] ?? "512", 10);

// Generate a TS source of ~sizeKB. Mix of shapes so the parser builds a
// non-trivial AST: classes, generics, unions, enums. Rolldown's transformSync
// parses, transforms to JS, and emits — peak memory covers the full AST plus
// lowered output.
function makeTS(targetBytes) {
  // One "unit" per iteration, with a distinct suffix so identifiers don't
  // collide across units. Keep it simple — small TS valid on its own.
  function unit(i) {
    return [
      `export interface I${i} { a: number; b: string; c?: boolean }`,
      `export type T${i} = I${i} | null | undefined;`,
      `export enum E${i} { Alpha = 0, Beta = 1, Gamma = 2 }`,
      `export class C${i}<T extends I${i}> {`,
      `  constructor(public value: T) {}`,
      `  map<U>(fn: (t: T) => U): U { return fn(this.value); }`,
      `}`,
      `export function f${i}<T>(xs: T[]): T[] { return xs.slice(); }`,
      ``,
    ].join("\n");
  }
  const parts = [];
  let bytes = 0, i = 0;
  while (bytes < targetBytes) {
    const s = unit(i);
    parts.push(s);
    bytes += s.length;
    i++;
  }
  return parts.join("\n");
}

const mb = (b) => (b / 1048576).toFixed(1);

async function run(label, extraOpts) {
  const wasi = new WASI({ version: "preview1", args: [], env: {} });
  const base = process.memoryUsage();

  const { napiModule, pageCache } = await instantiateNapiModule(kernelBytes, guestBytes, {
    wasi,
    minInitialPages: 0,
    ...extraOpts,
  });

  if (typeof napiModule.exports.transformSync !== "function") {
    console.log(`${label}: transformSync missing — skipping`);
    return;
  }

  const src = makeTS(sizeKB * 1024);
  const t0 = Date.now();
  let outLen = 0, note = "";
  try {
    const r = napiModule.exports.transformSync(
      "big.ts", src, JSON.stringify({ lang: "ts" }));
    outLen = r?.code?.length ?? 0;
    if (!outLen) {
      note = ` (empty! keys=${Object.keys(r ?? {}).join(",")} errors=${
        r?.errors?.length ?? "?"})`;
    }
  } catch (e) {
    console.log(`${label}: transform error: ${e.message}`);
    return;
  }
  const afterRun = process.memoryUsage();

  const touched = pageCache?.uniqueTouchedPages ?? 0;
  const touchedMB = (touched * 64 / 1024).toFixed(1);
  console.log(
    `${label.padEnd(30)} ` +
    `src=${(src.length / 1024).toFixed(0)}KB ` +
    `out=${(outLen / 1024).toFixed(0)}KB${note} ` +
    `time=${Date.now() - t0}ms | ` +
    `touched=${touched}p (~${touchedMB}MB) | ` +
    `after-run rss+${mb(afterRun.rss - base.rss)}MB`);
}

// If REPRO_MODE is set, this process IS the subprocess; do one run and exit.
if (process.env.REPRO_MODE) {
  const mode = process.env.REPRO_MODE;
  const opts = mode === "unpaged"
    ? {}
    : {
        memoryBackend: createInMemoryBackend(0),
        hotWindowPages: parseInt(mode.replace("paged-", ""), 10),
      };
  await run(mode, opts);
  process.exit(0);
}

console.log(`Target source size: ${sizeKB} KB\n`);

function fork(mode) {
  const r = spawnSync(
    process.execPath,
    [new URL(import.meta.url).pathname, String(sizeKB)],
    {
      env: { ...process.env, REPRO_MODE: mode },
      stdio: ["ignore", "pipe", "inherit"],
    });
  process.stdout.write(r.stdout);
}

fork("unpaged");
for (const hw of [800, 400, 200, 100]) fork(`paged-${hw}`);
