/* Entry point shim for WasmKernel — maps Init() to napi_register_wasm_v1() */
#ifndef WASMKERNEL_ENTRY_POINT_H_
#define WASMKERNEL_ENTRY_POINT_H_

#define NAPI_EXTERN __attribute__((__import_module__("env")))
#include <js_native_api.h>

#ifdef __cplusplus
extern "C" {
#endif

napi_value Init(napi_env env, napi_value exports);

__attribute__((export_name("napi_register_wasm_v1")))
napi_value napi_register_wasm_v1(napi_env env, napi_value exports) {
  return Init(env, exports);
}

#ifdef __cplusplus
}
#endif

/* Suppress NAPI_MODULE macro — we use napi_register_wasm_v1 instead */
#define NAPI_MODULE(modname, regfunc)

#endif
