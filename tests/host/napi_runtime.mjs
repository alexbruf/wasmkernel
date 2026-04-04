/**
 * Minimal N-API runtime for WasmKernel bridge.
 *
 * Implements the ~37 napi_* functions that @tailwindcss/oxide needs.
 * Operates on the guest's memory inside the kernel via kernel_guest_memory_base.
 *
 * Handle table maps napi_value (u32 in guest memory) ↔ JS values.
 * napi_env is handle 1. Handles start at 2.
 */

// napi_status codes
const napi_ok = 0;
const napi_invalid_arg = 1;
const napi_object_expected = 2;
const napi_string_expected = 3;
const napi_generic_failure = 9;

// napi_valuetype
const napi_undefined = 0;
const napi_null = 1;
const napi_boolean = 2;
const napi_number = 3;
const napi_string = 4;
const napi_symbol = 5;
const napi_object = 6;
const napi_function = 7;
const napi_external = 8;
const napi_bigint = 9;

export class NapiRuntime {
  constructor(kernelExports) {
    this.k = kernelExports;
    this.handles = new Map(); // handle_id -> JS value
    this.nextHandle = 2;     // 0=reserved, 1=env
    this.refs = new Map();   // ref_id -> { handle, refcount }
    this.nextRef = 1;
    this.lastException = null;
    this.exceptionPending = false;
    this.wraps = new Map();  // handle_id -> wrapped data
    this.cbInfoStack = [];   // for napi_get_cb_info

    // Pre-register env handle
    this.handles.set(1, { type: 'env' });

    // Pre-register global and undefined
    this.undefinedHandle = this._newHandle(undefined);
    this.globalHandle = this._newHandle(globalThis);
  }

  _newHandle(value) {
    const id = this.nextHandle++;
    this.handles.set(id, value);
    return id;
  }

  _getHandle(id) {
    return this.handles.get(id);
  }

  _deleteHandle(id) {
    this.handles.delete(id);
  }

  // Guest memory access via kernel
  _guestBase() {
    return this.k.kernel_guest_memory_base();
  }

  _readU32(guestPtr) {
    const dv = new DataView(this.k.memory.buffer);
    return dv.getUint32(this._guestBase() + guestPtr, true);
  }

  _writeU32(guestPtr, value) {
    const dv = new DataView(this.k.memory.buffer);
    dv.setUint32(this._guestBase() + guestPtr, value, true);
  }

  _writeI64(guestPtr, value) {
    const dv = new DataView(this.k.memory.buffer);
    dv.setBigInt64(this._guestBase() + guestPtr, BigInt(value), true);
  }

  _readString(guestPtr, len) {
    const base = this._guestBase();
    const bytes = new Uint8Array(this.k.memory.buffer, base + guestPtr, len);
    return new TextDecoder().decode(bytes);
  }

  _readNullTermString(guestPtr) {
    const base = this._guestBase();
    const mem = new Uint8Array(this.k.memory.buffer);
    let end = guestPtr;
    while (mem[base + end] !== 0) end++;
    return this._readString(guestPtr, end - guestPtr);
  }

  _writeString(guestPtr, maxLen, str) {
    const base = this._guestBase();
    const bytes = new TextEncoder().encode(str);
    const writeLen = Math.min(bytes.length, maxLen);
    const target = new Uint8Array(this.k.memory.buffer, base + guestPtr, writeLen);
    target.set(bytes.subarray(0, writeLen));
    return writeLen;
  }

  // Write a handle to a guest result pointer
  _writeResult(resultPtr, handle) {
    if (resultPtr) this._writeU32(resultPtr, handle);
  }

  // ===== N-API implementations =====
  // Each takes raw args (u32 array from bridge) and returns napi_status as BigInt

  napi_create_object(args) {
    const [env, resultPtr] = args;
    const h = this._newHandle({});
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_get_undefined(args) {
    const [env, resultPtr] = args;
    this._writeResult(resultPtr, this.undefinedHandle);
    return napi_ok;
  }

  napi_get_global(args) {
    const [env, resultPtr] = args;
    this._writeResult(resultPtr, this.globalHandle);
    return napi_ok;
  }

  napi_create_string_utf8(args) {
    const [env, strPtr, len, resultPtr] = args;
    // len = -1 means null-terminated; otherwise use len
    let str;
    if (len === 0xFFFFFFFF || len === -1) {
      // Read until null terminator
      const base = this._guestBase();
      const mem = new Uint8Array(this.k.memory.buffer);
      let end = strPtr;
      while (mem[base + end] !== 0) end++;
      str = this._readString(strPtr, end - strPtr);
    } else {
      str = this._readString(strPtr, len);
    }
    const h = this._newHandle(str);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_get_value_string_utf8(args) {
    const [env, valueHandle, bufPtr, bufSize, resultPtr] = args;
    const value = this._getHandle(valueHandle);
    const str = String(value ?? '');
    if (bufPtr && bufSize > 0) {
      const written = this._writeString(bufPtr, bufSize - 1, str);
      // Null-terminate
      const base = this._guestBase();
      new Uint8Array(this.k.memory.buffer)[base + bufPtr + written] = 0;
    }
    if (resultPtr) this._writeU32(resultPtr, str.length);
    return napi_ok;
  }

  napi_set_named_property(args) {
    const [env, objectHandle, namePtr, valueHandle] = args;
    const obj = this._getHandle(objectHandle);
    const val = this._getHandle(valueHandle);
    const name = this._readNullTermString(namePtr);
    if (obj && typeof obj === 'object') obj[name] = val;
    return napi_ok;
  }

  napi_get_named_property(args) {
    const [env, objectHandle, namePtr, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    const name = this._readNullTermString(namePtr);
    const val = obj?.[name];
    const h = this._newHandle(val);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_get_property(args) {
    const [env, objectHandle, keyHandle, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    const key = this._getHandle(keyHandle);
    const val = obj?.[key];
    const h = this._newHandle(val);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_set_property(args) {
    const [env, objectHandle, keyHandle, valueHandle] = args;
    const obj = this._getHandle(objectHandle);
    const key = this._getHandle(keyHandle);
    const val = this._getHandle(valueHandle);
    if (obj && typeof obj === 'object') obj[key] = val;
    return napi_ok;
  }

  napi_typeof(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    let type = napi_undefined;
    switch (typeof val) {
      case 'undefined': type = napi_undefined; break;
      case 'boolean': type = napi_boolean; break;
      case 'number': type = napi_number; break;
      case 'string': type = napi_string; break;
      case 'symbol': type = napi_symbol; break;
      case 'function': type = napi_function; break;
      case 'object': type = val === null ? napi_null : napi_object; break;
      case 'bigint': type = napi_bigint; break;
    }
    this._writeU32(resultPtr, type);
    return napi_ok;
  }

  // Call back into guest via kernel_call_indirect
  _callGuestCallback(tableIdx, envHandle, cbInfoId) {
    const argvPtr = this.k.kernel_alloc(8);
    const dv = new DataView(this.k.memory.buffer);
    dv.setUint32(argvPtr, envHandle, true);
    dv.setUint32(argvPtr + 4, cbInfoId, true);
    const result = this.k.kernel_call_indirect(tableIdx, 2, argvPtr);
    if (result !== 0) return this.undefinedHandle;
    // Return value is in argv[0]
    return dv.getUint32(argvPtr, true);
  }

  // Create a JS function that calls back into a guest wasm callback
  _makeCallbackFunction(tableIdx, dataPtr) {
    const self = this;
    return function(...jsArgs) {
      const argHandles = jsArgs.map(a => self._newHandle(a));
      const cbInfoId = self.nextHandle++;
      self.cbInfoStack.push({
        id: cbInfoId,
        thisHandle: self._newHandle(this),
        args: argHandles,
        data: dataPtr,
      });
      const resultHandle = self._callGuestCallback(tableIdx, 1, cbInfoId);
      self.cbInfoStack.pop();
      return self._getHandle(resultHandle);
    };
  }

  napi_create_function(args) {
    const [env, namePtr, nameLen, cbPtr, dataPtr, resultPtr] = args;
    const fn = this._makeCallbackFunction(cbPtr, dataPtr);
    // Set function name if provided
    if (namePtr && nameLen > 0) {
      const name = nameLen === 0xFFFFFFFF
        ? this._readNullTermString(namePtr)
        : this._readString(namePtr, nameLen);
      Object.defineProperty(fn, 'name', { value: name });
    }
    const h = this._newHandle(fn);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_call_function(args) {
    const [env, recvHandle, funcHandle, argc, argvPtr, resultPtr] = args;
    const fn = this._getHandle(funcHandle);
    const recv = this._getHandle(recvHandle);
    const fnArgs = [];
    for (let i = 0; i < argc; i++) {
      const argHandle = this._readU32(argvPtr + i * 4);
      fnArgs.push(this._getHandle(argHandle));
    }
    try {
      const result = fn?.apply(recv, fnArgs);
      if (resultPtr) {
        const h = this._newHandle(result);
        this._writeResult(resultPtr, h);
      }
    } catch (e) {
      this.lastException = e;
      this.exceptionPending = true;
      return napi_generic_failure;
    }
    return napi_ok;
  }

  napi_create_array_with_length(args) {
    const [env, len, resultPtr] = args;
    const h = this._newHandle(new Array(len));
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_is_array(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    this._writeU32(resultPtr, Array.isArray(val) ? 1 : 0);
    return napi_ok;
  }

  napi_get_array_length(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    this._writeU32(resultPtr, Array.isArray(val) ? val.length : 0);
    return napi_ok;
  }

  napi_set_element(args) {
    const [env, objectHandle, index, valueHandle] = args;
    const obj = this._getHandle(objectHandle);
    const val = this._getHandle(valueHandle);
    if (obj) obj[index] = val;
    return napi_ok;
  }

  napi_get_element(args) {
    const [env, objectHandle, index, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    const val = obj?.[index];
    const h = this._newHandle(val);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_create_reference(args) {
    const [env, valueHandle, initialRefcount, resultPtr] = args;
    const refId = this.nextRef++;
    this.refs.set(refId, { handle: valueHandle, refcount: initialRefcount });
    this._writeU32(resultPtr, refId);
    return napi_ok;
  }

  napi_get_reference_value(args) {
    const [env, refId, resultPtr] = args;
    const ref = this.refs.get(refId);
    this._writeResult(resultPtr, ref ? ref.handle : 0);
    return napi_ok;
  }

  napi_reference_unref(args) {
    const [env, refId, resultPtr] = args;
    const ref = this.refs.get(refId);
    if (ref) ref.refcount = Math.max(0, ref.refcount - 1);
    if (resultPtr) this._writeU32(resultPtr, ref ? ref.refcount : 0);
    return napi_ok;
  }

  napi_delete_reference(args) {
    const [env, refId] = args;
    this.refs.delete(refId);
    return napi_ok;
  }

  napi_define_class(args) {
    const [env, namePtr, nameLen, ctorCbPtr, ctorData, propCount, propsPtr, resultPtr] = args;
    const className = nameLen === 0xFFFFFFFF
      ? this._readNullTermString(namePtr)
      : this._readString(namePtr, nameLen);

    const self = this;
    // Create constructor that calls guest callback
    const ctor = function(...jsArgs) {
      const argHandles = jsArgs.map(a => self._newHandle(a));
      const cbInfoId = self.nextHandle++;
      const thisHandle = self._newHandle(this);
      self.cbInfoStack.push({
        id: cbInfoId, thisHandle, args: argHandles, data: ctorData,
      });
      self._callGuestCallback(ctorCbPtr, 1, cbInfoId);
      self.cbInfoStack.pop();
    };
    Object.defineProperty(ctor, 'name', { value: className });

    // Parse property descriptors and add methods to prototype
    // napi_property_descriptor layout (wasm32):
    //   utf8name: i32 (0), name: i32 (4), method: i32 (8), getter: i32 (12),
    //   setter: i32 (16), value: i32 (20), attributes: i32 (24), data: i32 (28)
    // Total: 32 bytes per descriptor
    const PROP_SIZE = 32;
    for (let i = 0; i < propCount; i++) {
      const base = propsPtr + i * PROP_SIZE;
      const utf8namePtr = this._readU32(base + 0);
      const methodCb = this._readU32(base + 8);
      const getterCb = this._readU32(base + 12);
      const setterCb = this._readU32(base + 16);
      const valueHandle = this._readU32(base + 20);
      const attributes = this._readU32(base + 24);
      const propData = this._readU32(base + 28);

      let propName = '';
      if (utf8namePtr) {
        propName = this._readNullTermString(utf8namePtr);
      }
      if (!propName) continue;

      const isStatic = (attributes & (1 << 10)) !== 0; // napi_static = 1 << 10
      const target = isStatic ? ctor : ctor.prototype;

      if (methodCb) {
        target[propName] = this._makeCallbackFunction(methodCb, propData);
      } else if (getterCb || setterCb) {
        const desc = {};
        if (getterCb) desc.get = this._makeCallbackFunction(getterCb, propData);
        if (setterCb) desc.set = this._makeCallbackFunction(setterCb, propData);
        Object.defineProperty(target, propName, desc);
      } else if (valueHandle) {
        target[propName] = this._getHandle(valueHandle);
      }
    }

    const h = this._newHandle(ctor);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_get_cb_info(args) {
    const [env, cbInfo, argcPtr, argvPtr, thisPtr, dataPtr] = args;
    // Find the cb info by ID (cbInfo is the ID we passed to the guest)
    const info = this.cbInfoStack.find(i => i.id === cbInfo)
      || this.cbInfoStack[this.cbInfoStack.length - 1];
    if (!info) return napi_generic_failure;

    if (argcPtr) {
      const maxArgs = this._readU32(argcPtr);
      const actualArgs = info.args.length;
      this._writeU32(argcPtr, actualArgs);
      if (argvPtr) {
        for (let i = 0; i < Math.min(maxArgs, actualArgs); i++) {
          this._writeU32(argvPtr + i * 4, info.args[i]);
        }
        // Fill remaining with undefined
        for (let i = actualArgs; i < maxArgs; i++) {
          this._writeU32(argvPtr + i * 4, this.undefinedHandle);
        }
      }
    }
    if (thisPtr) this._writeU32(thisPtr, info.thisHandle);
    if (dataPtr) this._writeU32(dataPtr, info.data);
    return napi_ok;
  }

  napi_get_value_bool(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    this._writeU32(resultPtr, val ? 1 : 0);
    return napi_ok;
  }

  napi_create_int64(args) {
    const [env, valueLo, valueHi, resultPtr] = args;
    // Value comes as two u32 (lo/hi) from bridge
    const value = valueLo + (valueHi * 0x100000000);
    const h = this._newHandle(value);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_coerce_to_string(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    const h = this._newHandle(String(val ?? ''));
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_coerce_to_object(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    const h = this._newHandle(Object(val));
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_wrap(args) {
    const [env, objectHandle, nativePtr, _finalize, _hint, resultPtr] = args;
    this.wraps.set(objectHandle, nativePtr);
    if (resultPtr) {
      const refId = this.nextRef++;
      this.refs.set(refId, { handle: objectHandle, refcount: 0 });
      this._writeU32(resultPtr, refId);
    }
    return napi_ok;
  }

  napi_unwrap(args) {
    const [env, objectHandle, resultPtr] = args;
    const ptr = this.wraps.get(objectHandle) ?? 0;
    this._writeU32(resultPtr, ptr);
    return napi_ok;
  }

  // Error handling
  napi_throw_error(args) {
    const [env, codePtr, msgPtr] = args;
    const code = codePtr ? this._readNullTermString(codePtr) : '';
    const msg = msgPtr ? this._readNullTermString(msgPtr) : 'unknown error';
    console.error(`  napi_throw_error: code='${code}' msg='${msg}'`);
    this.lastException = new Error(`${code}: ${msg}`);
    this.exceptionPending = true;
    return napi_ok;
  }

  napi_throw(args) {
    const [env, errorHandle] = args;
    this.lastException = this._getHandle(errorHandle);
    this.exceptionPending = true;
    return napi_ok;
  }

  napi_create_error(args) {
    const [env, codeHandle, msgHandle, resultPtr] = args;
    const msg = this._getHandle(msgHandle);
    const err = new Error(typeof msg === 'string' ? msg : String(msg));
    const h = this._newHandle(err);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_is_error(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    this._writeU32(resultPtr, val instanceof Error ? 1 : 0);
    return napi_ok;
  }

  napi_is_exception_pending(args) {
    const [env, resultPtr] = args;
    this._writeU32(resultPtr, this.exceptionPending ? 1 : 0);
    return napi_ok;
  }

  napi_get_and_clear_last_exception(args) {
    const [env, resultPtr] = args;
    if (this.lastException) {
      const h = this._newHandle(this.lastException);
      this._writeResult(resultPtr, h);
    } else {
      this._writeResult(resultPtr, this.undefinedHandle);
    }
    this.lastException = null;
    this.exceptionPending = false;
    return napi_ok;
  }

  // Threadsafe functions
  napi_create_threadsafe_function(args) {
    // args: env, func, asyncResource, asyncResourceName, maxQueueSize,
    //       initialThreadCount, threadFinalizeData, threadFinalizeCb,
    //       context, callJsCb, resultPtr
    const funcHandle = args[1];
    const context = args[8];
    const callJsCb = args[9];
    const resultPtr = args[10];

    const tsf = {
      type: 'threadsafe_function',
      funcHandle,
      context,
      callJsCb,
      queue: [],
    };
    const h = this._newHandle(tsf);
    this._writeResult(resultPtr, h);

    // If there's a JS callback function, invoke it immediately
    // This triggers napi-rs's module registration
    if (funcHandle) {
      const fn = this._getHandle(funcHandle);
      if (typeof fn === 'function') {
        try { fn(); } catch (e) { /* ignore */ }
      }
    }

    return napi_ok;
  }

  napi_unref_threadsafe_function(args) {
    return napi_ok;
  }

  // Dispatch: find the right method by function name
  dispatch(funcName, args) {
    const method = this[funcName];
    if (method) {
      const result = method.call(this, args);
      if (this.debug) {
        console.error(`  napi: ${funcName}(${args.join(',')}) -> ${result}`);
      }
      return BigInt(result);
    }
    console.error(`napi: unimplemented ${funcName}`);
    return BigInt(napi_generic_failure);
  }
}
