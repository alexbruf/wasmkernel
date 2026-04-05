/**
 * N-API compliance test program.
 * Compiled to wasm32-wasi, loaded through WasmKernel.
 * Registers napi functions that the host JS test harness calls.
 *
 * Tests: objects, strings, functions, classes, callbacks, errors,
 *        arrays, references, wrap/unwrap, typeof.
 */
/* Override import module to "env" for WasmKernel bridge */
#define NAPI_EXTERN __attribute__((__import_module__("env")))
#include <js_native_api.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

#define NAPI_CALL(call)                                       \
  do {                                                        \
    napi_status status = (call);                              \
    if (status != napi_ok) {                                  \
      fprintf(stderr, "NAPI_CALL failed: %s:%d status=%d\n", \
              __FILE__, __LINE__, status);                    \
      return NULL;                                            \
    }                                                         \
  } while (0)

/* ===== Test: create and return an object with properties ===== */
static napi_value test_object(napi_env env, napi_callback_info info) {
  napi_value obj;
  NAPI_CALL(napi_create_object(env, &obj));

  napi_value str;
  NAPI_CALL(napi_create_string_utf8(env, "hello", 5, &str));
  NAPI_CALL(napi_set_named_property(env, obj, "greeting", str));

  napi_value num;
  NAPI_CALL(napi_create_int64(env, 42, &num));
  NAPI_CALL(napi_set_named_property(env, obj, "answer", num));

  return obj;
}

/* ===== Test: string round-trip ===== */
static napi_value test_string(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  /* Read the input string */
  char buf[256];
  size_t len;
  NAPI_CALL(napi_get_value_string_utf8(env, argv[0], buf, sizeof(buf), &len));

  /* Create reversed string */
  char rev[256];
  for (size_t i = 0; i < len; i++) {
    rev[i] = buf[len - 1 - i];
  }
  rev[len] = 0;

  napi_value result;
  NAPI_CALL(napi_create_string_utf8(env, rev, len, &result));
  return result;
}

/* ===== Test: call a JS callback ===== */
static napi_value test_callback(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  /* argv[0] = callback function, argv[1] = argument to pass */
  napi_value global;
  NAPI_CALL(napi_get_global(env, &global));

  napi_value result;
  NAPI_CALL(napi_call_function(env, global, argv[0], 1, &argv[1], &result));
  return result;
}

/* ===== Test: typeof ===== */
static napi_value test_typeof(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  napi_valuetype vtype;
  NAPI_CALL(napi_typeof(env, argv[0], &vtype));

  const char *names[] = {
    "undefined", "null", "boolean", "number",
    "string", "symbol", "object", "function",
    "external", "bigint"
  };

  napi_value result;
  const char *name = (vtype >= 0 && vtype <= 9) ? names[vtype] : "unknown";
  NAPI_CALL(napi_create_string_utf8(env, name, strlen(name), &result));
  return result;
}

/* ===== Test: arrays ===== */
static napi_value test_array(napi_env env, napi_callback_info info) {
  /* Create array [10, 20, 30] */
  napi_value arr;
  NAPI_CALL(napi_create_array_with_length(env, 3, &arr));

  for (int i = 0; i < 3; i++) {
    napi_value val;
    NAPI_CALL(napi_create_int64(env, (i + 1) * 10, &val));
    NAPI_CALL(napi_set_element(env, arr, i, val));
  }

  /* Verify */
  bool is_arr;
  NAPI_CALL(napi_is_array(env, arr, &is_arr));
  if (!is_arr) {
    napi_throw_error(env, NULL, "Expected array");
    return NULL;
  }

  uint32_t len;
  NAPI_CALL(napi_get_array_length(env, arr, &len));
  if (len != 3) {
    napi_throw_error(env, NULL, "Expected length 3");
    return NULL;
  }

  return arr;
}

/* ===== Test: error handling ===== */
static napi_value test_error(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  /* Get the error message string */
  char msg[256];
  size_t len;
  NAPI_CALL(napi_get_value_string_utf8(env, argv[0], msg, sizeof(msg), &len));

  /* Create and throw an error */
  napi_value code_str, msg_str, error;
  NAPI_CALL(napi_create_string_utf8(env, "TEST_ERR", 8, &code_str));
  NAPI_CALL(napi_create_string_utf8(env, msg, len, &msg_str));
  NAPI_CALL(napi_create_error(env, code_str, msg_str, &error));
  NAPI_CALL(napi_throw(env, error));
  return NULL;
}

/* ===== Test: references ===== */
static napi_ref g_ref = NULL;

static napi_value test_ref_create(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  NAPI_CALL(napi_create_reference(env, argv[0], 1, &g_ref));

  napi_value result;
  NAPI_CALL(napi_get_undefined(env, &result));
  return result;
}

static napi_value test_ref_get(napi_env env, napi_callback_info info) {
  if (!g_ref) {
    napi_throw_error(env, NULL, "No reference stored");
    return NULL;
  }

  napi_value result;
  NAPI_CALL(napi_get_reference_value(env, g_ref, &result));
  return result;
}

/* ===== Test: class with wrap/unwrap ===== */
typedef struct {
  int value;
  char name[64];
} TestClass;

static napi_value test_class_ctor(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], this_val;
  NAPI_CALL(napi_get_cb_info(env, info, &argc, argv, &this_val, NULL));

  /* Allocate native data — use a static buffer for simplicity in wasm */
  static TestClass instances[16];
  static int next_instance = 0;
  TestClass *self = &instances[next_instance++ % 16];

  /* Read name from argv[0] */
  size_t name_len;
  NAPI_CALL(napi_get_value_string_utf8(env, argv[0], self->name, sizeof(self->name), &name_len));

  /* Read value from argv[1] - it's an int64 */
  int64_t val;
  /* Just read as bool since we pass numbers as handles */
  self->value = 0;
  if (argc > 1) {
    /* Try to coerce to string and parse, or just use a default */
    napi_value str;
    napi_coerce_to_string(env, argv[1], &str);
    char vbuf[32];
    size_t vlen;
    napi_get_value_string_utf8(env, str, vbuf, sizeof(vbuf), &vlen);
    self->value = atoi(vbuf);
  }

  NAPI_CALL(napi_wrap(env, this_val, self, NULL, NULL, NULL));
  return this_val;
}

static napi_value test_class_get_name(napi_env env, napi_callback_info info) {
  napi_value this_val;
  NAPI_CALL(napi_get_cb_info(env, info, NULL, NULL, &this_val, NULL));

  TestClass *self;
  NAPI_CALL(napi_unwrap(env, this_val, (void **)&self));

  napi_value result;
  NAPI_CALL(napi_create_string_utf8(env, self->name, strlen(self->name), &result));
  return result;
}

static napi_value test_class_get_value(napi_env env, napi_callback_info info) {
  napi_value this_val;
  NAPI_CALL(napi_get_cb_info(env, info, NULL, NULL, &this_val, NULL));

  TestClass *self;
  NAPI_CALL(napi_unwrap(env, this_val, (void **)&self));

  napi_value result;
  NAPI_CALL(napi_create_int64(env, self->value, &result));
  return result;
}

static napi_value test_class_set_value(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], this_val;
  NAPI_CALL(napi_get_cb_info(env, info, &argc, argv, &this_val, NULL));

  TestClass *self;
  NAPI_CALL(napi_unwrap(env, this_val, (void **)&self));

  napi_value str;
  napi_coerce_to_string(env, argv[0], &str);
  char vbuf[32];
  size_t vlen;
  napi_get_value_string_utf8(env, str, vbuf, sizeof(vbuf), &vlen);
  self->value = atoi(vbuf);

  napi_value undef;
  NAPI_CALL(napi_get_undefined(env, &undef));
  return undef;
}

/* ===== Test: exception pending check ===== */
static napi_value test_exception_pending(napi_env env, napi_callback_info info) {
  bool pending;
  NAPI_CALL(napi_is_exception_pending(env, &pending));

  napi_value result;
  NAPI_CALL(napi_create_string_utf8(env, pending ? "true" : "false", -1, &result));
  return result;
}

/* ===== Module registration ===== */
napi_value napi_register_wasm_v1(napi_env env, napi_value exports) {
  /* Simple function exports */
  napi_value fn;

#define EXPORT_FN(name, cb)                                        \
  napi_create_function(env, name, -1, cb, NULL, &fn);              \
  napi_set_named_property(env, exports, name, fn)

  EXPORT_FN("testObject", test_object);
  EXPORT_FN("testString", test_string);
  EXPORT_FN("testCallback", test_callback);
  EXPORT_FN("testTypeof", test_typeof);
  EXPORT_FN("testArray", test_array);
  EXPORT_FN("testError", test_error);
  EXPORT_FN("testRefCreate", test_ref_create);
  EXPORT_FN("testRefGet", test_ref_get);
  EXPORT_FN("testExceptionPending", test_exception_pending);

  /* Define a class: TestClass(name, value) with getName(), getValue(), setValue() */
  napi_property_descriptor props[] = {
    { "getName", NULL, test_class_get_name, NULL, NULL, NULL, napi_default, NULL },
    { "getValue", NULL, test_class_get_value, NULL, NULL, NULL, napi_default, NULL },
    { "setValue", NULL, test_class_set_value, NULL, NULL, NULL, napi_default, NULL },
  };

  napi_value ctor;
  napi_define_class(env, "TestClass", -1, test_class_ctor, NULL,
                    sizeof(props) / sizeof(props[0]), props, &ctor);
  napi_set_named_property(env, exports, "TestClass", ctor);

  return exports;
}
