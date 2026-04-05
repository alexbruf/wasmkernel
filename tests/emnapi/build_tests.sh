#!/bin/bash
# Compile emnapi test programs for WasmKernel
set -e

CC="/tmp/wasi-sdk-25.0-arm64-macos/bin/clang"
EMNAPI_INC="/tmp/emnapi-repo/packages/emnapi/include/node"
EMNAPI_TEST="/tmp/emnapi-repo/packages/test"
SHIM_DIR="$(dirname "$0")"
OUT_DIR="$SHIM_DIR/wasm"

CFLAGS="--target=wasm32-wasi -O2 -DNAPI_EXTERN=__attribute__((__import_module__(\"env\"))) -I$EMNAPI_INC -I$EMNAPI_TEST -I$SHIM_DIR -mexec-model=reactor -Wl,--allow-undefined -Wl,--export=napi_register_wasm_v1 -Wl,--export-table"

compile_test() {
  local name=$1
  shift
  local sources="$@"
  echo -n "  $name... "
  if $CC $CFLAGS $sources -o "$OUT_DIR/$name.wasm" 2>/tmp/emnapi-build-err.txt; then
    echo "OK"
  else
    echo "FAIL"
    cat /tmp/emnapi-build-err.txt | head -5
  fi
}

echo "Building emnapi tests..."

# READY tests (0 missing napi functions)
compile_test objfac "$EMNAPI_TEST/objfac/binding.c"
compile_test fnfac "$EMNAPI_TEST/fnfac/binding.c"
compile_test function "$EMNAPI_TEST/function/binding.c"

# EASY tests (need napi_define_properties which is now in our runtime)
compile_test hello "$EMNAPI_TEST/hello/binding.c"
compile_test arg "$EMNAPI_TEST/arg/binding.c"
compile_test callback "$EMNAPI_TEST/callback/binding.c"
compile_test number "$EMNAPI_TEST/number/binding.c" "$EMNAPI_TEST/number/test_null.c"
compile_test error "$EMNAPI_TEST/error/binding.c"
compile_test array "$EMNAPI_TEST/array/binding.c"
compile_test string "$EMNAPI_TEST/string/binding.c" "$EMNAPI_TEST/string/test_null.c"
compile_test general "$EMNAPI_TEST/general/binding.c"
compile_test conversion "$EMNAPI_TEST/conversion/test_conversions.c" "$EMNAPI_TEST/conversion/test_null.c"
compile_test constructor "$EMNAPI_TEST/constructor/binding.c" "$EMNAPI_TEST/constructor/test_null.c"
compile_test property "$EMNAPI_TEST/property/binding.c"
compile_test exception "$EMNAPI_TEST/exception/binding.c"
compile_test ref "$EMNAPI_TEST/ref/binding.c"
compile_test object "$EMNAPI_TEST/object/test_object.c"
compile_test symbol "$EMNAPI_TEST/symbol/binding.c"
compile_test promise "$EMNAPI_TEST/promise/binding.c"
compile_test scope "$EMNAPI_TEST/scope/binding.c"
compile_test newtarget "$EMNAPI_TEST/newtarget/binding.c"
compile_test version "$EMNAPI_TEST/version/binding.c"
compile_test env "$EMNAPI_TEST/env/binding.c"
compile_test typedarray "$EMNAPI_TEST/typedarray/binding.c"
compile_test dataview "$EMNAPI_TEST/dataview/binding.c"
compile_test date "$EMNAPI_TEST/date/binding.c"
compile_test cbinfo "$EMNAPI_TEST/cbinfo/binding.c"
compile_test ref_double_free "$EMNAPI_TEST/ref_double_free/binding.c"
compile_test bigint "$EMNAPI_TEST/bigint/binding.c"

echo "Done!"
ls -la "$OUT_DIR"/*.wasm 2>/dev/null | wc -l | xargs echo "Compiled:"
