/**
 * Default WASI preview1 bridge handlers for the guest wasm running inside
 * wasmkernel. These are NOT the imports the kernel itself uses — those
 * come from the `wasi` option the caller passes to instantiateNapiModule
 * and operate on the kernel's linear memory.
 *
 * These handlers satisfy the GUEST's wasi_snapshot_preview1 imports,
 * which use guest-space pointers. The guest runs inside the kernel's
 * interpreter, so every pointer argument has to be translated through
 * `kernel_guest_memory_base()` before reading/writing the actual bytes.
 *
 * The default VFS is EMPTY — any path_open returns ENOENT, most fd_*
 * calls return BADF. This turns "Rust loops forever on uninitialized
 * output pointer" into "Rust throws ENOENT immediately", which is the
 * correct failure mode for addons run without a filesystem.
 *
 * Callers that need real file access override any of these via the
 * `wasiBridges` option on instantiateNapiModule.
 *
 *   const { napiModule } = await instantiateNapiModule(guestBytes, {
 *     wasi,
 *     wasiBridges: {
 *       path_open(args) { ... return 0n; },
 *       fd_read(args) { ... return 0n; },
 *     },
 *   });
 */

// WASI errno constants we actually return.
export const WASI_ESUCCESS = 0n;
export const WASI_EBADF = 8n;     // bad file descriptor
export const WASI_EINVAL = 28n;   // invalid argument
export const WASI_ENOENT = 44n;   // no such file or directory
export const WASI_ENOSYS = 52n;   // function not implemented
export const WASI_ENOTDIR = 54n;  // not a directory

// Preopen fd used for "/".
const PREOPEN_FD = 3;

/**
 * Build the default bridge handlers. Takes a getter for the kernel
 * exports so we can access memory + guest_memory_base lazily (the memory
 * may grow between instantiation and first call, so we always re-read
 * the buffer).
 */
export function defaultWasiBridges(getKernel) {
  // Helpers that always read the current buffer (memory.grow invalidates
  // previous DataView/Uint8Array instances).
  const mem = () => new Uint8Array(getKernel().memory.buffer);
  const dv = () => new DataView(getKernel().memory.buffer);
  const base = () => getKernel().kernel_guest_memory_base();

  function writeU32(ptr, val) { dv().setUint32(base() + ptr, val >>> 0, true); }
  function writeU64(ptr, val) { dv().setBigUint64(base() + ptr, BigInt(val), true); }
  function writeBytes(ptr, bytes) { mem().set(bytes, base() + ptr); }

  // --- fd_write: route fd 1 → console.log, fd 2 → console.error ---
  const stdoutLines = ["", ""]; // index 0 unused, 1 = stdout buffer, 2 = stderr
  function fd_write(args) {
    const [fd, iovsPtr, iovsLen, nwrittenPtr] = args;
    if (fd !== 1 && fd !== 2) {
      writeU32(nwrittenPtr, 0);
      return WASI_EBADF;
    }
    let total = 0;
    let text = "";
    const gBase = base();
    const d = dv();
    const m = mem();
    for (let i = 0; i < iovsLen; i++) {
      const p = d.getUint32(gBase + iovsPtr + i * 8, true);
      const len = d.getUint32(gBase + iovsPtr + i * 8 + 4, true);
      text += new TextDecoder().decode(m.slice(gBase + p, gBase + p + len));
      total += len;
    }
    writeU32(nwrittenPtr, total);
    // Line-buffered console output.
    const buf = stdoutLines[fd] + text;
    const lines = buf.split("\n");
    stdoutLines[fd] = lines.pop() ?? "";
    const sink = fd === 1 ? console.log : console.error;
    for (const line of lines) sink(`[guest] ${line}`);
    return WASI_ESUCCESS;
  }

  // --- clock_time_get: real wall clock / monotonic ---
  function clock_time_get(args) {
    // args: [clock_id, precision_lo, precision_hi, time_out_ptr]
    // clock_id: 0 = REALTIME, 1 = MONOTONIC, 2 = PROCESS_CPUTIME, 3 = THREAD_CPUTIME
    const [clockId, , , outPtr] = args;
    let ns;
    if (clockId === 0) {
      ns = BigInt(Date.now()) * 1_000_000n;
    } else {
      ns = BigInt(Math.round(
        (typeof performance !== "undefined" ? performance.now() : Date.now()) * 1e6
      ));
    }
    writeU64(outPtr, ns);
    return WASI_ESUCCESS;
  }

  // --- clock_res_get: 1ns ---
  function clock_res_get(args) {
    const [, outPtr] = args;
    writeU64(outPtr, 1n);
    return WASI_ESUCCESS;
  }

  // --- Preopen: fd 3 = "/" ---
  function fd_prestat_get(args) {
    const [fd, bufPtr] = args;
    if (fd === PREOPEN_FD) {
      // prestat: tag (u8) + 3 pad + name_len (u32)
      // tag 0 = __WASI_PREOPENTYPE_DIR
      const buf = new Uint8Array(8);
      buf[0] = 0;
      new DataView(buf.buffer).setUint32(4, 1, true); // name length of "/"
      writeBytes(bufPtr, buf);
      return WASI_ESUCCESS;
    }
    return WASI_EBADF;
  }
  function fd_prestat_dir_name(args) {
    const [fd, pathPtr, pathLen] = args;
    if (fd === PREOPEN_FD && pathLen >= 1) {
      writeBytes(pathPtr, new TextEncoder().encode("/"));
      return WASI_ESUCCESS;
    }
    return WASI_EBADF;
  }

  // --- Empty VFS: every file lookup returns ENOENT ---
  function path_open() {
    // Empty VFS: every file lookup returns ENOENT.
    // IMPORTANT: if we return non-zero, we MUST NOT write fd_out_ptr
    // (the guest treats the out ptr as uninitialised on error paths).
    return WASI_ENOENT;
  }
  function path_filestat_get() { return WASI_ENOENT; }
  function path_readlink(args) {
    const [, , , , , , bufusedPtr] = args;
    writeU32(bufusedPtr, 0);
    return WASI_EINVAL;
  }
  function path_create_directory() { return WASI_ENOENT; }
  function path_remove_directory() { return WASI_ENOENT; }
  function path_unlink_file() { return WASI_ENOENT; }
  function path_rename() { return WASI_ENOENT; }
  function path_symlink() { return WASI_ENOENT; }
  function path_link() { return WASI_ENOENT; }

  // --- fd_* on unknown fds: BADF ---
  function fd_filestat_get(args) {
    const [fd] = args;
    if (fd === PREOPEN_FD || fd === 0 || fd === 1 || fd === 2) {
      // Minimal filestat for stdio / preopen — we only guarantee filetype.
      const [, bufPtr] = args;
      const buf = new Uint8Array(64);
      buf[16] = fd === PREOPEN_FD ? 3 : 2; // 3=dir, 2=character_device
      writeBytes(bufPtr, buf);
      return WASI_ESUCCESS;
    }
    return WASI_EBADF;
  }
  function fd_fdstat_get(args) {
    const [fd, bufPtr] = args;
    if (fd === PREOPEN_FD || fd === 0 || fd === 1 || fd === 2) {
      // fdstat: fs_filetype(u8) + 1pad + fs_flags(u16) + 4pad + fs_rights_base(u64) + fs_rights_inheriting(u64) = 24 bytes
      const buf = new Uint8Array(24);
      buf[0] = fd === PREOPEN_FD ? 3 : 2;
      writeBytes(bufPtr, buf);
      return WASI_ESUCCESS;
    }
    return WASI_EBADF;
  }
  function fd_fdstat_set_flags() { return WASI_ESUCCESS; }
  function fd_read(args) {
    const [, , , nreadPtr] = args;
    writeU32(nreadPtr, 0);
    return WASI_EBADF;
  }
  function fd_pread(args) {
    const [, , , , nreadPtr] = args;
    writeU32(nreadPtr, 0);
    return WASI_EBADF;
  }
  function fd_readdir(args) {
    const [, , , , bufusedPtr] = args;
    writeU32(bufusedPtr, 0);
    return WASI_EBADF;
  }
  function fd_close() { return WASI_ESUCCESS; }
  function fd_seek(args) {
    const [, , , , newoffsetPtr] = args;
    writeU64(newoffsetPtr, 0n);
    return WASI_EBADF;
  }
  function fd_tell(args) {
    const [, offsetPtr] = args;
    writeU64(offsetPtr, 0n);
    return WASI_EBADF;
  }
  function fd_sync() { return WASI_ESUCCESS; }
  function fd_datasync() { return WASI_ESUCCESS; }
  function fd_advise() { return WASI_ESUCCESS; }
  function fd_allocate() { return WASI_ESUCCESS; }
  function fd_renumber() { return WASI_EBADF; }

  // --- environ / args: empty ---
  function environ_get() {
    // Empty environ — nothing to write.
    return WASI_ESUCCESS;
  }
  function environ_sizes_get(args) {
    const [countPtr, bufSizePtr] = args;
    writeU32(countPtr, 0);
    writeU32(bufSizePtr, 0);
    return WASI_ESUCCESS;
  }
  function args_get() { return WASI_ESUCCESS; }
  function args_sizes_get(args) {
    const [countPtr, bufSizePtr] = args;
    writeU32(countPtr, 0);
    writeU32(bufSizePtr, 0);
    return WASI_ESUCCESS;
  }

  // --- random_get: crypto ---
  function random_get(args) {
    const [bufPtr, bufLen] = args;
    const gBase = base();
    const m = mem();
    if (typeof globalThis.crypto?.getRandomValues === "function") {
      const chunk = new Uint8Array(Math.min(bufLen, 65536));
      let remaining = bufLen, off = 0;
      while (remaining > 0) {
        const n = Math.min(chunk.length, remaining);
        globalThis.crypto.getRandomValues(chunk.subarray(0, n));
        m.set(chunk.subarray(0, n), gBase + bufPtr + off);
        off += n; remaining -= n;
      }
    } else {
      for (let i = 0; i < bufLen; i++) m[gBase + bufPtr + i] = (Math.random() * 256) | 0;
    }
    return WASI_ESUCCESS;
  }

  // --- proc_exit: raise so the scheduler stops the guest ---
  function proc_exit(args) {
    const [code] = args;
    const err = new Error(`proc_exit(${code})`);
    err.exitCode = code;
    throw err;
  }
  function proc_raise() { return WASI_ESUCCESS; }

  // --- poll_oneoff: return zero events ---
  function poll_oneoff(args) {
    const [, , , neventsPtr] = args;
    writeU32(neventsPtr, 0);
    return WASI_ESUCCESS;
  }

  // --- sched_yield: no-op ---
  function sched_yield() { return WASI_ESUCCESS; }

  // --- sock_*: not implemented ---
  function sock_accept() { return WASI_ENOSYS; }
  function sock_recv() { return WASI_ENOSYS; }
  function sock_send() { return WASI_ENOSYS; }
  function sock_shutdown() { return WASI_ENOSYS; }

  return {
    args_get, args_sizes_get,
    environ_get, environ_sizes_get,
    clock_res_get, clock_time_get,
    fd_advise, fd_allocate, fd_close, fd_datasync, fd_fdstat_get,
    fd_fdstat_set_flags, fd_filestat_get, fd_pread, fd_prestat_get,
    fd_prestat_dir_name, fd_read, fd_readdir, fd_renumber, fd_seek,
    fd_sync, fd_tell, fd_write,
    path_create_directory, path_filestat_get, fd_filestat_set_size: () => WASI_ESUCCESS,
    fd_filestat_set_times: () => WASI_ESUCCESS,
    path_filestat_set_times: () => WASI_ESUCCESS,
    path_link, path_open, path_readlink, path_remove_directory,
    path_rename, path_symlink, path_unlink_file,
    poll_oneoff, proc_exit, proc_raise, sched_yield,
    random_get,
    sock_accept, sock_recv, sock_send, sock_shutdown,
  };
}
