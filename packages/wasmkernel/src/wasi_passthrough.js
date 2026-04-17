/**
 * Guest-WASI passthrough bridge.
 *
 * NOTE (paged memory): this module still computes physical addresses as
 * `kernel_guest_memory_base() + guestPtr` because it needs to hand raw
 * pointers to the host's wasi shim (node:wasi, etc.), which dereferences
 * them directly against `k.memory.buffer`. That only works in identity
 * mode (hot window == full guest memory); in paged mode, logical pages
 * aren't contiguous at `guest_base + ptr`. For CF Workers, pass custom
 * `wasiBridges` that route through GuestMemory (see defaultWasiBridges
 * for the pattern) rather than wasi_passthrough.
 *
 *
 * Routes the guest wasm's `wasi_snapshot_preview1.*` imports through the
 * caller-supplied `options.wasi.wasiImport` implementation (node:wasi,
 * @bjorn3/browser_wasi_shim, @wasmer/wasi, or anything else that exposes
 * the preview1 import object shape). The caller configures the filesystem
 * via their wasi library's normal API — PreopenDirectory, File,
 * Directory, etc. — and wasmkernel just forwards calls to it with
 * the pointer translation the guest needs.
 *
 * Why this isn't automatic:
 *
 * The wasi shim was initialised with the KERNEL's WebAssembly.Instance,
 * so it reads/writes at offsets into the kernel's linear memory. The
 * GUEST's pointers are offsets into its own memory region, which lives
 * at `kernel_guest_memory_base()..+guest_size` inside the kernel's
 * buffer. Before calling a wasi function on behalf of the guest we add
 * `guest_base` to every pointer-typed argument. The shim then operates
 * on `kernel_memory[guest_base + guest_ptr]` — exactly the bytes the
 * guest meant.
 *
 * Usage:
 *
 *   import { WASI, PreopenDirectory, File, Directory }
 *     from "@bjorn3/browser_wasi_shim";
 *   import { instantiateNapiModule }
 *     from "@alexbruf/wasmkernel/browser";
 *   import { wasiPassthrough }
 *     from "@alexbruf/wasmkernel/wasi-passthrough";
 *
 *   const wasi = new WASI([], [], [
 *     new PreopenDirectory("/", new Map([
 *       ["src", new Directory(new Map([
 *         ["index.html", new File(new TextEncoder().encode("<div class='flex'>..."))],
 *       ]))],
 *     ])),
 *   ]);
 *
 *   const { napiModule } = await instantiateNapiModule(wasmBytes, {
 *     wasi,
 *     wasiBridges: wasiPassthrough({ wasi }),
 *   });
 *
 * The factory form lets us close over the kernel reference after
 * instantiation. Callers can still override individual functions by
 * spreading more handlers on top.
 */

// Which argument slots of each wasi function are pointers into guest
// memory. Slot counts match the kernel's bridge arg convention (one
// slot per wasm parameter, including i64 which is still 1 slot — we
// just have to read the full 8 bytes for it, not 4). Everything else is
// either a scalar i32 or an i64-as-scalar that passes through.
//
// The source of truth for these signatures is
// https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md
const POINTER_ARGS = {
  args_get:                [0, 1],        // argv, argv_buf
  args_sizes_get:          [0, 1],        // argc, argv_buf_size
  environ_get:             [0, 1],        // environ, environ_buf
  environ_sizes_get:       [0, 1],        // environ_count, environ_buf_size
  clock_res_get:           [1],           // resolution
  clock_time_get:          [2],           // time
  fd_advise:               [],            // fd, offset(i64), len(i64), advice
  fd_allocate:             [],            // fd, offset(i64), len(i64)
  fd_close:                [],            // fd
  fd_datasync:             [],            // fd
  fd_fdstat_get:           [1],           // fd, stat_out
  fd_fdstat_set_flags:     [],            // fd, flags
  fd_fdstat_set_rights:    [],            // fd, rights_base(i64), rights_inh(i64)
  fd_filestat_get:         [1],           // fd, stat_out
  fd_filestat_set_size:    [],            // fd, size(i64)
  fd_filestat_set_times:   [],            // fd, atim(i64), mtim(i64), flags
  fd_pread:                [1, 4],        // fd, iovs, iovs_len, offset(i64), nread_out
  fd_prestat_get:          [1],           // fd, prestat_out
  fd_prestat_dir_name:     [1],           // fd, path_out, path_len
  fd_pwrite:               [1, 4],        // fd, iovs, iovs_len, offset(i64), nwritten_out
  fd_read:                 [1, 3],        // fd, iovs, iovs_len, nread_out
  fd_readdir:              [1, 4],        // fd, buf, buf_len, cookie(i64), bufused_out
  fd_renumber:             [],            // fd, to
  fd_seek:                 [3],           // fd, offset(i64), whence, newoffset_out
  fd_sync:                 [],            // fd
  fd_tell:                 [1],           // fd, offset_out
  fd_write:                [1, 3],        // fd, iovs, iovs_len, nwritten_out
  path_create_directory:   [1],           // fd, path, path_len
  path_filestat_get:       [2, 4],        // fd, flags, path, path_len, stat_out
  path_filestat_set_times: [2],           // fd, flags, path, path_len, atim(i64), mtim(i64), flags
  path_link:               [2, 5],        // old_fd, old_flags, old_path, old_len, new_fd, new_path, new_len
  path_open:               [2, 8],        // fd, dirflags, path, path_len, oflags, rights(i64), rights_inh(i64), fdflags, fd_out
  path_readlink:           [1, 3, 5],     // fd, path, path_len, buf, buf_len, bufused_out
  path_remove_directory:   [1],           // fd, path, path_len
  path_rename:             [1, 4],        // old_fd, old_path, old_len, new_fd, new_path, new_len
  path_symlink:            [0, 2],        // old_path, old_len, fd, new_path, new_len
  path_unlink_file:        [1],           // fd, path, path_len
  poll_oneoff:             [0, 1, 3],     // in, out, nsubs, nevents_out
  proc_exit:               [],            // rval
  proc_raise:              [],            // sig
  sched_yield:             [],            // (no args)
  random_get:              [0],           // buf, buf_len
  sock_accept:             [2],           // fd, flags, fd_out
  sock_recv:               [1, 4, 5],     // fd, iovs, iovs_len, flags, rodataflags_out, nread_out
  sock_send:               [1, 4],        // fd, iovs, iovs_len, flags, nwritten_out
  sock_shutdown:           [],            // fd, how
};

// Which arg slots need to be passed as BigInt (i64). Every other arg
// is passed as a Number (read as uint32 from the 8-byte slot). Same
// indices convention as POINTER_ARGS.
const BIGINT_ARGS = {
  fd_advise:               [1, 2],        // offset, len
  fd_allocate:             [1, 2],        // offset, len
  fd_filestat_set_size:    [1],           // size
  fd_filestat_set_times:   [1, 2],        // atim, mtim
  fd_fdstat_set_rights:    [1, 2],        // rights_base, rights_inh
  fd_pread:                [3],           // offset
  fd_pwrite:               [3],           // offset
  fd_readdir:              [3],           // cookie
  fd_seek:                 [1],           // offset
  path_filestat_set_times: [4, 5],        // atim, mtim
  path_open:               [5, 6],        // fs_rights_base, fs_rights_inheriting
};

/**
 * Build a wasiBridges factory that forwards guest WASI calls to the
 * caller-supplied wasi implementation.
 *
 * @param {{ wasi: { wasiImport: Record<string, Function> } }} opts
 * @returns {(kernel: any) => Record<string, (args: number[], argsPtr: number) => bigint>}
 */
export function wasiPassthrough({ wasi }) {
  if (!wasi || !wasi.wasiImport) {
    throw new Error("wasiPassthrough: options.wasi.wasiImport is required");
  }
  const wasiImport = wasi.wasiImport;

  // wasi functions whose pointer args reference iovs/ciovs — arrays of
  // (buf, buf_len) where `buf` is a SECOND-LEVEL pointer that the host
  // wasi shim will read/write through. We have to translate the inner
  // `buf` pointers, not just the outer iovs_ptr, or the shim writes
  // file data into the wrong memory region.
  //
  // [iovsArgIdx, lenArgIdx] — slot index of iovs_ptr, slot index of iovs_len
  const IOV_ARGS = {
    fd_read:   [1, 2],
    fd_write:  [1, 2],
    fd_pread:  [1, 2],
    fd_pwrite: [1, 2],
  };

  return function attach(k) {
    // Persistent scratch buffer for translated iov structs. Allocated
    // once on first use, reused thereafter. Single-threaded host so
    // it's safe to share.
    let scratch = 0;
    let scratchSize = 0;
    function getScratch(needed) {
      if (needed <= scratchSize) return scratch;
      scratch = k.kernel_alloc(needed);
      scratchSize = needed;
      return scratch;
    }

    const bridges = {};
    for (const name of Object.keys(POINTER_ARGS)) {
      // Skip functions where the host wasi shim's behaviour is
      // dangerous to forward verbatim:
      //   poll_oneoff: would actually block on subscriptions; in our
      //     interpreter context that hangs the entire scheduler. The
      //     defaultWasiBridges 0-events stub keeps the guest moving.
      //   proc_exit: throws in node:wasi/browser_wasi_shim, which
      //     would terminate the host process even on a soft exit.
      //   sock_*: not supported in our interpreter.
      if (
        name === "poll_oneoff" ||
        name === "proc_exit" ||
        name === "proc_raise" ||
        name === "sock_accept" ||
        name === "sock_recv" ||
        name === "sock_send" ||
        name === "sock_shutdown"
      ) continue;

      const target = wasiImport[name];
      if (typeof target !== "function") continue;
      const ptrSlots = POINTER_ARGS[name];
      const bigSlots = BIGINT_ARGS[name] || [];
      const ptrSet = new Set(ptrSlots);
      const bigSet = new Set(bigSlots);
      const iovInfo = IOV_ARGS[name];

      bridges[name] = (preParsedArgs, argsPtr) => {
        // Trust the kernel's pre-parsed low-32-bit values for every
        // slot; only upgrade to full-width reads for i64 slots that
        // the wasi function actually cares about.
        const gbase = k.kernel_guest_memory_base();
        const n = preParsedArgs.length;
        const out = new Array(n);
        for (let i = 0; i < n; i++) {
          if (bigSet.has(i)) {
            out[i] = new DataView(k.memory.buffer).getBigUint64(
              argsPtr + i * 8, true,
            );
          } else if (ptrSet.has(i)) {
            out[i] = gbase + preParsedArgs[i];
          } else {
            out[i] = preParsedArgs[i];
          }
        }

        // Iov fixup: rewrite the iov array's inner buf pointers from
        // guest-space to kernel-space and pass a temp pointer to wasi.
        if (iovInfo) {
          const [iovsIdx, lenIdx] = iovInfo;
          const guestIovs = preParsedArgs[iovsIdx];
          const iovCount = preParsedArgs[lenIdx];
          const tempPtr = getScratch(iovCount * 8);
          // Each iov is { buf: u32, buf_len: u32 } = 8 bytes.
          const dvSrc = new DataView(k.memory.buffer);
          const dvDst = new DataView(k.memory.buffer);
          for (let j = 0; j < iovCount; j++) {
            const gBuf = dvSrc.getUint32(gbase + guestIovs + j * 8, true);
            const gLen = dvSrc.getUint32(gbase + guestIovs + j * 8 + 4, true);
            // Translate buf pointer; len is just a count.
            dvDst.setUint32(tempPtr + j * 8, gbase + gBuf, true);
            dvDst.setUint32(tempPtr + j * 8 + 4, gLen, true);
          }
          out[iovsIdx] = tempPtr; // override the outer iovs_ptr to the temp
        }

        const r = target.apply(wasiImport, out);
        return typeof r === "bigint" ? r : BigInt(r | 0);
      };
    }
    return bridges;
  };
}
