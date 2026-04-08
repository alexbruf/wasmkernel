// Run an infinite loop guest with a 500ms watchdog; verify it trips.
import { readFileSync } from "fs";
import { WASI } from "wasi";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KERNEL = join(__dirname, "..", "..", "build", "wasmkernel.wasm");
const GUEST = join(__dirname, "..", "guest", "infinite_loop.wasm");

const wasi = new WASI({ version: "preview1", args: [], env: {} });
const pendingIO = new Map();
let k;
const hostImports = {
  host_func_call(funcIdx, argsPtr, argc) { return 0n; },
  host_io_submit(cb) { pendingIO.set(cb, { bytes: 0, error: 0 }); },
  host_io_check(cb) { return pendingIO.has(cb) ? 1 : 0; },
  host_io_result_bytes(cb) { return pendingIO.get(cb)?.bytes ?? 0; },
  host_io_result_error(cb) { const r = pendingIO.get(cb); if (r) pendingIO.delete(cb); return r?.error ?? 8; },
};

const inst = await WebAssembly.instantiate(
  await WebAssembly.compile(readFileSync(KERNEL)),
  { wasi_snapshot_preview1: wasi.wasiImport, host: hostImports }
);
wasi.initialize(inst);
k = inst.exports;
k.kernel_init();

const guestBytes = readFileSync(GUEST);
const ptr = k.kernel_alloc(guestBytes.length);
new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
if (k.kernel_load(ptr, guestBytes.length) !== 0) throw new Error("kernel_load failed");

// Set 500ms watchdog
k.kernel_set_watchdog_ms(500);

const start = Date.now();
let status = 0;
let steps = 0;
while (status === 0) {
  status = k.kernel_step();
  steps++;
  if (Date.now() - start > 3000) {
    console.error("BUG: watchdog didn't trip after 3s!");
    process.exit(1);
  }
}
const elapsed = Date.now() - start;

console.log(`status=${status}, elapsed=${elapsed}ms, steps=${steps}`);
console.log(`watchdog tripped: ${k.kernel_watchdog_tripped()}`);
if (status === -1 && k.kernel_watchdog_tripped() && elapsed >= 450 && elapsed < 1500) {
  console.log("PASS — watchdog tripped at expected time");
  process.exit(0);
} else {
  console.log("FAIL — unexpected state");
  process.exit(1);
}
