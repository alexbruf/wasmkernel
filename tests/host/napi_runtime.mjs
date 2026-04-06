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
const napi_name_expected = 4;
const napi_function_expected = 5;
const napi_number_expected = 6;
const napi_boolean_expected = 7;
const napi_array_expected = 8;
const napi_generic_failure = 9;
const napi_pending_exception = 10;
const napi_cancelled = 11;
const napi_escape_called_twice = 12;

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
    this.wraps = new WeakMap();  // JS object -> native ptr (weak to allow GC)
    this.cbInfoStack = [];   // for napi_get_cb_info
    this._asyncWorks = new Map();
    this._nextAsyncId = 1;
    this._pendingAsyncQueue = [];
    this._escapedScopes = new Set();
    this._abMemory = new WeakMap();

    // Handle scopes: track which handles to release when a callback returns
    this._scopeStack = [];        // stack of nextHandle values at scope entry
    this._referencedHandles = new Set(); // handles kept alive by napi_create_reference
    this._escapedHandleIds = new Set();  // handles escaped from their scope

    // FinalizationRegistry for calling C destructors when JS GC collects handles
    this._postedFinalizers = [];
    this._postedFinalizersPending = false;
    if (typeof FinalizationRegistry !== 'undefined') {
      this._postedFinalizers = [];
      this._postedFinalizersPending = false;
      this._postedFinalizersRegistry = new FinalizationRegistry((info) => {
        // info = { cb, env, data, hint }
        // Can't call kernel_call_indirect in finalizer callback (not in JS call stack from wasm)
        // Queue it and drain when next bridge call happens
        this._postedFinalizers.push(info);
        this._postedFinalizersPending = true;
      });
    }

    // Pre-register env handle
    this.handles.set(1, { type: 'env' });

    // Pre-register global and undefined
    this.undefinedHandle = this._newHandle(undefined);
    this.globalHandle = this._newHandle(globalThis);
  }

  // Register a destructor callback for a JS object
  _registerFinalizer(jsObj, finalizeCb, dataPtr, hintPtr) {
    if (this._postedFinalizersRegistry && finalizeCb) {
      this._postedFinalizersRegistry.register(jsObj, { cb: finalizeCb, data: dataPtr, hint: hintPtr });
    }
  }

  // Drain queued destructor callbacks (called from dispatch)
  _drainFinalizers() {
    while (this._postedFinalizers.length > 0) {
      const { cb, data, hint } = this._postedFinalizers.shift();
      try {
        const ap = this.k.kernel_alloc(16);
        new DataView(this._buf()).setUint32(ap, 1, true);       // env
        new DataView(this._buf()).setUint32(ap + 4, data, true); // finalize_data
        new DataView(this._buf()).setUint32(ap + 8, hint, true); // finalize_hint
        this.k.kernel_call_indirect(cb, 3, ap);
      } catch {}
    }
    this._postedFinalizersPending = false;
  }

  _pushScope() {
    this._scopeStack.push(this.nextHandle);
  }

  _popScope() {
    const scopeStart = this._scopeStack.pop();
    if (scopeStart === undefined) return;
    for (let id = scopeStart; id < this.nextHandle; id++) {
      if (this._referencedHandles.has(id)) continue;
      if (this._escapedHandleIds.has(id)) { this._escapedHandleIds.delete(id); continue; }
      this.handles.delete(id);
    }
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

  // Write a C bool (1 byte) to guest memory
  _writeBool(guestPtr, value) {
    if (!guestPtr) return;
    new Uint8Array(this._buf())[this._guestBase() + guestPtr] = value ? 1 : 0;
  }

  // Guest memory access via kernel
  _guestBase() {
    return this.k.kernel_guest_memory_base();
  }

  // Always get a fresh buffer — wasm memory.grow detaches the old ArrayBuffer
  _buf() { return this.k.memory.buffer; }

  _readU32(guestPtr) {
    return new DataView(this._buf()).getUint32(this._guestBase() + guestPtr, true);
  }

  _writeU32(guestPtr, value) {
    new DataView(this._buf()).setUint32(this._guestBase() + guestPtr, value, true);
  }

  _writeI64(guestPtr, value) {
    new DataView(this._buf()).setBigInt64(this._guestBase() + guestPtr, BigInt(value), true);
  }

  _readString(guestPtr, len) {
    const base = this._guestBase();
    const bytes = new Uint8Array(this._buf(), base + guestPtr, len);
    return new TextDecoder().decode(bytes);
  }

  _readNullTermString(guestPtr) {
    const base = this._guestBase();
    const mem = new Uint8Array(this._buf());
    let end = guestPtr;
    while (mem[base + end] !== 0) end++;
    return this._readString(guestPtr, end - guestPtr);
  }

  _writeString(guestPtr, maxLen, str) {
    const base = this._guestBase();
    const bytes = new TextEncoder().encode(str);
    const writeLen = Math.min(bytes.length, maxLen);
    const target = new Uint8Array(this._buf(), base + guestPtr, writeLen);
    target.set(bytes.subarray(0, writeLen));
    return writeLen;
  }

  // Write a handle to a guest result pointer. Returns false if ptr is NULL.
  _writeResult(resultPtr, handle) {
    if (!resultPtr) return false;
    this._writeU32(resultPtr, handle);
    return true;
  }

  // ===== N-API implementations =====
  // Each takes raw args (u32 array from bridge) and returns napi_status as BigInt

  napi_create_object(args) {
    const [env, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    const h = this._newHandle({});
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_get_undefined(args) {
    const [env, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    this._writeResult(resultPtr, this.undefinedHandle);
    return napi_ok;
  }

  napi_get_global(args) {
    const [env, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    this._writeResult(resultPtr, this.globalHandle);
    return napi_ok;
  }

  napi_create_string_utf8(args) {
    const [env, strPtr, len, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    // len = -1 means null-terminated; otherwise use len
    let str;
    if (len === 0xFFFFFFFF || len === -1) {
      str = this._readNullTermString(strPtr);
    } else {
      str = this._readString(strPtr, len);
    }
    const h = this._newHandle(str);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_get_value_string_utf8(args) {
    const [env, valueHandle, bufPtr, bufSize, resultPtr] = args;
    if (!valueHandle) return napi_invalid_arg;
    const value = this._getHandle(valueHandle);
    if (typeof value !== 'string') return napi_string_expected;
    if (!bufPtr && !resultPtr) return napi_invalid_arg;
    const str = value;
    if (bufPtr && bufSize > 0) {
      const written = this._writeString(bufPtr, bufSize - 1, str);
      // Null-terminate
      const base = this._guestBase();
      new Uint8Array(this._buf())[base + bufPtr + written] = 0;
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
      case 'object': type = val === null ? napi_null : (val?.__external ? napi_external : napi_object); break;
      case 'bigint': type = napi_bigint; break;
    }
    this._writeU32(resultPtr, type);
    return napi_ok;
  }

  // Call back into guest via kernel_call_indirect
  _callGuestCallback(tableIdx, envHandle, cbInfoId) {
    const argvPtr = this.k.kernel_alloc(8);
    // Fresh buffer for each write — alloc or guest call may grow memory
    new DataView(this._buf()).setUint32(argvPtr, envHandle, true);
    new DataView(this._buf()).setUint32(argvPtr + 4, cbInfoId, true);
    const result = this.k.kernel_call_indirect(tableIdx, 2, argvPtr);
    if (result !== 0) return this.undefinedHandle;
    // Fresh buffer after guest call (memory may have grown)
    return new DataView(this._buf()).getUint32(argvPtr, true);
  }

  // Create a JS function that calls back into a guest wasm callback
  _makeCallbackFunction(tableIdx, dataPtr) {
    const self = this;
    return function(...jsArgs) {
      self._pushScope();
      const argHandles = jsArgs.map(a => self._newHandle(a));
      const cbInfoId = self.nextHandle++;
      const newTargetHandle = new.target ? self._newHandle(new.target) : 0;
      self.cbInfoStack.push({
        id: cbInfoId,
        thisHandle: self._newHandle(this),
        args: argHandles,
        data: dataPtr,
        newTarget: newTargetHandle,
      });
      const resultHandle = self._callGuestCallback(tableIdx, 1, cbInfoId);
      self.cbInfoStack.pop();
      // Check for pending exception after guest callback
      if (self.exceptionPending) {
        self._popScope();
        const exc = self.lastException;
        self.lastException = null;
        self.exceptionPending = false;
        throw exc;
      }
      // Get return value BEFORE popping scope (it's in current scope)
      const retVal = self._getHandle(resultHandle);
      self._popScope();
      // Drain any deferred async work
      if (self._pendingAsyncQueue && self._pendingAsyncQueue.length > 0) {
        self.drainAsyncQueue();
      }
      return retVal;
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
    if (!resultPtr) return napi_invalid_arg;
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
      return napi_pending_exception;
    }
    return napi_ok;
  }

  napi_create_array_with_length(args) {
    const [env, len, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    const h = this._newHandle(new Array(len));
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_is_array(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    this._writeBool(resultPtr, Array.isArray(val));
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
    if (!resultPtr) return napi_invalid_arg;
    const refId = this.nextRef++;
    this.refs.set(refId, { handle: valueHandle, refcount: initialRefcount });
    // Keep the handle alive across scope boundaries
    this._referencedHandles.add(valueHandle);
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
    const ref = this.refs.get(refId);
    if (ref) {
      this._referencedHandles.delete(ref.handle);
      this.handles.delete(ref.handle); // allow GC
    }
    this.refs.delete(refId);
    return napi_ok;
  }

  napi_define_class(args) {
    const [env, namePtr, nameLen, ctorCbPtr, ctorData, propCount, propsPtr, resultPtr] = args;
    if (!namePtr || !ctorCbPtr || !resultPtr || (propCount > 0 && !propsPtr))
      return napi_invalid_arg;
    const className = nameLen === 0xFFFFFFFF
      ? this._readNullTermString(namePtr)
      : this._readString(namePtr, nameLen);

    const self = this;
    // Create constructor that calls guest callback
    const ctor = function(...jsArgs) {
      self._pushScope();
      const argHandles = jsArgs.map(a => self._newHandle(a));
      const cbInfoId = self.nextHandle++;
      const thisHandle = self._newHandle(this);
      // Track new.target for napi_get_new_target
      const newTargetHandle = new.target ? self._newHandle(new.target) : 0;
      self.cbInfoStack.push({
        id: cbInfoId, thisHandle, args: argHandles, data: ctorData, newTarget: newTargetHandle,
      });
      self._callGuestCallback(ctorCbPtr, 1, cbInfoId);
      self.cbInfoStack.pop();
      self._popScope();
    };
    Object.defineProperty(ctor, 'name', { value: className });

    // Parse property descriptors — split static vs instance
    const PROP_SIZE = 32;
    for (let i = 0; i < propCount; i++) {
      const attrs = this._readU32(propsPtr + i * PROP_SIZE + 24);
      const isStatic = (attrs & (1 << 10)) !== 0; // napi_static
      const target = isStatic ? ctor : ctor.prototype;
      this._applyPropertyDescriptors(target, 1, propsPtr + i * PROP_SIZE);
    }

    if (!resultPtr) return napi_invalid_arg;
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
    if (!valueHandle || !resultPtr) return napi_invalid_arg;
    const val = this._getHandle(valueHandle);
    if (typeof val !== 'boolean') return napi_boolean_expected;
    this._writeBool(resultPtr, val);
    return napi_ok;
  }

  napi_create_int64(args) {
    // Signature: (env: i32, value: i64, result: i32) — read full i64 from raw args
    const val = Number(this._readArgI64(this._currentArgsPtr, 1));
    const resultPtr = args[2];
    if (!resultPtr) return napi_invalid_arg;
    const h = this._newHandle(val);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_coerce_to_string(args) {
    const [env, valueHandle, resultPtr] = args;
    if (!valueHandle || !resultPtr) return napi_invalid_arg;
    const val = this._getHandle(valueHandle);
    // V8's ToString() throws for symbols (unlike JS String())
    if (typeof val === 'symbol') {
      this.lastException = new TypeError('Cannot convert a Symbol value to a string');
      this.exceptionPending = true;
      return napi_pending_exception;
    }
    try {
      const h = this._newHandle(String(val));
      this._writeResult(resultPtr, h);
    } catch (e) {
      this.lastException = e;
      this.exceptionPending = true;
      return napi_pending_exception;
    }
    return napi_ok;
  }

  napi_coerce_to_object(args) {
    const [env, valueHandle, resultPtr] = args;
    if (!valueHandle || !resultPtr) return napi_invalid_arg;
    const val = this._getHandle(valueHandle);
    if (val === null || val === undefined) {
      this.lastException = new TypeError('Cannot convert undefined or null to object');
      this.exceptionPending = true;
      return napi_pending_exception;
    }
    const h = this._newHandle(Object(val));
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_wrap(args) {
    const [env, objectHandle, nativePtr, finalizeCb, finalizeHint, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    if (obj && typeof obj === 'object') {
      if (this.wraps.has(obj)) return napi_invalid_arg; // already wrapped
      this.wraps.set(obj, nativePtr);
      this._registerFinalizer(obj, finalizeCb, nativePtr, finalizeHint);
    }
    if (resultPtr) {
      const refId = this.nextRef++;
      this.refs.set(refId, { handle: objectHandle, refcount: 0 });
      this._writeU32(resultPtr, refId);
    }
    return napi_ok;
  }

  napi_unwrap(args) {
    const [env, objectHandle, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    const ptr = (obj && typeof obj === 'object') ? (this.wraps.get(obj) ?? 0) : 0;
    this._writeU32(resultPtr, ptr);
    return napi_ok;
  }

  // Error handling
  napi_throw_error(args) {
    const [env, codePtr, msgPtr] = args;
    const code = codePtr ? this._readNullTermString(codePtr) : '';
    const msg = msgPtr ? this._readNullTermString(msgPtr) : 'unknown error';
    const err = new Error(msg);
    if (code) err.code = code;
    this.lastException = err;
    this.exceptionPending = true;
    return napi_ok;
  }

  napi_throw(args) {
    const [env, errorHandle] = args;
    this.lastException = this._getHandle(errorHandle);
    this.exceptionPending = true;
    if (this.debug && this.lastException instanceof Error) {
      console.error(`  napi_throw: "${this.lastException.message}"`);
    }
    return napi_ok;
  }

  napi_create_error(args) {
    const [env, codeHandle, msgHandle, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    const msg = this._getHandle(msgHandle);
    const err = new Error(typeof msg === 'string' ? msg : String(msg));
    if (codeHandle) { const code = this._getHandle(codeHandle); if (code) err.code = code; }
    const h = this._newHandle(err);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_is_error(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    this._writeBool(resultPtr, val instanceof Error);
    return napi_ok;
  }

  napi_is_exception_pending(args) {
    const [env, resultPtr] = args;
    this._writeBool(resultPtr, this.exceptionPending);
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

    // Don't auto-invoke — napi-rs handles this internally

    return napi_ok;
  }

  napi_unref_threadsafe_function(args) {
    return napi_ok;
  }

  // napi_get_last_error_info(env, result_ptr) -> status
  napi_get_last_error_info(args) {
    const [env, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    // Allocate error info struct in guest memory (16 bytes)
    // napi_extended_error_info: error_message(i32), engine_reserved(i32), engine_error_code(u32), error_code(i32)
    // Use a fixed region at the END of guest memory for the error struct.
    // This avoids needing guest-side malloc. Reserve 16+256 bytes.
    const guestSize = this.k.kernel_guest_memory_size();
    const errorStructGuestAddr = guestSize - 512; // near end of guest memory
    const msgGuestAddr = errorStructGuestAddr + 16;
    const base = this._guestBase();
    const status = this._lastStatus ?? 0;
    const messages = [
      null, 'Invalid argument', 'An object was expected', 'A string was expected',
      'A string or symbol was expected', 'A function was expected', 'A number was expected',
      'A boolean was expected', 'An array was expected', 'Unknown failure',
      'An exception is pending', 'Cancelled', 'napi_escape_called_twice',
    ];
    const msg = messages[status] ?? null;
    let errorMsgGuestPtr = 0;
    if (msg) {
      const mem = new Uint8Array(this._buf());
      for (let i = 0; i < msg.length; i++) mem[base + msgGuestAddr + i] = msg.charCodeAt(i);
      mem[base + msgGuestAddr + msg.length] = 0;
      errorMsgGuestPtr = msgGuestAddr;
    }
    this._writeU32(errorStructGuestAddr, errorMsgGuestPtr);
    this._writeU32(errorStructGuestAddr + 4, 0);
    this._writeU32(errorStructGuestAddr + 8, 0);
    this._writeU32(errorStructGuestAddr + 12, status);
    this._writeU32(resultPtr, errorStructGuestAddr);
    return napi_ok;
  }

  // napi_get_value_int32(env, value, result_ptr)
  napi_get_value_int32(args) {
    const [env, valueHandle, resultPtr] = args;
    if (!valueHandle || !resultPtr) return napi_invalid_arg;
    const val = this._getHandle(valueHandle);
    if (typeof val !== 'number') return napi_number_expected;
    const base = this._guestBase();
    new DataView(this._buf()).setInt32(base + resultPtr, Number(val) | 0, true);
    return napi_ok;
  }

  // napi_get_value_uint32(env, value, result_ptr)
  napi_get_value_uint32(args) {
    const [env, valueHandle, resultPtr] = args;
    if (!valueHandle || !resultPtr) return napi_invalid_arg;
    const val = this._getHandle(valueHandle);
    if (typeof val !== 'number') return napi_number_expected;
    this._writeU32(resultPtr, Number(val) >>> 0);
    return napi_ok;
  }

  // napi_get_value_int64(env, value, result_ptr)
  napi_get_value_int64(args) {
    const [env, valueHandle, resultPtr] = args;
    if (!valueHandle || !resultPtr) return napi_invalid_arg;
    const val = this._getHandle(valueHandle);
    if (typeof val !== 'number') return napi_number_expected;
    const base = this._guestBase();
    // Convert to int64 via BigInt — setBigInt64 handles wrapping naturally
    let i64val;
    const trunc = Math.trunc(val);
    if (!Number.isFinite(trunc)) {
      i64val = 0n;
    } else {
      // BigInt(trunc) may exceed int64 range for very large floats;
      // setBigInt64 wraps naturally (mod 2^64) which matches V8 behavior
      try { i64val = BigInt(trunc); } catch { i64val = 0n; }
    }
    new DataView(this._buf()).setBigInt64(base + resultPtr, i64val, true);
    return napi_ok;
  }

  // napi_get_value_double(env, value, result_ptr)
  napi_get_value_double(args) {
    const [env, valueHandle, resultPtr] = args;
    if (!valueHandle || !resultPtr) return napi_invalid_arg;
    const val = this._getHandle(valueHandle);
    if (typeof val !== 'number') return napi_number_expected;
    const base = this._guestBase();
    new DataView(this._buf()).setFloat64(base + resultPtr, Number(val), true);
    return napi_ok;
  }

  // napi_create_int32(env, value, result_ptr)
  napi_create_int32(args) {
    const [env, value, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    // value is passed as i32 through bridge
    const h = this._newHandle(value | 0);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_create_uint32(env, value, result_ptr)
  napi_create_uint32(args) {
    const [env, value, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    const h = this._newHandle(value >>> 0);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_create_double(env, value: f64, result_ptr) — sig: (iFi)i
  napi_create_double(args) {
    // arg[1] is f64 in bridge — read raw 8 bytes, arg[2] is result ptr
    const val = this._readArgF64(this._currentArgsPtr, 1);
    const resultPtr = args[2]; // 3rd raw slot = result ptr (after f64)
    if (!resultPtr) return napi_invalid_arg;
    const h = this._newHandle(val);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_has_named_property(env, object, name_ptr, result_ptr)
  napi_has_named_property(args) {
    const [env, objectHandle, namePtr, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    const name = this._readNullTermString(namePtr);
    const has = obj && typeof obj === 'object' && name in obj;
    this._writeBool(resultPtr, has);
    return napi_ok;
  }

  // napi_has_property(env, object, key, result_ptr)
  napi_has_property(args) {
    const [env, objectHandle, keyHandle, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    const key = this._getHandle(keyHandle);
    const has = obj && typeof obj === 'object' && key in obj;
    this._writeBool(resultPtr, has);
    return napi_ok;
  }

  // napi_strict_equals(env, lhs, rhs, result_ptr)
  napi_strict_equals(args) {
    const [env, lhsHandle, rhsHandle, resultPtr] = args;
    const lhs = this._getHandle(lhsHandle);
    const rhs = this._getHandle(rhsHandle);
    this._writeBool(resultPtr, lhs === rhs);
    return napi_ok;
  }

  // napi_get_null(env, result_ptr)
  napi_get_null(args) {
    const [env, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    const h = this._newHandle(null);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_get_boolean(env, value, result_ptr)
  napi_get_boolean(args) {
    const [env, value, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    const h = this._newHandle(!!value);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_create_string_latin1(env, str_ptr, len, result_ptr)
  napi_create_string_latin1(args) {
    const [env, strPtr, len, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    // Latin1 is essentially the same as reading bytes
    const actualLen = (len === 0xFFFFFFFF) ? undefined : len;
    let str;
    if (actualLen === undefined) {
      str = this._readNullTermString(strPtr);
    } else {
      str = this._readString(strPtr, actualLen);
    }
    const h = this._newHandle(str);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // ===== node_api_* functions =====
  napi_throw_syntax_error(args) {
    const [env, codePtr, msgPtr] = args;
    const code = codePtr ? this._readNullTermString(codePtr) : '';
    const msg = msgPtr ? this._readNullTermString(msgPtr) : '';
    this.lastException = new SyntaxError(msg);
    if (code) this.lastException.code = code;
    this.exceptionPending = true;
    return napi_ok;
  }
  napi_create_syntax_error(args) {
    const [env, codeHandle, msgHandle, resultPtr] = args;
    const msg = this._getHandle(msgHandle);
    const err = new SyntaxError(typeof msg === 'string' ? msg : String(msg));
    if (codeHandle) { const code = this._getHandle(codeHandle); if (code) err.code = code; }
    const h = this._newHandle(err);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }
  node_api_throw_syntax_error(args) {
    return this.napi_throw_syntax_error(args);
  }
  node_api_create_syntax_error(args) {
    return this.napi_create_syntax_error(args);
  }
  node_api_symbol_for(args) {
    const [env, descPtr, descLen, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    if (!descPtr && descLen > 0 && descLen !== 0xFFFFFFFF) return napi_invalid_arg;
    const desc = !descPtr ? '' : (descLen === 0xFFFFFFFF ? this._readNullTermString(descPtr) : this._readString(descPtr, descLen));
    const sym = Symbol.for(desc);
    const h = this._newHandle(sym);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }
  node_api_set_prototype(args) {
    const [env, objectHandle, protoHandle] = args;
    const obj = this._getHandle(objectHandle);
    const proto = this._getHandle(protoHandle);
    if (obj && proto) Object.setPrototypeOf(obj, proto);
    return napi_ok;
  }
  // Create a live view into guest memory that acts like a Buffer.
  // Reads/writes go directly to kernel memory — no copy needed.
  _createGuestBuffer(guestPtr, length) {
    const self = this;
    // Return a Proxy around a Buffer that always reads from kernel memory
    const target = Buffer.alloc(0); // dummy for instanceof checks
    return new Proxy(target, {
      get(_, prop) {
        if (prop === Symbol.toPrimitive || prop === 'valueOf') return undefined;
        if (prop === 'length' || prop === 'byteLength') return length;
        if (prop === 'buffer') return self._getGuestArrayBuffer(guestPtr, length);
        if (prop === 'byteOffset') return 0;
        if (prop === '_guestPtr') return guestPtr;
        if (prop === '_isGuestBuffer') return true;

        // Snapshot current content for string/iteration operations
        const snap = () => {
          const base = self._guestBase();
          return Buffer.from(new Uint8Array(self._buf(), base + guestPtr, length));
        };

        if (prop === 'toString') return function(enc) { return snap().toString(enc); };
        if (prop === 'toJSON') return function() { return snap().toJSON(); };
        if (prop === 'slice') return function(s, e) { return snap().slice(s, e); };
        if (prop === 'copy') return function(...a) { return snap().copy(...a); };
        if (prop === 'equals') return function(b) { return snap().equals(b); };
        if (prop === 'compare') return function(b) { return snap().compare(b); };
        if (prop === 'write') return function(str, off, len, enc) {
          const b = Buffer.from(str, enc);
          const base = self._guestBase();
          const writeLen = Math.min(b.length, length - (off || 0));
          new Uint8Array(self._buf()).set(b.subarray(0, writeLen), base + guestPtr + (off || 0));
          return writeLen;
        };
        if (prop === Symbol.iterator) return function*() { const s = snap(); for (const b of s) yield b; };
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const idx = Number(prop);
          if (idx >= 0 && idx < length) {
            return new Uint8Array(self._buf())[self._guestBase() + guestPtr + idx];
          }
          return undefined;
        }
        // Fall through to Buffer prototype
        const snapBuf = snap();
        const v = snapBuf[prop];
        if (typeof v === 'function') return v.bind(snapBuf);
        return v;
      },
      set(_, prop, value) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const idx = Number(prop);
          if (idx >= 0 && idx < length) {
            new Uint8Array(self._buf())[self._guestBase() + guestPtr + idx] = value;
            return true;
          }
        }
        return true;
      },
      getPrototypeOf() { return Buffer.prototype; },
    });
  }

  _getGuestArrayBuffer(guestPtr, length) {
    // Return a snapshot ArrayBuffer (can't proxy ArrayBuffer easily)
    const base = this._guestBase();
    return new Uint8Array(this._buf(), base + guestPtr, length).buffer.slice(
      base + guestPtr, base + guestPtr + length
    );
  }

  // ===== Buffer API =====
  napi_create_buffer(args) {
    const [env, length, dataPtr, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    const guestPtr = length > 0 ? this.k.kernel_alloc(length) : 0;
    if (dataPtr) this._writeU32(dataPtr, guestPtr);
    const buf = this._createGuestBuffer(guestPtr, length);
    this._abMemory.set(buf, { address: guestPtr, ownership: 1, runtimeAllocated: 1 });
    const h = this._newHandle(buf);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }
  napi_create_buffer_copy(args) {
    const [env, length, dataGuestPtr, dataPtrOut, resultPtr] = args;
    const guestPtr = length > 0 ? this.k.kernel_alloc(length) : 0;
    if (guestPtr && dataGuestPtr) {
      // Copy source data to new allocation in guest memory
      const base = this._guestBase();
      const mem = new Uint8Array(this._buf());
      mem.copyWithin(base + guestPtr, base + dataGuestPtr, base + dataGuestPtr + length);
    }
    if (dataPtrOut) this._writeU32(dataPtrOut, guestPtr);
    const buf = this._createGuestBuffer(guestPtr, length);
    this._abMemory.set(buf, { address: guestPtr, ownership: 1, runtimeAllocated: 1 });
    const h = this._newHandle(buf);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }
  napi_create_external_buffer(args) {
    const [env, length, dataPtr, finalizeCb, finalizeHint, resultPtr] = args;
    const buf = this._createGuestBuffer(dataPtr, length);
    this._registerFinalizer(buf, finalizeCb, dataPtr, finalizeHint);
    this._abMemory.set(buf, { address: dataPtr, ownership: 1, runtimeAllocated: 0 });
    const h = this._newHandle(buf);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }
  napi_get_buffer_info(args) {
    const [env, valueHandle, dataPtr, lengthPtr] = args;
    const val = this._getHandle(valueHandle);
    if (!Buffer.isBuffer(val) && !val?._isGuestBuffer) return napi_invalid_arg;
    const info = this._abMemory.get(val);
    if (dataPtr) this._writeU32(dataPtr, info?.address ?? 0);
    if (lengthPtr) this._writeU32(lengthPtr, val?.length ?? val?.byteLength ?? 0);
    return napi_ok;
  }
  napi_is_buffer(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    const is = Buffer.isBuffer(val) || val?._isGuestBuffer === true;
    this._writeBool(resultPtr, is);
    return napi_ok;
  }
  node_api_create_buffer_from_arraybuffer(args) {
    const [env, abHandle, byteOffset, length, resultPtr] = args;
    const ab = this._getHandle(abHandle);
    const buf = Buffer.from(ab, byteOffset, length);
    const h = this._newHandle(buf);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // ===== SharedArrayBuffer =====
  node_api_create_sharedarraybuffer(args) {
    const [env, byteLength, dataPtr, resultPtr] = args;
    const sab = new SharedArrayBuffer(byteLength);
    if (dataPtr) this._writeU32(dataPtr, 0);
    const h = this._newHandle(sab);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // ===== Cleanup hooks =====
  napi_add_env_cleanup_hook(args) { return napi_ok; }
  napi_remove_env_cleanup_hook(args) { return napi_ok; }

  // ===== Fatal exception =====
  napi_fatal_exception(args) {
    const [env, errorHandle] = args;
    const err = this._getHandle(errorHandle);
    console.error('FATAL EXCEPTION:', err);
    return napi_ok;
  }

  // ===== Filename =====
  node_api_get_module_file_name(args) {
    const [env, resultPtr] = args;
    // Return empty string handle
    const h = this._newHandle("");
    this._writeU32(resultPtr, h);
    return napi_ok;
  }

  // ===== External strings =====
  node_api_create_external_string_latin1(args) {
    const [env, strPtr, length, finalizeCb, finalizeHint, resultPtr, copiedPtr] = args;
    const str = length === 0xFFFFFFFF ? this._readNullTermString(strPtr) : this._readString(strPtr, length);
    const h = this._newHandle(str);
    this._writeResult(resultPtr, h);
    if (copiedPtr) this._writeU32(copiedPtr, 1); // we always copy
    return napi_ok;
  }
  node_api_create_external_string_utf16(args) {
    const [env, strPtr, length, finalizeCb, finalizeHint, resultPtr, copiedPtr] = args;
    const base = this._guestBase();
    let str = '';
    const actualLen = length === 0xFFFFFFFF ? -1 : length;
    if (actualLen === -1) {
      let i = 0;
      while (true) {
        const ch = new DataView(this._buf()).getUint16(base + strPtr + i * 2, true);
        if (ch === 0) break;
        str += String.fromCharCode(ch);
        i++;
      }
    } else {
      for (let i = 0; i < actualLen; i++) {
        str += String.fromCharCode(new DataView(this._buf()).getUint16(base + strPtr + i * 2, true));
      }
    }
    const h = this._newHandle(str);
    this._writeResult(resultPtr, h);
    if (copiedPtr) this._writeU32(copiedPtr, 1);
    return napi_ok;
  }

  // ===== Property key creation =====
  node_api_create_property_key_latin1(args) {
    return this.napi_create_string_latin1(args);
  }
  node_api_create_property_key_utf8(args) {
    return this.napi_create_string_utf8(args);
  }
  node_api_create_property_key_utf16(args) {
    return this.napi_create_string_utf16(args);
  }

  node_api_create_object_with_properties(args) {
    // (env, proto, names_array, values_array, count, result)
    const [env, protoHandle, namesPtr, valuesPtr, count, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    const obj = {};
    if (protoHandle) {
      const proto = this._getHandle(protoHandle);
      if (proto) Object.setPrototypeOf(obj, proto);
    }
    // Read name/value pairs from guest arrays
    for (let i = 0; i < count; i++) {
      const nameHandle = this._readU32(namesPtr + i * 4);
      const valueHandle = this._readU32(valuesPtr + i * 4);
      const name = this._getHandle(nameHandle);
      const value = this._getHandle(valueHandle);
      if (name != null) obj[name] = value;
    }
    const h = this._newHandle(obj);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }
  node_api_post_finalizer(args) {
    const [env, cb, data, hint] = args;
    if (cb) {
      // Queue the callback — will be drained on next dispatch
      this._postedFinalizers.push({ cb, data, hint });
      this._postedFinalizersPending = true;
    }
    return napi_ok;
  }
  node_api_is_sharedarraybuffer(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    this._writeBool(resultPtr, val instanceof SharedArrayBuffer);
    return napi_ok;
  }
  // init_test_null — test helper, no-op
  init_test_null(args) { return napi_ok; }

  // napi_create_external_arraybuffer(env, data, byte_length, finalize_cb, finalize_hint, result)
  napi_create_external_arraybuffer(args) {
    const [env, dataPtr, byteLength, finalizeCb, finalizeHint, resultPtr] = args;
    const ab = new ArrayBuffer(byteLength);
    this._registerFinalizer(ab, finalizeCb, dataPtr, finalizeHint);
    const h = this._newHandle(ab);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_detach_arraybuffer(env, arraybuffer)
  napi_detach_arraybuffer(args) {
    // Can't truly detach in our bridge, but mark it
    return napi_ok;
  }

  // napi_get_dataview_info(env, dataview, byte_length, data, arraybuffer, byte_offset)
  napi_get_dataview_info(args) {
    const [env, valueHandle, byteLengthPtr, dataPtr, abPtr, byteOffsetPtr] = args;
    const val = this._getHandle(valueHandle);
    if (byteLengthPtr) this._writeU32(byteLengthPtr, val?.byteLength ?? 0);
    if (dataPtr) this._writeU32(dataPtr, 0); // data ptr not meaningful
    if (abPtr) { const h = this._newHandle(val?.buffer); this._writeU32(abPtr, h); }
    if (byteOffsetPtr) this._writeU32(byteOffsetPtr, val?.byteOffset ?? 0);
    return napi_ok;
  }

  // napi_get_value_external(env, value, result) — already exists but ensure it works
  // (already defined above)

  // napi_is_detached_arraybuffer(env, value, result)
  napi_is_detached_arraybuffer(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    // Check if detached by trying to access byteLength
    let detached = false;
    try {
      if (val instanceof ArrayBuffer && val.byteLength === 0 && val._detached) detached = true;
    } catch { detached = true; }
    this._writeBool(resultPtr, detached);
    return napi_ok;
  }

  // emnapi-specific functions
  emnapi_is_support_weakref(args) { return 0; } // no WeakRef support
  emnapi_get_memory_address(args) {
    // (env, arraybuffer_or_view, address_out, ownership_out, runtime_allocated_out)
    const [env, valueHandle, addressPtr, ownershipPtr, runtimeAllocatedPtr] = args;
    const val = this._getHandle(valueHandle);
    // Look up tracked ArrayBuffer memory
    const ab = val instanceof ArrayBuffer ? val : val?.buffer;
    const info = ab ? this._abMemory.get(ab) : null;
    if (addressPtr) this._writeU32(addressPtr, info?.address ?? 0);
    if (ownershipPtr) this._writeU32(ownershipPtr, info?.ownership ?? 1);
    if (runtimeAllocatedPtr) {
      const base = this._guestBase();
      new Uint8Array(this._buf())[base + runtimeAllocatedPtr] = info?.runtimeAllocated ?? 0;
    }
    return napi_ok;
  }
  emnapi_sync_memory(args) { return napi_ok; }

  // napi_get_value_string_utf16(env, value, buf, bufsize, result)
  napi_get_value_string_utf16(args) {
    const [env, valueHandle, bufPtr, bufSize, resultPtr] = args;
    if (!valueHandle) return napi_invalid_arg;
    const v = this._getHandle(valueHandle);
    if (typeof v !== 'string') return napi_string_expected;
    if (!bufPtr && !resultPtr) return napi_invalid_arg;
    const val = v;
    // UTF-16 encoding
    if (bufPtr && bufSize > 0) {
      const base = this._guestBase();
      const maxChars = bufSize - 1; // leave room for null terminator
      const writeLen = Math.min(val.length, maxChars);
      for (let i = 0; i < writeLen; i++) {
        new DataView(this._buf()).setUint16(base + bufPtr + i * 2, val.charCodeAt(i), true);
      }
      // null terminate
      new DataView(this._buf()).setUint16(base + bufPtr + writeLen * 2, 0, true);
    }
    if (resultPtr) this._writeU32(resultPtr, val.length);
    return napi_ok;
  }

  // napi_get_value_string_latin1(env, value, buf, bufsize, result)
  napi_get_value_string_latin1(args) {
    const [env, valueHandle, bufPtr, bufSize, resultPtr] = args;
    if (!valueHandle) return napi_invalid_arg;
    const v = this._getHandle(valueHandle);
    if (typeof v !== 'string') return napi_string_expected;
    if (!bufPtr && !resultPtr) return napi_invalid_arg;
    const val = v;
    if (bufPtr && bufSize > 0) {
      const base = this._guestBase();
      const writeLen = Math.min(val.length, bufSize - 1);
      const mem = new Uint8Array(this._buf());
      for (let i = 0; i < writeLen; i++) {
        mem[base + bufPtr + i] = val.charCodeAt(i) & 0xFF;
      }
      mem[base + bufPtr + writeLen] = 0;
    }
    if (resultPtr) this._writeU32(resultPtr, val.length);
    return napi_ok;
  }

  // napi_create_string_utf16(env, str_ptr, len, result)
  napi_create_string_utf16(args) {
    const [env, strPtr, len, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    const base = this._guestBase();
    const actualLen = len === 0xFFFFFFFF ? -1 : len;
    let str = '';
    if (actualLen === -1) {
      // null-terminated UTF-16
      let i = 0;
      while (true) {
        const ch = new DataView(this._buf()).getUint16(base + strPtr + i * 2, true);
        if (ch === 0) break;
        str += String.fromCharCode(ch);
        i++;
      }
    } else {
      for (let i = 0; i < actualLen; i++) {
        str += String.fromCharCode(new DataView(this._buf()).getUint16(base + strPtr + i * 2, true));
      }
    }
    const h = this._newHandle(str);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_get_value_external returns data ptr from external objects
  napi_check_object_type_tag(args) {
    const [env, objectHandle, typeTagPtr, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    let matches = false;
    if (obj && obj._typeTagLo !== undefined && typeTagPtr) {
      // Compare 128-bit tag values (lo + hi u64)
      const base = this._guestBase();
      const dv = new DataView(this._buf());
      const lo = dv.getBigUint64(base + typeTagPtr, true);
      const hi = dv.getBigUint64(base + typeTagPtr + 8, true);
      matches = obj._typeTagLo === lo && obj._typeTagHi === hi;
    }
    this._writeBool(resultPtr, matches);
    return napi_ok;
  }
  napi_type_tag_object(args) {
    const [env, objectHandle, typeTagPtr] = args;
    const obj = this._getHandle(objectHandle);
    if (obj && typeof obj === 'object' && typeTagPtr) {
      const base = this._guestBase();
      const dv = new DataView(this._buf());
      obj._typeTagLo = dv.getBigUint64(base + typeTagPtr, true);
      obj._typeTagHi = dv.getBigUint64(base + typeTagPtr + 8, true);
    }
    return napi_ok;
  }

  // napi_get_value_bigint_words(env, value, sign_bit, word_count, words)
  napi_get_value_bigint_words(args) {
    const [env, valueHandle, signBitPtr, wordCountPtr, wordsPtr] = args;
    const val = this._getHandle(valueHandle);
    const n = typeof val === 'bigint' ? val : 0n;
    const negative = n < 0n ? 1 : 0;
    const abs = n < 0n ? -n : n;
    // Convert to 64-bit words
    const words = [];
    let remaining = abs;
    while (remaining > 0n) {
      words.push(remaining & 0xFFFFFFFFFFFFFFFFn);
      remaining >>= 64n;
    }
    if (words.length === 0) words.push(0n);

    if (signBitPtr) this._writeU32(signBitPtr, negative);
    const maxWords = wordCountPtr ? this._readU32(wordCountPtr) : 0;
    if (wordCountPtr) this._writeU32(wordCountPtr, words.length);
    if (wordsPtr) {
      const base = this._guestBase();
      for (let i = 0; i < Math.min(words.length, maxWords); i++) {
        new DataView(this._buf()).setBigUint64(base + wordsPtr + i * 8, words[i], true);
      }
    }
    return napi_ok;
  }

  // napi_create_bigint_words(env, sign_bit, word_count, words, result)
  napi_create_bigint_words(args) {
    const [env, signBit, wordCount, wordsPtr, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    let val = 0n;
    const base = this._guestBase();
    for (let i = 0; i < wordCount; i++) {
      const word = new DataView(this._buf()).getBigUint64(base + wordsPtr + i * 8, true);
      val += word << (BigInt(i) * 64n);
    }
    if (signBit) val = -val;
    const h = this._newHandle(val);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // ===== Shared property descriptor parser =====
  _applyPropertyDescriptors(target, propCount, propsPtr) {
    const PROP_SIZE = 32;
    for (let i = 0; i < propCount; i++) {
      const base = propsPtr + i * PROP_SIZE;
      const utf8namePtr = this._readU32(base + 0);
      const nameHandle = this._readU32(base + 4);
      const methodCb = this._readU32(base + 8);
      const getterCb = this._readU32(base + 12);
      const setterCb = this._readU32(base + 16);
      const valueHandle = this._readU32(base + 20);
      const attributes = this._readU32(base + 24);
      const propData = this._readU32(base + 28);

      let propName = '';
      if (utf8namePtr) {
        propName = this._readNullTermString(utf8namePtr);
      } else if (nameHandle) {
        const nameVal = this._getHandle(nameHandle);
        propName = typeof nameVal === 'symbol' ? nameVal : String(nameVal);
      }
      if (!propName) continue;

      // napi_property_attributes: writable=1, enumerable=2, configurable=4
      const writable = !!(attributes & 1);
      const enumerable = !!(attributes & 2);
      const configurable = !!(attributes & 4);

      if (methodCb) {
        const fn = this._makeCallbackFunction(methodCb, propData);
        Object.defineProperty(target, propName, {
          value: fn, writable, enumerable, configurable,
        });
      } else if (getterCb || setterCb) {
        const desc = { enumerable, configurable };
        if (getterCb) desc.get = this._makeCallbackFunction(getterCb, propData);
        if (setterCb) desc.set = this._makeCallbackFunction(setterCb, propData);
        Object.defineProperty(target, propName, desc);
      } else if (valueHandle) {
        Object.defineProperty(target, propName, {
          value: this._getHandle(valueHandle), writable, enumerable, configurable,
        });
      }
    }
  }

  // napi_define_properties(env, object, property_count, properties)
  napi_define_properties(args) {
    const [env, objectHandle, propCount, propsPtr] = args;
    const obj = this._getHandle(objectHandle);
    if (!obj || typeof obj !== 'object' && typeof obj !== 'function') return napi_object_expected;
    this._applyPropertyDescriptors(obj, propCount, propsPtr);
    return napi_ok;
  }

  // napi_new_instance(env, constructor, argc, argv, result)
  napi_new_instance(args) {
    const [env, ctorHandle, argc, argvPtr, resultPtr] = args;
    const Ctor = this._getHandle(ctorHandle);
    const ctorArgs = [];
    for (let i = 0; i < argc; i++) {
      ctorArgs.push(this._getHandle(this._readU32(argvPtr + i * 4)));
    }
    try {
      const instance = new Ctor(...ctorArgs);
      const h = this._newHandle(instance);
      this._writeResult(resultPtr, h);
    } catch (e) {
      this.lastException = e;
      this.exceptionPending = true;
      return napi_pending_exception;
    }
    return napi_ok;
  }

  // napi_coerce_to_bool(env, value, result)
  napi_coerce_to_bool(args) {
    const [env, valueHandle, resultPtr] = args;
    if (!valueHandle || !resultPtr) return napi_invalid_arg;
    const val = this._getHandle(valueHandle);
    const h = this._newHandle(!!val);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_coerce_to_number(env, value, result)
  napi_coerce_to_number(args) {
    const [env, valueHandle, resultPtr] = args;
    if (!valueHandle || !resultPtr) return napi_invalid_arg;
    const val = this._getHandle(valueHandle);
    try {
      const h = this._newHandle(Number(val));
      this._writeResult(resultPtr, h);
    } catch (e) {
      this.lastException = e;
      this.exceptionPending = true;
      return napi_pending_exception;
    }
    return napi_ok;
  }

  // napi_create_type_error(env, code, msg, result)
  napi_create_type_error(args) {
    const [env, codeHandle, msgHandle, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    const msg = this._getHandle(msgHandle);
    const err = new TypeError(typeof msg === 'string' ? msg : String(msg));
    if (codeHandle) { const code = this._getHandle(codeHandle); if (code) err.code = code; }
    const h = this._newHandle(err);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_create_range_error(env, code, msg, result)
  napi_create_range_error(args) {
    const [env, codeHandle, msgHandle, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    const msg = this._getHandle(msgHandle);
    const err = new RangeError(typeof msg === 'string' ? msg : String(msg));
    if (codeHandle) { const code = this._getHandle(codeHandle); if (code) err.code = code; }
    const h = this._newHandle(err);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_throw_type_error(env, code, msg)
  napi_throw_type_error(args) {
    const [env, codePtr, msgPtr] = args;
    const code = codePtr ? this._readNullTermString(codePtr) : '';
    const msg = msgPtr ? this._readNullTermString(msgPtr) : '';
    this.lastException = new TypeError(msg);
    if (code) this.lastException.code = code;
    this.exceptionPending = true;
    return napi_ok;
  }

  // napi_throw_range_error(env, code, msg)
  napi_throw_range_error(args) {
    const [env, codePtr, msgPtr] = args;
    const code = codePtr ? this._readNullTermString(codePtr) : '';
    const msg = msgPtr ? this._readNullTermString(msgPtr) : '';
    this.lastException = new RangeError(msg);
    if (code) this.lastException.code = code;
    this.exceptionPending = true;
    return napi_ok;
  }

  // napi_throw_syntax_error(env, code, msg)
  napi_throw_syntax_error(args) {
    const [env, codePtr, msgPtr] = args;
    const code = codePtr ? this._readNullTermString(codePtr) : '';
    const msg = msgPtr ? this._readNullTermString(msgPtr) : '';
    this.lastException = new SyntaxError(msg);
    if (code) this.lastException.code = code;
    this.exceptionPending = true;
    return napi_ok;
  }

  // napi_create_syntax_error(env, code, msg, result)
  napi_create_syntax_error(args) {
    const [env, codeHandle, msgHandle, resultPtr] = args;
    const msg = this._getHandle(msgHandle);
    const err = new SyntaxError(typeof msg === 'string' ? msg : String(msg));
    if (codeHandle) { const code = this._getHandle(codeHandle); if (code) err.code = code; }
    const h = this._newHandle(err);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_create_array(env, result)
  napi_create_array(args) {
    const [env, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    const h = this._newHandle([]);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_has_element(env, object, index, result)
  napi_has_element(args) {
    const [env, objectHandle, index, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    this._writeBool(resultPtr, obj && index in obj);
    return napi_ok;
  }

  // napi_delete_element(env, object, index, result) — result is bool* (1 byte)
  napi_delete_element(args) {
    const [env, objectHandle, index, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    let ok = false;
    if (obj) {
      try { ok = delete obj[index]; }
      catch { ok = false; }
    }
    if (resultPtr) this._writeBool(resultPtr, ok);
    return napi_ok;
  }

  // napi_delete_property(env, object, key, result)
  napi_delete_property(args) {
    const [env, objectHandle, keyHandle, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    const key = this._getHandle(keyHandle);
    let ok = false;
    if (obj) {
      try { ok = delete obj[key]; }
      catch { ok = false; } // strict mode throws for non-configurable
    }
    if (resultPtr) this._writeBool(resultPtr, ok);
    return napi_ok;
  }

  // napi_has_own_property(env, object, key, result)
  napi_has_own_property(args) {
    const [env, objectHandle, keyHandle, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    const key = this._getHandle(keyHandle);
    if (typeof key !== 'string' && typeof key !== 'symbol') return napi_name_expected;
    const has = obj && Object.prototype.hasOwnProperty.call(obj, key);
    this._writeBool(resultPtr, has);
    return napi_ok;
  }

  // napi_create_external(env, data, finalize_cb, finalize_hint, result)
  napi_create_external(args) {
    const [env, dataPtr, finalizeCb, finalizeHint, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    const ext = { __external: true, data: dataPtr };
    this._registerFinalizer(ext, finalizeCb, dataPtr, finalizeHint);
    const h = this._newHandle(ext);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_get_value_external(env, value, result)
  napi_get_value_external(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    this._writeU32(resultPtr, val?.__external ? val.data : 0);
    return napi_ok;
  }

  // napi_instanceof(env, object, constructor, result)
  napi_instanceof(args) {
    const [env, objectHandle, ctorHandle, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    const ctor = this._getHandle(ctorHandle);
    let result = false;
    try { result = obj instanceof ctor; } catch {}
    this._writeBool(resultPtr, result);
    return napi_ok;
  }

  // napi_get_prototype(env, object, result)
  napi_get_prototype(args) {
    const [env, objectHandle, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    const proto = Object.getPrototypeOf(obj);
    const h = this._newHandle(proto);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_get_property_names(env, object, result)
  napi_get_property_names(args) {
    const [env, objectHandle, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    const names = Object.keys(obj ?? {});
    const arr = names.map(n => n);
    const h = this._newHandle(arr);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_get_all_property_names(env, object, key_mode, key_filter, key_conversion, result)
  napi_get_all_property_names(args) {
    const [env, objectHandle, keyMode, keyFilter, keyConversion, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    // Simplified: return own enumerable string keys
    const names = obj ? Object.keys(obj) : [];
    const h = this._newHandle(names);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_create_symbol(env, description, result)
  napi_create_symbol(args) {
    const [env, descHandle, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    const desc = descHandle ? this._getHandle(descHandle) : undefined;
    const sym = Symbol(desc);
    const h = this._newHandle(sym);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_get_version(env, result)
  napi_get_version(args) {
    const [env, resultPtr] = args;
    this._writeU32(resultPtr, 10); // napi version 10
    return napi_ok;
  }

  // napi_get_new_target(env, cbinfo, result)
  napi_get_new_target(args) {
    const [env, cbInfo, resultPtr] = args;
    const info = this.cbInfoStack.find(i => i.id === cbInfo) || this.cbInfoStack[this.cbInfoStack.length - 1];
    const newTarget = info?.newTarget || 0;
    this._writeResult(resultPtr, newTarget); // 0 = NULL when not called with new
    return napi_ok;
  }

  // napi_create_promise(env, deferred, result)
  napi_create_promise(args) {
    const [env, deferredPtr, resultPtr] = args;
    if (!deferredPtr) return napi_invalid_arg;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const deferredId = this.nextRef++;
    this.refs.set(deferredId, { resolve, reject });
    this._writeU32(deferredPtr, deferredId);
    const h = this._newHandle(promise);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_resolve_deferred(env, deferred, value)
  napi_resolve_deferred(args) {
    const [env, deferredId, valueHandle] = args;
    const d = this.refs.get(deferredId);
    if (d?.resolve) { d.resolve(this._getHandle(valueHandle)); this.refs.delete(deferredId); }
    return napi_ok;
  }

  // napi_reject_deferred(env, deferred, value)
  napi_reject_deferred(args) {
    const [env, deferredId, valueHandle] = args;
    const d = this.refs.get(deferredId);
    if (d?.reject) { d.reject(this._getHandle(valueHandle)); this.refs.delete(deferredId); }
    return napi_ok;
  }

  // napi_is_promise(env, value, result)
  napi_is_promise(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    this._writeBool(resultPtr, val instanceof Promise);
    return napi_ok;
  }

  // napi_object_freeze(env, object)
  napi_object_freeze(args) {
    const [env, objectHandle] = args;
    const obj = this._getHandle(objectHandle);
    if (obj) Object.freeze(obj);
    return napi_ok;
  }

  // napi_object_seal(env, object)
  napi_object_seal(args) {
    const [env, objectHandle] = args;
    const obj = this._getHandle(objectHandle);
    if (obj) Object.seal(obj);
    return napi_ok;
  }

  // napi_reference_ref(env, ref, result)
  napi_reference_ref(args) {
    const [env, refId, resultPtr] = args;
    const ref = this.refs.get(refId);
    if (ref && ref.refcount !== undefined) ref.refcount++;
    if (resultPtr) this._writeU32(resultPtr, ref?.refcount ?? 0);
    return napi_ok;
  }

  // napi_remove_wrap(env, object, result)
  napi_remove_wrap(args) {
    const [env, objectHandle, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    const ptr = (obj && typeof obj === 'object') ? (this.wraps.get(obj) ?? 0) : 0;
    if (obj && typeof obj === 'object') this.wraps.delete(obj);
    if (resultPtr) this._writeU32(resultPtr, ptr);
    return napi_ok;
  }

  // Handle scopes — track escapable scopes to detect double-escape
  _nextScopeId = 1;
  napi_open_handle_scope(args) {
    const [env, resultPtr] = args;
    if (this.exceptionPending) return napi_pending_exception;
    this._writeU32(resultPtr, 0);
    return napi_ok;
  }
  napi_close_handle_scope(args) { return napi_ok; }
  napi_open_escapable_handle_scope(args) {
    const [env, resultPtr] = args;
    const scopeId = this._nextScopeId++;
    this._writeU32(resultPtr, scopeId);
    return napi_ok;
  }
  napi_close_escapable_handle_scope(args) {
    const [env, scope] = args;
    this._escapedScopes.delete(scope);
    return napi_ok;
  }
  napi_escape_handle(args) {
    const [env, scope, escapee, resultPtr] = args;
    if (this._escapedScopes.has(scope)) {
      return napi_escape_called_twice;
    }
    this._escapedScopes.add(scope);
    this._escapedHandleIds.add(escapee); // survive scope cleanup
    this._writeResult(resultPtr, escapee);
    return napi_ok;
  }

  // napi_create_date(env, time: f64, result) — sig: (iFi)i
  napi_create_date(args) {
    const time = this._readArgF64(this._currentArgsPtr, 1);
    const resultPtr = args[2];
    if (!resultPtr) return napi_invalid_arg;
    const h = this._newHandle(new Date(time));
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_is_date(env, value, result)
  napi_is_date(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    this._writeBool(resultPtr, val instanceof Date);
    return napi_ok;
  }

  // napi_get_date_value(env, value, result)
  napi_get_date_value(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    const base = this._guestBase();
    new DataView(this._buf()).setFloat64(base + resultPtr, val instanceof Date ? val.getTime() : 0, true);
    return napi_ok;
  }

  // napi_get_node_version(env, result) — writes to a struct pointer
  napi_get_node_version(args) {
    const [env, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    // Allocate struct in guest memory (16 bytes: major, minor, patch, release_ptr)
    if (!this._nodeVersionPtr) {
      this._nodeVersionPtr = this.k.kernel_alloc(16);
      const parts = (typeof process !== 'undefined' ? process.version : 'v0.0.0').replace('v','').split('-')[0].split('.');
      const sp = this._nodeVersionPtr;
      this._writeU32(sp, parseInt(parts[0]) || 0);
      this._writeU32(sp + 4, parseInt(parts[1]) || 0);
      this._writeU32(sp + 8, parseInt(parts[2]) || 0);
      const rel = typeof process !== 'undefined' ? (process.release?.name ?? 'node') : 'node';
      const rp = this.k.kernel_alloc(rel.length + 1);
      const base = this._guestBase();
      const mem = new Uint8Array(this._buf());
      for (let i = 0; i < rel.length; i++) mem[base + rp + i] = rel.charCodeAt(i);
      mem[base + rp + rel.length] = 0;
      this._writeU32(sp + 12, rp);
    }
    // Write pointer-to-struct at resultPtr
    this._writeU32(resultPtr, this._nodeVersionPtr);
    return napi_ok;
  }

  // napi_get_instance_data / napi_set_instance_data — simple storage
  _instanceData = null;
  napi_set_instance_data(args) {
    const [env, data, finalizeCb, finalizeHint] = args;
    this._instanceData = data;
    return napi_ok;
  }
  napi_get_instance_data(args) {
    const [env, resultPtr] = args;
    this._writeU32(resultPtr, this._instanceData ?? 0);
    return napi_ok;
  }

  // napi_add_finalizer(env, object, data, finalize_cb, hint, result)
  napi_add_finalizer(args) {
    const [env, objectHandle, dataPtr, finalizeCb, finalizeHint, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    if (obj && typeof obj === 'object') {
      this._registerFinalizer(obj, finalizeCb, dataPtr, finalizeHint);
    }
    if (resultPtr) {
      const refId = this.nextRef++;
      this.refs.set(refId, { handle: objectHandle, refcount: 0 });
      this._writeU32(resultPtr, refId);
    }
    return napi_ok;
  }

  // ===== Async work =====
  _asyncWorks = new Map();
  _nextAsyncId = 1;
  _pendingAsyncQueue = []; // deferred work to run after current call returns

  // napi_create_async_work(env, async_resource, async_resource_name, execute, complete, data, result)
  napi_create_async_work(args) {
    const [env, asyncResource, asyncResourceName, executeCb, completeCb, dataPtr, resultPtr] = args;
    const id = this._nextAsyncId++;
    this._asyncWorks.set(id, { executeCb, completeCb, dataPtr, status: 0 });
    this._writeU32(resultPtr, id);
    return napi_ok;
  }

  // napi_queue_async_work(env, work)
  napi_queue_async_work(args) {
    const [env, workId] = args;
    const work = this._asyncWorks.get(workId);
    if (!work) return napi_generic_failure;
    // Defer execution — can't re-enter kernel_call_indirect
    this._pendingAsyncQueue.push({ type: 'execute', work });
    return napi_ok;
  }

  // napi_cancel_async_work(env, work)
  napi_cancel_async_work(args) {
    const [env, workId] = args;
    const work = this._asyncWorks.get(workId);
    if (!work) return napi_generic_failure;
    work.status = 10; // napi_cancelled
    // Remove from pending queue if not yet started
    this._pendingAsyncQueue = this._pendingAsyncQueue.filter(
      item => item.work !== work || item.type !== 'execute'
    );
    // Queue the Complete callback with cancelled status
    this._pendingAsyncQueue.push({ type: 'complete', work });
    return napi_ok;
  }

  // Called by the host after each top-level kernel_call_indirect returns
  drainAsyncQueue() {
    while (this._pendingAsyncQueue.length > 0) {
      const item = this._pendingAsyncQueue.shift();
      const work = item.work;

      if (item.type === 'execute') {
        if (work.executeCb) {
          try {
            const ap = this.k.kernel_alloc(16);
            new DataView(this._buf()).setUint32(ap, 1, true);
            new DataView(this._buf()).setUint32(ap + 4, work.dataPtr, true);
            this.k.kernel_call_indirect(work.executeCb, 2, ap);
          } catch (e) { /* Execute may trap (e.g. sleep) — that's OK */ }
        }
        this._pendingAsyncQueue.push({ type: 'complete', work });
      } else if (item.type === 'complete') {
        if (work.completeCb) {
          try {
            const ap = this.k.kernel_alloc(16);
            new DataView(this._buf()).setUint32(ap, 1, true);
            new DataView(this._buf()).setUint32(ap + 4, work.status, true);
            new DataView(this._buf()).setUint32(ap + 8, work.dataPtr, true);
            this.k.kernel_call_indirect(work.completeCb, 3, ap);
          } catch (e) { /* Complete failed */ }
        }
      }
    }
  }

  // napi_delete_async_work(env, work)
  napi_delete_async_work(args) {
    const [env, workId] = args;
    this._asyncWorks.delete(workId);
    return napi_ok;
  }

  // napi_async_init/destroy — just track context IDs
  _nextAsyncContextId = 1;
  napi_async_init(args) {
    const [env, asyncResource, asyncResourceName, resultPtr] = args;
    this._writeU32(resultPtr, this._nextAsyncContextId++);
    return napi_ok;
  }
  napi_async_destroy(args) { return napi_ok; }

  // napi_make_callback(env, async_context, recv, func, argc, argv, result)
  napi_make_callback(args) {
    // Skip async_context, delegate to napi_call_function
    const [env, _asyncCtx, recvHandle, funcHandle, argc, argvPtr, resultPtr] = args;
    return this.napi_call_function([env, recvHandle, funcHandle, argc, argvPtr, resultPtr]);
  }

  // Threadsafe functions — enhanced implementation
  napi_acquire_threadsafe_function(args) { return napi_ok; }
  napi_get_threadsafe_function_context(args) {
    const [env, tsfnHandle, resultPtr] = args;
    const tsf = this._getHandle(tsfnHandle);
    this._writeU32(resultPtr, tsf?.context ?? 0);
    return napi_ok;
  }
  napi_call_threadsafe_function(args) {
    const [env, tsfnHandle, dataPtr, mode] = args;
    const tsf = this._getHandle(tsfnHandle);
    if (!tsf) return napi_generic_failure;
    // Call the JS callback if set, or invoke callJsCb
    if (tsf.callJsCb) {
      const argvPtr = this.k.kernel_alloc(16);
      new DataView(this._buf()).setUint32(argvPtr, 1, true);        // env
      new DataView(this._buf()).setUint32(argvPtr + 4, tsf.funcHandle, true); // js_callback
      new DataView(this._buf()).setUint32(argvPtr + 8, tsf.context, true);    // context
      new DataView(this._buf()).setUint32(argvPtr + 12, dataPtr, true);       // data
      this.k.kernel_call_indirect(tsf.callJsCb, 4, argvPtr);
    }
    return napi_ok;
  }
  napi_release_threadsafe_function(args) { return napi_ok; }

  // Cleanup hooks
  napi_add_async_cleanup_hook(args) {
    const [env, hookCb, dataPtr, resultPtr] = args;
    if (resultPtr) this._writeU32(resultPtr, 0);
    return napi_ok;
  }
  napi_remove_async_cleanup_hook(args) { return napi_ok; }

  // napi_get_uv_event_loop — not applicable, return 0
  napi_get_uv_event_loop(args) {
    const [env, resultPtr] = args;
    this._writeU32(resultPtr, 0);
    return napi_ok;
  }

  // napi_fatal_error — print and abort
  napi_fatal_error(args) {
    const [locationPtr, locationLen, messagePtr, messageLen] = args;
    const loc = locationLen === 0xFFFFFFFF ? this._readNullTermString(locationPtr) : this._readString(locationPtr, locationLen);
    const msg = messageLen === 0xFFFFFFFF ? this._readNullTermString(messagePtr) : this._readString(messagePtr, messageLen);
    console.error(`FATAL: ${loc}: ${msg}`);
    return napi_ok;
  }

  // napi_adjust_external_memory — no-op
  napi_adjust_external_memory(args) { return napi_ok; }

  // napi_run_script(env, script, result) — eval a JS string
  napi_run_script(args) {
    const [env, scriptHandle, resultPtr] = args;
    const code = this._getHandle(scriptHandle);
    try {
      const result = eval(String(code));
      const h = this._newHandle(result);
      this._writeResult(resultPtr, h);
    } catch (e) {
      this.lastException = e;
      this.exceptionPending = true;
      return napi_pending_exception;
    }
    return napi_ok;
  }

  // ===== TypedArray / ArrayBuffer / Buffer =====
  // Track ArrayBuffer → guest memory address mappings (like emnapi's emnapiExternalMemory)
  _abMemory = new WeakMap(); // ArrayBuffer → { address: guestPtr, ownership: 0|1, runtimeAllocated: bool }

  napi_create_arraybuffer(args) {
    const [env, byteLength, dataPtr, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    // Allocate in guest memory — use a snapshot ArrayBuffer for JS side
    const guestPtr = byteLength > 0 ? this.k.kernel_alloc(byteLength) : 0;
    // Zero-initialize
    if (guestPtr) {
      const base = this._guestBase();
      new Uint8Array(this._buf()).fill(0, base + guestPtr, base + guestPtr + byteLength);
    }
    const ab = new ArrayBuffer(byteLength);
    ab._guestPtr = guestPtr;
    ab._guestLength = byteLength;
    ab._kernel = this;
    this._abMemory.set(ab, { address: guestPtr, ownership: 1, runtimeAllocated: 1 });
    if (dataPtr) this._writeU32(dataPtr, guestPtr);
    const h = this._newHandle(ab);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_is_arraybuffer(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    this._writeBool(resultPtr, val instanceof ArrayBuffer);
    return napi_ok;
  }

  napi_get_arraybuffer_info(args) {
    const [env, valueHandle, dataPtr, lengthPtr] = args;
    const val = this._getHandle(valueHandle);
    if (val instanceof ArrayBuffer) {
      // Ensure this ArrayBuffer has a guest memory mapping
      if (!this._abMemory.has(val) && val.byteLength > 0) {
        const guestPtr = this.k.kernel_alloc(val.byteLength);
        // Copy JS ArrayBuffer content into guest memory
        const base = this._guestBase();
        new Uint8Array(this._buf()).set(new Uint8Array(val), base + guestPtr);
        this._abMemory.set(val, { address: guestPtr, ownership: 1, runtimeAllocated: 1 });
      }
      const info = this._abMemory.get(val);
      if (dataPtr) this._writeU32(dataPtr, info?.address ?? 0);
      if (lengthPtr) this._writeU32(lengthPtr, val.byteLength);
    } else {
      if (dataPtr) this._writeU32(dataPtr, 0);
      if (lengthPtr) this._writeU32(lengthPtr, 0);
    }
    return napi_ok;
  }

  napi_is_typedarray(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    this._writeBool(resultPtr, ArrayBuffer.isView(val) && !(val instanceof DataView));
    return napi_ok;
  }

  napi_create_typedarray(args) {
    const [env, type, length, abHandle, byteOffset, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    const ab = this._getHandle(abHandle);
    const ctors = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array];
    const Ctor = ctors[type] ?? Uint8Array;
    const ta = new Ctor(ab, byteOffset, length);
    const h = this._newHandle(ta);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_get_typedarray_info(args) {
    const [env, valueHandle, typePtr, lengthPtr, dataPtr, abPtr, offsetPtr] = args;
    const val = this._getHandle(valueHandle);
    if (typePtr) {
      const typeMap = { Int8Array: 0, Uint8Array: 1, Uint8ClampedArray: 2, Int16Array: 3, Uint16Array: 4, Int32Array: 5, Uint32Array: 6, Float32Array: 7, Float64Array: 8, BigInt64Array: 9, BigUint64Array: 10 };
      this._writeU32(typePtr, typeMap[val?.constructor?.name] ?? 1);
    }
    if (lengthPtr) this._writeU32(lengthPtr, val?.length ?? 0);
    if (dataPtr) this._writeU32(dataPtr, 0);
    if (abPtr) { const h = this._newHandle(val?.buffer); this._writeU32(abPtr, h); }
    if (offsetPtr) this._writeU32(offsetPtr, val?.byteOffset ?? 0);
    return napi_ok;
  }

  napi_is_dataview(args) {
    const [env, valueHandle, resultPtr] = args;
    const val = this._getHandle(valueHandle);
    this._writeBool(resultPtr, val instanceof DataView);
    return napi_ok;
  }

  napi_create_dataview(args) {
    const [env, byteLength, abHandle, byteOffset, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    const ab = this._getHandle(abHandle);
    try {
      const dv = new DataView(ab, byteOffset, byteLength);
      const h = this._newHandle(dv);
      this._writeResult(resultPtr, h);
    } catch (e) {
      this.lastException = e;
      this.exceptionPending = true;
      return napi_pending_exception;
    }
    return napi_ok;
  }

  // ===== BigInt =====
  napi_create_bigint_int64(args) {
    // sig: (iIi)i — value is i64
    const val = this._readArgI64(this._currentArgsPtr, 1);
    const resultPtr = args[2];
    if (!resultPtr) return napi_invalid_arg;
    const h = this._newHandle(val); // keep as BigInt
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_create_bigint_uint64(args) {
    // sig: (iIi)i — value is i64 (unsigned)
    const buf = this._buf();
    const lo = new DataView(buf).getUint32(this._currentArgsPtr + 8, true);
    const hi = new DataView(buf).getUint32(this._currentArgsPtr + 12, true);
    const val = BigInt(lo) + (BigInt(hi) << 32n);
    const resultPtr = args[2];
    if (!resultPtr) return napi_invalid_arg;
    const h = this._newHandle(val);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_get_value_bigint_int64(args) {
    const [env, valueHandle, resultPtr, losslessPtr] = args;
    const val = this._getHandle(valueHandle);
    const n = typeof val === 'bigint' ? val : 0n;
    // Write lossless FIRST (it's a bool = 1 byte, may be adjacent to the i64)
    if (losslessPtr) {
      const base = this._guestBase();
      new Uint8Array(this._buf())[base + losslessPtr] = 1;
    }
    // Then write the i64 value (8 bytes)
    this._writeI64(resultPtr, n);
    return napi_ok;
  }

  napi_get_value_bigint_uint64(args) {
    const [env, valueHandle, resultPtr, losslessPtr] = args;
    const val = this._getHandle(valueHandle);
    const n = typeof val === 'bigint' ? val : 0n;
    // Write lossless FIRST (bool = 1 byte, may be adjacent to u64)
    if (losslessPtr) {
      const lossless = n >= 0n && n <= 0xFFFFFFFFFFFFFFFFn ? 1 : 0;
      const base = this._guestBase();
      new Uint8Array(this._buf())[base + losslessPtr] = lossless;
    }
    // Then write the u64 value
    const base = this._guestBase();
    new DataView(this._buf()).setBigUint64(base + resultPtr, n < 0n ? 0n : n, true);
    return napi_ok;
  }

  // Read a raw f64 arg from the bridge args buffer (kernel memory, not guest memory)
  _readArgF64(argsPtr, index) {
    return new DataView(this._buf()).getFloat64(argsPtr + index * 8, true);
  }

  // Read a raw i64 arg from the bridge args buffer
  _readArgI64(argsPtr, index) {
    return new DataView(this._buf()).getBigInt64(argsPtr + index * 8, true);
  }

  // Dispatch: find the right method by function name
  dispatch(funcName, args, argsPtr) {
    this._currentArgsPtr = argsPtr;
    // Drain any queued GC finalizers
    if (this._postedFinalizersPending) this._drainFinalizers();
    // env=NULL check
    if (args[0] === 0 && funcName.startsWith('napi_') && funcName !== 'napi_fatal_error') {
      this._lastStatus = napi_invalid_arg;
      return BigInt(napi_invalid_arg);
    }
    const method = this[funcName];
    if (method) {
      const result = method.call(this, args);
      this._lastStatus = result; // track for napi_get_last_error_info
      if (this.debug) {
        console.error(`  napi: ${funcName}(${args.join(',')}) -> ${result}`);
      }
      return BigInt(result);
    }
    console.error(`napi: unimplemented ${funcName}`);
    this._lastStatus = napi_generic_failure;
    return BigInt(napi_generic_failure);
  }
}
