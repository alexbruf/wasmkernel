# CMake toolchain file for wasm32-wasi cross-compilation using wasi-sdk
#
# Usage:
#   cmake -B build -DCMAKE_TOOLCHAIN_FILE=cmake/wasi-sdk.cmake

if (NOT DEFINED WASI_SDK_PATH)
    if (DEFINED ENV{WASI_SDK_PATH})
        set(WASI_SDK_PATH $ENV{WASI_SDK_PATH})
    elseif (EXISTS /opt/wasi-sdk)
        set(WASI_SDK_PATH /opt/wasi-sdk)
    elseif (EXISTS /tmp/wasi-sdk-25.0-arm64-macos)
        set(WASI_SDK_PATH /tmp/wasi-sdk-25.0-arm64-macos)
    else ()
        message(FATAL_ERROR "WASI SDK not found. Set WASI_SDK_PATH.")
    endif ()
endif ()

set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_VERSION 1)
set(CMAKE_SYSTEM_PROCESSOR wasm32)

set(CMAKE_C_COMPILER ${WASI_SDK_PATH}/bin/clang)
set(CMAKE_CXX_COMPILER ${WASI_SDK_PATH}/bin/clang++)
set(CMAKE_AR ${WASI_SDK_PATH}/bin/ar CACHE FILEPATH "ar")
set(CMAKE_RANLIB ${WASI_SDK_PATH}/bin/ranlib CACHE FILEPATH "ranlib")

set(CMAKE_SYSROOT ${WASI_SDK_PATH}/share/wasi-sysroot)

set(CMAKE_C_FLAGS_INIT "--target=wasm32-wasi -fno-exceptions")
set(CMAKE_CXX_FLAGS_INIT "--target=wasm32-wasi -fno-exceptions")

set(CMAKE_EXE_LINKER_FLAGS_INIT "-Wl,--no-entry -mexec-model=reactor")

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

# Disable shared libraries — wasm32 only supports static
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(CMAKE_EXECUTABLE_SUFFIX ".wasm")
