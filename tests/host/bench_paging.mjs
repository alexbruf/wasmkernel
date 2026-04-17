/**
 * Eviction-cost benchmark.
 *
 * Run oxc-parser through a non-trivial parse many times, measure end-to-end
 * latency, varying hot-window size. Quantifies the speed/RSS trade-off.
 *
 *   node tests/host/bench_paging.mjs
 *
 * Reports: window size (pages) | load ms | mean parse ms | 95p parse ms |
 * cumulative evictions | peak rss delta.
 */

import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";
import { instantiateNapiModule } from "../../packages/wasmkernel/src/instantiate.js";
import { createInMemoryBackend } from "../../packages/wasmkernel/src/memory_backend.js";

const KERNEL = new URL("../../build/wasmkernel.wasm", import.meta.url).pathname;
const GUEST = new URL(
  "../pkgs/oxc/package/parser.wasm32-wasi.wasm",
  import.meta.url).pathname;

const kernelBytes = readFileSync(KERNEL);
const guestBytes = readFileSync(GUEST);

// Non-trivial source so parse work isn't trivial.
const TS_SRC = `
type Node<T> = { value: T; next?: Node<T> };
export class List<T> {
  private head?: Node<T>;
  constructor(xs: T[] = []) {
    for (let i = xs.length - 1; i >= 0; i--) {
      this.head = { value: xs[i], next: this.head };
    }
  }
  push(x: T): void { this.head = { value: x, next: this.head }; }
  pop(): T | undefined {
    if (!this.head) return undefined;
    const v = this.head.value; this.head = this.head.next; return v;
  }
  toArray(): T[] {
    const out: T[] = [];
    for (let n = this.head; n; n = n.next) out.push(n.value);
    return out;
  }
  map<U>(fn: (x: T) => U): List<U> {
    const r = new List<U>();
    for (const x of this.toArray().reverse()) r.push(fn(x));
    return r;
  }
  static of<T>(...xs: T[]): List<T> { return new List(xs); }
}

export async function main(): Promise<void> {
  const xs = List.of(1, 2, 3, 4, 5);
  const doubled = xs.map(x => x * 2);
  console.log(doubled.toArray());
}
`.trim();

async function runOne(label, opts) {
  const base = process.memoryUsage();
  const wasi = new WASI({ version: "preview1", args: [], env: {} });
  const { napiModule } = await instantiateNapiModule(kernelBytes, guestBytes, {
    wasi, minInitialPages: 0, ...opts,
  });
  const afterLoad = process.memoryUsage();
  const parse = napiModule.exports.parseSync;
  if (typeof parse !== "function") {
    throw new Error(`parseSync missing (${label})`);
  }
  // Warm up.
  parse("x.ts", TS_SRC);

  const N = 50;
  const times = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    parse("x.ts", TS_SRC);
    times.push(performance.now() - t);
  }
  const afterRun = process.memoryUsage();

  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / N;
  const p50 = times[Math.floor(N * 0.5)];
  const p95 = times[Math.floor(N * 0.95)];

  return {
    label,
    loadMs: afterLoad.timeOrigin,
    rssLoadMB: (afterLoad.rss - base.rss) / 1048576,
    rssRunMB: (afterRun.rss - base.rss) / 1048576,
    meanParseMs: mean,
    p50ParseMs: p50,
    p95ParseMs: p95,
  };
}

const results = [];

// Unpaged baseline.
results.push(await runOne("unpaged", {}));

// Paging with progressively tighter windows.
for (const n of [800, 400, 200, 100, 50, 20]) {
  const backend = createInMemoryBackend(0);
  results.push(await runOne(`paged-${n}`, {
    memoryBackend: backend,
    hotWindowPages: n,
  }));
}

// Table output.
console.log(
  "\n| config".padEnd(15) +
  "| rss_load".padEnd(12) +
  "| rss_run".padEnd(12) +
  "| p50 ms".padEnd(10) +
  "| p95 ms".padEnd(10) +
  "| mean ms".padEnd(10) + "|");
console.log("|" + "-".repeat(70) + "|");
for (const r of results) {
  console.log(
    "| " + r.label.padEnd(13) +
    "| " + r.rssLoadMB.toFixed(1).padEnd(10) +
    "| " + r.rssRunMB.toFixed(1).padEnd(10) +
    "| " + r.p50ParseMs.toFixed(2).padEnd(8) +
    "| " + r.p95ParseMs.toFixed(2).padEnd(8) +
    "| " + r.meanParseMs.toFixed(2).padEnd(8) + "|");
}
