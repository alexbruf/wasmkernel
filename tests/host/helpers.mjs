/**
 * Test helper: loads wasmkernel.wasm, initializes it, loads a guest,
 * and runs it to completion. Captures stdout/stderr output.
 */

import { readFileSync } from "fs";
import { WASI } from "wasi";
import { argv } from "process";

const KERNEL_PATH = new URL("../../build/wasmkernel.wasm", import.meta.url)
  .pathname;

/**
 * Run a guest wasm module inside wasmkernel.
 *
 * @param {string} guestPath - Path to the guest .wasm file
 * @returns {{ status: number, exitCode: number, stdout: string, stderr: string }}
 */
export async function runGuest(guestPath) {
  const kernelBytes = readFileSync(KERNEL_PATH);
  const guestBytes = readFileSync(guestPath);

  // Capture stdout/stderr
  let stdoutBuf = "";
  let stderrBuf = "";

  // Create WASI instance for the kernel itself
  const wasi = new WASI({
    version: "preview1",
    args: [],
    env: {},
    stdout: 1,
    stderr: 2,
  });

  const compiled = await WebAssembly.compile(kernelBytes);
  const instance = await WebAssembly.instantiate(compiled, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });

  // Initialize the reactor
  wasi.initialize(instance);

  const k = instance.exports;

  // Initialize kernel
  k.kernel_init();

  // Copy guest bytes into kernel memory
  const ptr = k.kernel_alloc(guestBytes.length);
  const mem = new Uint8Array(k.memory.buffer);
  mem.set(guestBytes, ptr);

  // Load guest
  const loadResult = k.kernel_load(ptr, guestBytes.length);
  if (loadResult !== 0) {
    return {
      status: loadResult,
      exitCode: 0,
      stdout: "",
      stderr: "",
      loadError: true,
    };
  }

  // Run
  const status = k.kernel_step();
  const exitCode = k.kernel_exit_code();

  return { status, exitCode, stdout: stdoutBuf, stderr: stderrBuf };
}
