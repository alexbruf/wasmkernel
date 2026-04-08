#!/bin/bash
# Download and unpack wasi-sdk for the current platform.
#
# Idempotent — does nothing if WASI_SDK_PATH already points at a valid SDK.
# Echoes the resolved WASI_SDK_PATH on the last line so callers can do
# `WASI_SDK_PATH=$(./scripts/install-wasi-sdk.sh | tail -1)`.
set -e

WASI_VERSION="${WASI_VERSION:-25}"
WASI_VERSION_FULL="${WASI_VERSION_FULL:-${WASI_VERSION}.0}"

uname_s=$(uname -s)
uname_m=$(uname -m)
case "$uname_s-$uname_m" in
    Linux-x86_64)   archive="wasi-sdk-${WASI_VERSION_FULL}-x86_64-linux" ;;
    Linux-aarch64)  archive="wasi-sdk-${WASI_VERSION_FULL}-arm64-linux" ;;
    Darwin-arm64)   archive="wasi-sdk-${WASI_VERSION_FULL}-arm64-macos" ;;
    Darwin-x86_64)  archive="wasi-sdk-${WASI_VERSION_FULL}-x86_64-macos" ;;
    *) echo "unsupported platform: $uname_s-$uname_m" >&2; exit 1 ;;
esac

target_dir="${WASI_SDK_INSTALL_DIR:-/tmp}/${archive}"

# Already installed?
if [ -x "${target_dir}/bin/clang" ]; then
    echo "wasi-sdk already installed at ${target_dir}" >&2
    echo "${target_dir}"
    exit 0
fi

url="https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_VERSION}/${archive}.tar.gz"
echo "downloading ${url}" >&2
mkdir -p "${WASI_SDK_INSTALL_DIR:-/tmp}"
curl -fsSL "${url}" | tar -xz -C "${WASI_SDK_INSTALL_DIR:-/tmp}"

if [ ! -x "${target_dir}/bin/clang" ]; then
    echo "wasi-sdk install failed: ${target_dir}/bin/clang missing" >&2
    exit 1
fi

echo "installed wasi-sdk at ${target_dir}" >&2
echo "${target_dir}"
