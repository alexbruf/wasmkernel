/**
 * Node.js Node-API compatibility tests.
 * Adapted from Node.js test/js-native-api/ test suite patterns.
 * Tests the same napi functions used by the official Node.js tests.
 *
 * Each test registers functions that the host JS harness calls.
 */
#define NAPI_EXTERN __attribute__((__import_module__("env")))
#include <js_native_api.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

#define NAPI_CALL(env, call)                                          \
  do {                                                                \
    napi_status _s = (call);                                          \
    if (_s != napi_ok) {                                              \
      napi_throw_error(env, NULL, "NAPI call failed: " #call);       \
      return NULL;                                                    \
    }                                                                 \
  } while (0)

/* ===== Adapted from test/js-native-api/2_function_arguments ===== */
/* Add two numbers passed as arguments */
static napi_value Add(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 2) {
    napi_throw_error(env, NULL, "Expected 2 arguments");
    return NULL;
  }

  /* Read as strings and convert (since we don't have napi_get_value_double through bridge) */
  napi_value a_str, b_str;
  NAPI_CALL(env, napi_coerce_to_string(env, argv[0], &a_str));
  NAPI_CALL(env, napi_coerce_to_string(env, argv[1], &b_str));

  char buf_a[64], buf_b[64];
  size_t len;
  NAPI_CALL(env, napi_get_value_string_utf8(env, a_str, buf_a, sizeof(buf_a), &len));
  NAPI_CALL(env, napi_get_value_string_utf8(env, b_str, buf_b, sizeof(buf_b), &len));

  double result = atof(buf_a) + atof(buf_b);

  /* Return as int64 (close enough for integer tests) */
  napi_value ret;
  NAPI_CALL(env, napi_create_int64(env, (int64_t)result, &ret));
  return ret;
}

/* ===== Adapted from test/js-native-api/3_callbacks ===== */
/* Call a JS callback with specified args */
static napi_value RunCallback(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  napi_valuetype t;
  NAPI_CALL(env, napi_typeof(env, argv[0], &t));
  if (t != napi_function) {
    napi_throw_error(env, NULL, "First argument must be a function");
    return NULL;
  }

  napi_value global;
  NAPI_CALL(env, napi_get_global(env, &global));

  /* If second arg provided, pass it; otherwise call with no args */
  napi_value result;
  if (argc >= 2) {
    NAPI_CALL(env, napi_call_function(env, global, argv[0], 1, &argv[1], &result));
  } else {
    NAPI_CALL(env, napi_call_function(env, global, argv[0], 0, NULL, &result));
  }
  return result;
}

/* ===== Adapted from test/js-native-api/4_object_factory ===== */
/* Create an object with a 'msg' property from the first arg */
static napi_value CreateObject(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  napi_value obj;
  NAPI_CALL(env, napi_create_object(env, &obj));
  NAPI_CALL(env, napi_set_named_property(env, obj, "msg", argv[0]));
  return obj;
}

/* ===== Adapted from test/js-native-api/5_function_factory ===== */
/* Inner function returned by the factory */
static napi_value InnerFunction(napi_env env, napi_callback_info info) {
  napi_value str;
  NAPI_CALL(env, napi_create_string_utf8(env, "hello from inner", -1, &str));
  return str;
}

/* Create and return a new function */
static napi_value CreateFunction(napi_env env, napi_callback_info info) {
  napi_value fn;
  NAPI_CALL(env, napi_create_function(env, "theFunction", -1, InnerFunction, NULL, &fn));
  return fn;
}

/* ===== Adapted from test/js-native-api/test_string ===== */
/* Concatenate two strings */
static napi_value ConcatStrings(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  char buf1[256], buf2[256];
  size_t len1, len2;
  NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], buf1, sizeof(buf1), &len1));
  NAPI_CALL(env, napi_get_value_string_utf8(env, argv[1], buf2, sizeof(buf2), &len2));

  char result[512];
  memcpy(result, buf1, len1);
  memcpy(result + len1, buf2, len2);
  result[len1 + len2] = 0;

  napi_value ret;
  NAPI_CALL(env, napi_create_string_utf8(env, result, len1 + len2, &ret));
  return ret;
}

/* Get string length */
static napi_value StringLength(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  size_t len;
  NAPI_CALL(env, napi_get_value_string_utf8(env, argv[0], NULL, 0, &len));

  napi_value ret;
  NAPI_CALL(env, napi_create_int64(env, (int64_t)len, &ret));
  return ret;
}

/* ===== Adapted from test/js-native-api/test_error ===== */
/* Check if value is an Error */
static napi_value CheckError(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  bool is_error;
  NAPI_CALL(env, napi_is_error(env, argv[0], &is_error));

  napi_value result;
  NAPI_CALL(env, napi_create_string_utf8(env, is_error ? "true" : "false", -1, &result));
  return result;
}

/* Create an Error with code and message */
static napi_value MakeError(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  napi_value error;
  NAPI_CALL(env, napi_create_error(env, argv[0], argv[1], &error));
  return error;
}

/* ===== Adapted from test/js-native-api/test_array ===== */
/* Create array from arguments */
static napi_value ArrayFromArgs(napi_env env, napi_callback_info info) {
  size_t argc = 16;
  napi_value argv[16];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  napi_value arr;
  NAPI_CALL(env, napi_create_array_with_length(env, argc, &arr));

  for (size_t i = 0; i < argc; i++) {
    NAPI_CALL(env, napi_set_element(env, arr, i, argv[i]));
  }
  return arr;
}

/* Get element from array at index */
static napi_value ArrayGet(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  /* argv[0] = array, argv[1] = index (as string to convert) */
  napi_value idx_str;
  NAPI_CALL(env, napi_coerce_to_string(env, argv[1], &idx_str));
  char ibuf[16];
  size_t ilen;
  NAPI_CALL(env, napi_get_value_string_utf8(env, idx_str, ibuf, sizeof(ibuf), &ilen));
  uint32_t idx = (uint32_t)atoi(ibuf);

  napi_value result;
  NAPI_CALL(env, napi_get_element(env, argv[0], idx, &result));
  return result;
}

/* ===== Adapted from test/js-native-api/test_object ===== */
/* Get named property from object */
static napi_value ObjGetNamed(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  char key[256];
  size_t klen;
  NAPI_CALL(env, napi_get_value_string_utf8(env, argv[1], key, sizeof(key), &klen));

  napi_value result;
  NAPI_CALL(env, napi_get_named_property(env, argv[0], key, &result));
  return result;
}

/* Set named property on object */
static napi_value ObjSetNamed(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  char key[256];
  size_t klen;
  NAPI_CALL(env, napi_get_value_string_utf8(env, argv[1], key, sizeof(key), &klen));

  NAPI_CALL(env, napi_set_named_property(env, argv[0], key, argv[2]));

  napi_value undef;
  NAPI_CALL(env, napi_get_undefined(env, &undef));
  return undef;
}

/* Get typeof value */
static napi_value GetTypeof(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  napi_valuetype t;
  NAPI_CALL(env, napi_typeof(env, argv[0], &t));

  const char *names[] = {
    "undefined", "null", "boolean", "number",
    "string", "symbol", "object", "function",
    "external", "bigint"
  };

  napi_value ret;
  NAPI_CALL(env, napi_create_string_utf8(env, names[t], -1, &ret));
  return ret;
}

/* ===== Adapted from test/js-native-api/test_reference ===== */
static napi_ref stored_ref = NULL;

static napi_value StoreRef(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (stored_ref) {
    NAPI_CALL(env, napi_delete_reference(env, stored_ref));
    stored_ref = NULL;
  }

  NAPI_CALL(env, napi_create_reference(env, argv[0], 1, &stored_ref));

  napi_value undef;
  NAPI_CALL(env, napi_get_undefined(env, &undef));
  return undef;
}

static napi_value LoadRef(napi_env env, napi_callback_info info) {
  if (!stored_ref) {
    napi_throw_error(env, NULL, "No stored reference");
    return NULL;
  }

  napi_value result;
  NAPI_CALL(env, napi_get_reference_value(env, stored_ref, &result));
  return result;
}

static napi_value DeleteRef(napi_env env, napi_callback_info info) {
  if (stored_ref) {
    NAPI_CALL(env, napi_delete_reference(env, stored_ref));
    stored_ref = NULL;
  }

  napi_value undef;
  NAPI_CALL(env, napi_get_undefined(env, &undef));
  return undef;
}

/* ===== Module registration ===== */
napi_value napi_register_wasm_v1(napi_env env, napi_value exports) {
  napi_value fn;

#define EXPORT_FN(name, cb)                                    \
  napi_create_function(env, name, -1, cb, NULL, &fn);          \
  napi_set_named_property(env, exports, name, fn)

  /* test/js-native-api/2_function_arguments */
  EXPORT_FN("add", Add);

  /* test/js-native-api/3_callbacks */
  EXPORT_FN("runCallback", RunCallback);

  /* test/js-native-api/4_object_factory */
  EXPORT_FN("createObject", CreateObject);

  /* test/js-native-api/5_function_factory */
  EXPORT_FN("createFunction", CreateFunction);

  /* test/js-native-api/test_string */
  EXPORT_FN("concatStrings", ConcatStrings);
  EXPORT_FN("stringLength", StringLength);

  /* test/js-native-api/test_error */
  EXPORT_FN("checkError", CheckError);
  EXPORT_FN("makeError", MakeError);

  /* test/js-native-api/test_array */
  EXPORT_FN("arrayFromArgs", ArrayFromArgs);
  EXPORT_FN("arrayGet", ArrayGet);

  /* test/js-native-api/test_object */
  EXPORT_FN("objGetNamed", ObjGetNamed);
  EXPORT_FN("objSetNamed", ObjSetNamed);
  EXPORT_FN("getTypeof", GetTypeof);

  /* test/js-native-api/test_reference */
  EXPORT_FN("storeRef", StoreRef);
  EXPORT_FN("loadRef", LoadRef);
  EXPORT_FN("deleteRef", DeleteRef);

  return exports;
}
