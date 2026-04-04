/*
 * Copyright (C) 2024 WasmKernel contributors.
 * SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
 */

#ifndef _PLATFORM_INTERNAL_H
#define _PLATFORM_INTERNAL_H

#include <inttypes.h>
#include <stdbool.h>
#include <assert.h>
#include <time.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <stdarg.h>
#include <ctype.h>
#include <limits.h>
#include <errno.h>
#include <stdint.h>

/*
 * Include wasi-libc's own WASI types and suppress WAMR's duplicate definitions.
 * WAMR's platform_wasi_types.h defines the same types as wasi-libc's <wasi/api.h>,
 * causing redefinition errors when the host is itself a WASI target.
 */
#include <wasi/api.h>
#define _PLATFORM_WASI_TYPES_H

#ifdef __cplusplus
extern "C" {
#endif

#ifndef BH_PLATFORM_WASI
#define BH_PLATFORM_WASI
#endif

/* Single-threaded cooperative environment — all threading types are stubs */
typedef int korp_tid;
typedef int korp_mutex;
typedef int korp_cond;
typedef int korp_thread;
typedef int korp_rwlock;
typedef int korp_sem;

#define OS_THREAD_MUTEX_INITIALIZER 0

/* No thread-local storage in wasm32-wasi */
#define os_thread_local_attribute

/* Socket type stub */
#define bh_socket_t int

/* Stack config */
#define BH_APPLET_PRESERVED_STACK_SIZE (32 * 1024)
#define BH_THREAD_DEFAULT_PRIORITY 0

/* No hardware bound check in wasm */
#undef OS_ENABLE_HW_BOUND_CHECK

/* Disable wakeup blocking op */
#undef OS_ENABLE_WAKEUP_BLOCKING_OP

/* Page size — WASM linear memory pages are 64KB */
static inline int
os_getpagesize(void)
{
    return 65536;
}

/* File handle types */
typedef int os_file_handle;
typedef void *os_dir_stream;
typedef int os_raw_file_handle;

static inline os_file_handle
os_get_invalid_handle(void)
{
    return -1;
}

/* No dlfcn in WASI */
#define BH_HAS_DLFCN 0

#ifdef __cplusplus
}
#endif

#endif /* end of _PLATFORM_INTERNAL_H */
