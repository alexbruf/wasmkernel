#!/usr/bin/env node
/**
 * Test loading @tailwindcss/oxide through WasmKernel with napi bridge.
 * Replicates emnapi's exact initialization flow.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "fs";
import { WASI } from "wasi";
import { NapiRuntime } from "./napi_runtime.mjs";
import { join } from "path";

const kernelBytes = readFileSync(new URL("../../build/wasmkernel.wasm", import.meta.url).pathname);
const guestBytes = readFileSync("/tmp/tw-oxide/package/tailwindcss-oxide.wasm32-wasi.wasm");
const wasi = new WASI({ version: "preview1", args: [], env: {} });

const pendingIO = new Map();
const bridgeFunctions = new Map();
let bridgeNames = [];

const hostImports = {
  host_func_call(funcIdx, argsPtr, argc) {
    const handler = bridgeFunctions.get(funcIdx);
    if (!handler) {
      console.error(`  UNHANDLED bridge[${funcIdx}] = ${bridgeNames[funcIdx]}`);
      return 0n;
    }
    // Read args with fresh buffer each time (memory may have grown)
    const args = [];
    for (let i = 0; i < argc; i++) {
      args.push(new DataView(k.memory.buffer).getUint32(argsPtr + i * 8, true));
    }
    try {
      return handler(args, argsPtr);
    } catch (e) {
      console.error(`  BRIDGE ERROR ${bridgeNames[funcIdx]}: ${e.message}`);
      return 0n;
    }
  },
  host_io_submit(cb, op, fd, buf, len) { pendingIO.set(cb, { bytes: 0, error: 0 }); },
  host_io_check(cb) { return pendingIO.has(cb) ? 1 : 0; },
  host_io_result_bytes(cb) { return pendingIO.get(cb)?.bytes ?? 0; },
  host_io_result_error(cb) { const r = pendingIO.get(cb); if (r) pendingIO.delete(cb); return r?.error ?? 8; },
};

const compiled = await WebAssembly.compile(kernelBytes);
const instance = await WebAssembly.instantiate(compiled, {
  wasi_snapshot_preview1: wasi.wasiImport,
  host: hostImports,
});
wasi.initialize(instance);
const k = instance.exports;
k.kernel_init();

console.log("Loading oxide (" + (guestBytes.length / 1024 / 1024).toFixed(1) + " MB)...");
const ptr = k.kernel_alloc(guestBytes.length);
new Uint8Array(k.memory.buffer, ptr, guestBytes.length).set(guestBytes);
const loadResult = k.kernel_load(ptr, guestBytes.length);
if (loadResult !== 0) { console.error("load failed:", loadResult); process.exit(1); }

// Setup napi + WASI bridge
const napiRuntime = new NapiRuntime(k);
napiRuntime.debug = false;

// Virtual filesystem for WASI bridge
const openFds = new Map(); // fd -> { type: 'dir'|'file', path, entries?, offset? }
let nextFd = 10;

// Helper: read/write guest memory (always fresh buffer)
function guestRead(ptr, len) {
  const base = k.kernel_guest_memory_base();
  return new Uint8Array(k.memory.buffer).slice(base + ptr, base + ptr + len);
}
function guestReadStr(ptr, len) {
  return new TextDecoder().decode(guestRead(ptr, len));
}
function guestWrite(ptr, data) {
  const base = k.kernel_guest_memory_base();
  new Uint8Array(k.memory.buffer).set(data, base + ptr);
}
function guestWriteU32(ptr, val) {
  const base = k.kernel_guest_memory_base();
  new DataView(k.memory.buffer).setUint32(base + ptr, val, true);
}
function guestWriteU64(ptr, val) {
  const base = k.kernel_guest_memory_base();
  new DataView(k.memory.buffer).setBigUint64(base + ptr, BigInt(val), true);
}

const wasiFunctions = {
  random_get(args) {
    const [bufPtr, bufLen] = args;
    const base = k.kernel_guest_memory_base();
    for (let i = 0; i < bufLen; i++) {
      new Uint8Array(k.memory.buffer)[base + bufPtr + i] = (Math.random() * 256) | 0;
    }
    return 0n;
  },

  // path_open(dirfd, dirflags, path_ptr, path_len, oflags, fs_rights_base, fs_rights_inheriting, fdflags, fd_out_ptr)
  path_open(args) {
    const [dirfd, dirflags, pathPtr, pathLen, oflags] = args;
    // args[5-6] are fs_rights (i64 each, but we only get lo 32 bits through bridge)
    const fdOutPtr = args[8];
    const pathStr = guestReadStr(pathPtr, pathLen);

    // Resolve path relative to dirfd's directory
    let resolvedPath = pathStr;
    if (dirfd === 3) {
      // fd 3 = preopen "/"
      resolvedPath = "/" + pathStr;
    } else if (dirfd >= 10 && openFds.has(dirfd)) {
      const parent = openFds.get(dirfd);
      if (parent.type === 'dir') resolvedPath = join(parent.path, pathStr);
    } else if (pathStr.startsWith('/')) {
      resolvedPath = pathStr;
    }

    try {
      const st = statSync(resolvedPath);
      const fd = nextFd++;
      if (st.isDirectory()) {
        const entries = readdirSync(resolvedPath);
        openFds.set(fd, { type: 'dir', path: resolvedPath, entries, offset: 0 });
      } else {
        openFds.set(fd, { type: 'file', path: resolvedPath, content: readFileSync(resolvedPath) });
      }
      guestWriteU32(fdOutPtr, fd);
      return 0n; // success
    } catch (e) {
      return 44n; // ENOENT
    }
  },

  // fd_readdir(fd, buf_ptr, buf_len, cookie, bufused_ptr)
  fd_readdir(args) {
    const [fd, bufPtr, bufLen, cookie, bufUsedPtr] = args;
    const info = openFds.get(fd);
    if (!info || info.type !== 'dir') return 8n; // BADF

    // WASI dirent: d_next(u64) + d_ino(u64) + d_namlen(u32) + d_type(u8) + name
    let offset = 0;
    const startIdx = Number(cookie);
    for (let i = startIdx; i < info.entries.length; i++) {
      const name = info.entries[i];
      const nameBytes = new TextEncoder().encode(name);
      const entrySize = 24 + nameBytes.length; // 8+8+4+1+3pad = 24 header + name
      if (offset + entrySize > bufLen) break;

      // Write dirent header
      guestWriteU64(bufPtr + offset, i + 1);       // d_next
      guestWriteU64(bufPtr + offset + 8, 0);       // d_ino
      guestWriteU32(bufPtr + offset + 16, nameBytes.length); // d_namlen
      // d_type: 4=dir, 8=regular file
      let dtype = 8;
      try { if (statSync(join(info.path, name)).isDirectory()) dtype = 4; } catch {}
      guestWrite(bufPtr + offset + 20, new Uint8Array([dtype, 0, 0, 0])); // d_type + padding
      guestWrite(bufPtr + offset + 24, nameBytes);  // name
      offset += entrySize;
    }
    guestWriteU32(bufUsedPtr, offset);
    return 0n;
  },

  // path_filestat_get(fd, flags, path_ptr, path_len, buf_ptr)
  path_filestat_get(args) {
    const [fd, flags, pathPtr, pathLen, bufPtr] = args;
    const pathStr = guestReadStr(pathPtr, pathLen);
    let resolvedPath = pathStr;
    if (fd === 3) {
      // fd 3 = preopen "/"
      resolvedPath = "/" + pathStr;
    } else if (fd >= 10 && openFds.has(fd)) {
      const parent = openFds.get(fd);
      if (parent.type === 'dir') resolvedPath = join(parent.path, pathStr);
    }

    try {
      const st = statSync(resolvedPath);
      // filestat: dev(u64) + ino(u64) + filetype(u8+7pad) + nlink(u64) + size(u64) + atim(u64) + mtim(u64) + ctim(u64) = 64 bytes
      const buf = new Uint8Array(64);
      const dv = new DataView(buf.buffer);
      dv.setBigUint64(0, 0n, true);   // dev
      dv.setBigUint64(8, 0n, true);   // ino
      buf[16] = st.isDirectory() ? 3 : 4; // filetype: 3=dir, 4=regular
      dv.setBigUint64(24, 1n, true);  // nlink
      dv.setBigUint64(32, BigInt(st.size), true);  // size
      dv.setBigUint64(40, BigInt(Math.floor(st.atimeMs * 1e6)), true);  // atim
      dv.setBigUint64(48, BigInt(Math.floor(st.mtimeMs * 1e6)), true);  // mtim
      dv.setBigUint64(56, BigInt(Math.floor(st.ctimeMs * 1e6)), true);  // ctim
      guestWrite(bufPtr, buf);
      return 0n;
    } catch {
      return 44n; // ENOENT
    }
  },

  // fd_filestat_get(fd, buf_ptr)
  fd_filestat_get(args) {
    const [fd, bufPtr] = args;
    const info = openFds.get(fd);
    if (!info) return 8n; // BADF

    try {
      const st = statSync(info.path);
      const buf = new Uint8Array(64);
      const dv = new DataView(buf.buffer);
      dv.setBigUint64(0, 0n, true);
      dv.setBigUint64(8, 0n, true);
      buf[16] = st.isDirectory() ? 3 : 4;
      dv.setBigUint64(24, 1n, true);
      dv.setBigUint64(32, BigInt(st.size), true);
      dv.setBigUint64(40, BigInt(Math.floor(st.atimeMs * 1e6)), true);
      dv.setBigUint64(48, BigInt(Math.floor(st.mtimeMs * 1e6)), true);
      dv.setBigUint64(56, BigInt(Math.floor(st.ctimeMs * 1e6)), true);
      guestWrite(bufPtr, buf);
      return 0n;
    } catch {
      return 8n;
    }
  },

  // fd_prestat_get(fd, buf_ptr) -> errno
  // buf = prestat struct: tag(u8) + pad(3) + dir_name_len(u32) = 8 bytes
  fd_prestat_get(args) {
    const [fd, bufPtr] = args;
    if (fd === 3) {
      // fd 3 = preopen for "/"
      const buf = new Uint8Array(8);
      buf[0] = 0; // __WASI_PREOPENTYPE_DIR
      new DataView(buf.buffer).setUint32(4, 1, true); // name len = 1 (for "/")
      guestWrite(bufPtr, buf);
      return 0n;
    }
    return 8n; // BADF
  },

  // fd_prestat_dir_name(fd, path_ptr, path_len) -> errno
  fd_prestat_dir_name(args) {
    const [fd, pathPtr, pathLen] = args;
    if (fd === 3) {
      guestWrite(pathPtr, new TextEncoder().encode("/"));
      return 0n;
    }
    return 8n;
  },

  // fd_read(fd, iovs_ptr, iovs_len, nread_ptr) -> errno
  fd_read(args) {
    const [fd, iovsPtr, iovsLen, nreadPtr] = args;
    const info = openFds.get(fd);
    if (!info || info.type !== 'file') return 8n; // BADF

    const content = info.content;
    const offset = info.readOffset ?? 0;
    if (offset >= content.length) {
      // EOF
      guestWriteU32(nreadPtr, 0);
      return 0n;
    }

    // Read iov buffers
    let totalRead = 0;
    for (let i = 0; i < iovsLen; i++) {
      const bufPtr = new DataView(k.memory.buffer).getUint32(k.kernel_guest_memory_base() + iovsPtr + i * 8, true);
      const bufLen = new DataView(k.memory.buffer).getUint32(k.kernel_guest_memory_base() + iovsPtr + i * 8 + 4, true);
      const remaining = content.length - offset - totalRead;
      const toRead = Math.min(bufLen, remaining);
      if (toRead > 0) {
        guestWrite(bufPtr, content.subarray(offset + totalRead, offset + totalRead + toRead));
        totalRead += toRead;
      }
    }
    info.readOffset = offset + totalRead;
    guestWriteU32(nreadPtr, totalRead);
    return 0n;
  },

  fd_close(args) {
    const [fd] = args;
    openFds.delete(fd);
    return 0n;
  },
};

const bridgeCount = k.kernel_bridge_count();
const infoBuf = k.kernel_alloc(256);
bridgeNames = [];
for (let i = 0; i < bridgeCount; i++) {
  const len = k.kernel_bridge_info(i, infoBuf, 256);
  if (!len) { bridgeNames.push(`?${i}`); continue; }
  const bytes = new Uint8Array(k.memory.buffer, infoBuf, len);
  const parts = []; let start = 0;
  for (let j = 0; j < len; j++) { if (bytes[j] === 0) { parts.push(new TextDecoder().decode(bytes.slice(start, j))); start = j + 1; } }
  const [mod, field] = parts;
  bridgeNames.push(`${mod}.${field}`);
  if (mod === "env" && napiRuntime[field]) {
    const fn = field;
    bridgeFunctions.set(i, (args, argsPtr) => napiRuntime.dispatch(fn, args, argsPtr));
  } else if (mod === "wasi_snapshot_preview1" && wasiFunctions[field]) {
    const fn = field;
    bridgeFunctions.set(i, (args) => { const r = wasiFunctions[fn](args); return typeof r === 'bigint' ? r : BigInt(r ?? 0); });
  } else {
    const fname = `${mod}.${field}`;
    bridgeFunctions.set(i, (args) => { console.error(`  STUB: ${fname}(${args.join(',')})`); return 0n; });
  }
}

console.log("Guest memory:", (k.kernel_guest_memory_size() / 1024 / 1024).toFixed(1), "MB at offset", k.kernel_guest_memory_base());

// Helper to call guest exports
function callExport(name, args = []) {
  const np = k.kernel_alloc(name.length + 1);
  new Uint8Array(k.memory.buffer, np, name.length + 1).set(new TextEncoder().encode(name));
  new Uint8Array(k.memory.buffer)[np + name.length] = 0;
  const ap = k.kernel_alloc(Math.max(args.length, 1) * 4);
  args.forEach((a, i) => new DataView(k.memory.buffer).setUint32(ap + i * 4, a, true));
  const r = k.kernel_call(np, ap, args.length);
  return { status: r, retVal: new DataView(k.memory.buffer).getUint32(ap, true) };
}

// ===== EMNAPI-COMPATIBLE INITIALIZATION FLOW =====

// Step 1: _initialize (wasi reactor init - already happened during kernel_load's
//         wasm start function. But the scheduler also runs _initialize.)
console.log("\n=== Step 1: _initialize ===");
let status = 0;
while (status === 0) status = k.kernel_step();
console.log("_initialize:", status === 1 ? "OK" : `FAIL(${status})`);
if (status !== 1) process.exit(1);

// Step 2: beforeInit - call __napi_register__ exports (like emnapi does)
console.log("\n=== Step 2: beforeInit (__napi_register__) ===");
const r1 = callExport("__napi_register__Scanner_struct_4");
console.log("Scanner_struct_4:", r1.status === 0 ? "OK" : `FAIL(${r1.status})`);
const r2 = callExport("__napi_register__Scanner_impl_13");
console.log("Scanner_impl_13:", r2.status === 0 ? "OK" : `FAIL(${r2.status})`);

// Step 3: napiModule.init - call napi_register_wasm_v1(env, exports)
console.log("\n=== Step 3: napi_register_wasm_v1 ===");
const exportsObj = {};
const exportsHandle = napiRuntime._newHandle(exportsObj);
const envHandle = 1;

const reg = callExport("napi_register_wasm_v1", [envHandle, exportsHandle]);
console.log("napi_register_wasm_v1:", reg.status === 0 ? "OK" : `FAIL(${reg.status})`);

// Check what we got
const resultObj = napiRuntime._getHandle(reg.retVal) ?? exportsObj;
console.log("\n=== Results ===");
console.log("Exports keys:", Object.keys(resultObj));

if (resultObj.Scanner) {
  console.log("Scanner class:", resultObj.Scanner);
  console.log("Scanner methods:", Object.keys(resultObj.Scanner.prototype ?? {}));

  console.log("\n=== Trying Scanner ===");
  try {
    // Create a test directory with an HTML file for oxide to discover
    const testDir = "/tmp/wasmkernel-oxide-test";
    try { mkdirSync(testDir, { recursive: true }); } catch {}
    const content = '<div class="flex items-center bg-blue-500 p-4 text-white hover:bg-blue-600">Hello</div>';
    writeFileSync(join(testDir, "test.html"), content);

    // Create scanner with source dir
    const scanner = new resultObj.Scanner({
      sources: [{ base: testDir, pattern: "**/*.html", negated: false }],
    });
    console.log("Scanner created:", scanner);
    console.log("\nScanning:", content.slice(0, 60) + "...");

    // scanFiles with content
    const filePath = join(testDir, "test.html");
    const scanResult = scanner.scanFiles([{ file: filePath, content, extension: "html" }]);
    console.log("scanFiles result:", JSON.stringify(scanResult)?.slice(0, 300));
    if (Array.isArray(scanResult)) console.log("scanFiles count:", scanResult.length);

    // scan() returns accumulated candidates
    const scan2 = scanner.scan();
    console.log("scan() result:", JSON.stringify(scan2)?.slice(0, 300));
    if (Array.isArray(scan2)) console.log("scan count:", scan2.length);
  } catch (e) {
    console.error("Scanner error:", e.message);
    console.error("Stack:", e.stack?.split('\n').slice(0, 5).join('\n'));
  }
}
