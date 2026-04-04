# Copyright (C) 2024 WasmKernel contributors.
# SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception

set (PLATFORM_SHARED_DIR ${CMAKE_CURRENT_LIST_DIR})

add_definitions(-DBH_PLATFORM_WASI)

include_directories(${PLATFORM_SHARED_DIR})
include_directories(${PLATFORM_SHARED_DIR}/../../deps/wamr/core/shared/platform/include)

file (GLOB_RECURSE source_all ${PLATFORM_SHARED_DIR}/*.c)

set (PLATFORM_SHARED_SOURCE ${source_all})

file (GLOB header ${PLATFORM_SHARED_DIR}/../../deps/wamr/core/shared/platform/include/*.h)
LIST (APPEND RUNTIME_LIB_HEADER_LIST ${header})
