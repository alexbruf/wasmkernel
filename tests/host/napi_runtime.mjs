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

// Import async_hooks for proper async context support (Node.js only)
let AsyncResource = null;
try {
  AsyncResource = (await import('node:async_hooks')).AsyncResource;
} catch {}

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
      this._drainScheduled = false;
      this._postedFinalizersRegistry = new FinalizationRegistry((info) => {
        // info = { cb, env, data, hint }
        this._postedFinalizers.push(info);
        this._postedFinalizersPending = true;
        // Schedule async drain so GC tests work (gcUntil checks condition after setImmediate)
        if (!this._drainScheduled) {
          this._drainScheduled = true;
          Promise.resolve().then(() => {
            this._drainScheduled = false;
            this._drainFinalizers();
          });
        }
      });
    }

    // Pre-register env handle
    this.handles.set(1, { type: 'env' });

    // Pre-register global and undefined
    this.undefinedHandle = this._newHandle(undefined);
    this.globalHandle = this._newHandle(globalThis);
  }

  // Register a destructor callback for a JS object
  _registerFinalizer(jsObj, finalizeCb, dataPtr, hintPtr, envPtr) {
    if (this._postedFinalizersRegistry && finalizeCb) {
      // Track object→refs mapping so we can clear weak refs when finalizer fires
      if (!this._objToRefIds) this._objToRefIds = new WeakMap();
      const refIds = this._objToRefIds.get(jsObj) || [];
      this._objToRefIds.set(jsObj, refIds);
      this._postedFinalizersRegistry.register(jsObj, {
        cb: finalizeCb, env: envPtr || this._guestEnv || 1, data: dataPtr, hint: hintPtr,
        refIds, // shared array — refs added later will appear here
      });
    }
  }

  // Drain queued destructor callbacks (called from dispatch or async)
  _drainFinalizers() {
    if (this._drainingFinalizers) return; // prevent re-entrancy
    this._drainingFinalizers = true;
    while (this._postedFinalizers.length > 0) {
      const { cb, env: envPtr, data, hint, refIds } = this._postedFinalizers.shift();
      try {
        // Clear weak refs for this object so napi_get_reference_value returns NULL
        if (refIds) {
          for (const rid of refIds) {
            const ref = this.refs.get(rid);
            if (ref && ref.weak) ref.value = { deref() { return undefined; } }; // dead ref
          }
        }
        this._pushScope();
        const ap = this.k.kernel_alloc(12);
        const env2 = envPtr || this._guestEnv || 1;
        new DataView(this._buf()).setUint32(ap, env2, true);        // env
        new DataView(this._buf()).setUint32(ap + 4, data, true);   // finalize_data
        new DataView(this._buf()).setUint32(ap + 8, hint, true);   // finalize_hint
        this.k.kernel_call_indirect(cb, 3, ap);
        // If the finalizer's napi_call_function set an exception, propagate it
        // as uncaughtException (finalizers run outside normal call stacks)
        if (this.exceptionPending) {
          const exc = this.lastException;
          this.lastException = null;
          this.exceptionPending = false;
          this._popScope();
          // Schedule as uncaughtException so it doesn't break the drain loop
          if (exc) process.nextTick(() => { throw exc; });
          continue;
        }
        this._popScope();
      } catch { this._popScope(); }
    }
    this._postedFinalizersPending = false;
    this._drainingFinalizers = false;
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

  // Sync guest memory → JS ArrayBuffer (call before JS reads AB content)
  _syncGuestToJS(ab) {
    const info = this._abMemory.get(ab);
    if (info && ab.byteLength > 0) {
      const base = this._guestBase();
      new Uint8Array(ab).set(new Uint8Array(this._buf(), base + info.address, ab.byteLength));
    }
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
    if (len > 0x7FFFFFFF && len !== 0xFFFFFFFF) return napi_invalid_arg; // > INT_MAX
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
    const encoded = new TextEncoder().encode(value);
    if (bufPtr && bufSize > 0) {
      const maxWrite = bufSize - 1;
      // Don't split multi-byte UTF-8 characters
      let toWrite = Math.min(encoded.length, maxWrite);
      while (toWrite > 0 && (encoded[toWrite] & 0xC0) === 0x80) toWrite--;
      const base = this._guestBase();
      new Uint8Array(this._buf()).set(encoded.subarray(0, toWrite), base + bufPtr);
      new Uint8Array(this._buf())[base + bufPtr + toWrite] = 0;
      if (resultPtr) this._writeU32(resultPtr, toWrite);
    } else if (resultPtr) {
      // No buffer — just report the full byte length needed
      this._writeU32(resultPtr, encoded.length);
    }
    return napi_ok;
  }

  napi_set_named_property(args) {
    const [env, objectHandle, namePtr, valueHandle] = args;
    if (!objectHandle || !namePtr || !valueHandle) return napi_invalid_arg;
    const obj = this._getHandle(objectHandle);
    const val = this._getHandle(valueHandle);
    const name = this._readNullTermString(namePtr);
    if (obj && typeof obj === 'object') obj[name] = val;
    return napi_ok;
  }

  napi_get_named_property(args) {
    const [env, objectHandle, namePtr, resultPtr] = args;
    if (!objectHandle || !namePtr || !resultPtr) return napi_invalid_arg;
    const obj = this._getHandle(objectHandle);
    const name = this._readNullTermString(namePtr);
    const val = obj?.[name];
    const h = this._newHandle(val);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_get_property(args) {
    const [env, objectHandle, keyHandle, resultPtr] = args;
    if (!objectHandle || !keyHandle || !resultPtr) return napi_invalid_arg;
    const obj = this._getHandle(objectHandle);
    const key = this._getHandle(keyHandle);
    const val = obj?.[key];
    const h = this._newHandle(val);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_set_property(args) {
    const [env, objectHandle, keyHandle, valueHandle] = args;
    if (!objectHandle || !keyHandle || !valueHandle) return napi_invalid_arg;
    const obj = this._getHandle(objectHandle);
    const key = this._getHandle(keyHandle);
    const val = this._getHandle(valueHandle);
    if (obj && typeof obj === 'object') obj[key] = val;
    return napi_ok;
  }

  napi_typeof(args) {
    const [env, valueHandle, resultPtr] = args;
    if (!valueHandle) return napi_invalid_arg;
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
      // Drain deferred async work — scheduled via stepper or manual drain
      // Don't auto-drain here to avoid re-entrancy with kernel_call_indirect
      return retVal;
    };
  }

  napi_create_function(args) {
    const [env, namePtr, nameLen, cbPtr, dataPtr, resultPtr] = args;
    if (!cbPtr) return napi_invalid_arg;
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
    if (!objectHandle) return napi_invalid_arg;
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
    const value = this._getHandle(valueHandle);
    // For weak refs (refcount=0), use WeakRef for objects so they can be GC'd
    const isObject = value !== null && (typeof value === 'object' || typeof value === 'function');
    const storedValue = (initialRefcount === 0 && isObject) ? new WeakRef(value) : value;
    const refPtr = this._allocRefPtr(refId);
    this.refs.set(refId, { handle: valueHandle, value: storedValue, weak: initialRefcount === 0 && isObject, refcount: initialRefcount, ptr: refPtr });
    // Track weak refs for finalization coordination
    if (initialRefcount === 0 && isObject && this._objToRefIds) {
      const ids = this._objToRefIds.get(value);
      if (ids) ids.push(refId);
    }
    // Strong ref (refcount > 0): keep handle alive across scopes
    if (initialRefcount > 0) this._referencedHandles.add(valueHandle);
    this._writeU32(resultPtr, refPtr);
    return napi_ok;
  }

  // Resolve a guest napi_ref pointer to our internal refId
  _resolveRefId(refPtr) {
    return this._refPtrToId?.get(refPtr) ?? refPtr;
  }

  // Bump allocator in guest memory for data the guest needs to access
  _guestAlloc(size) {
    if (!this._guestPoolBase) {
      // Reserve 64KB pool in guest memory, below error struct area
      const guestSize = this.k.kernel_guest_memory_size();
      this._guestPoolBase = guestSize - 512 - 65536;
      this._guestPoolOffset = 0;
    }
    // Align to 8 bytes
    const aligned = (this._guestPoolOffset + 7) & ~7;
    const guestAddr = this._guestPoolBase + aligned;
    this._guestPoolOffset = aligned + size;
    return guestAddr;
  }

  // Allocate a guest memory-backed ref and return the guest address
  _allocRefPtr(refId) {
    const guestAddr = this._guestAlloc(4);
    new DataView(this._buf()).setUint32(this._guestBase() + guestAddr, refId, true);
    this._refPtrToId = this._refPtrToId || new Map();
    this._refPtrToId.set(guestAddr, refId);
    return guestAddr;
  }

  napi_get_reference_value(args) {
    const [env, refPtr, resultPtr] = args;
    const refId = this._resolveRefId(refPtr);
    const ref = this.refs.get(refId);
    if (!ref) { this._writeResult(resultPtr, 0); return napi_ok; }
    // Resolve the value (deref WeakRef for weak references)
    let value;
    if (ref.weak) {
      value = ref.value.deref(); // WeakRef — returns undefined if GC'd
      if (value === undefined) {
        this._writeResult(resultPtr, 0); // GC'd — return NULL
        return napi_ok;
      }
    } else {
      value = ref.value;
    }
    const h = this._newHandle(value);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  napi_reference_unref(args) {
    const [env, refPtr, resultPtr] = args;
    const refId = this._resolveRefId(refPtr);
    const ref = this.refs.get(refId);
    if (ref) {
      ref.refcount = Math.max(0, ref.refcount - 1);
      // Transition from strong to weak when refcount hits 0
      if (ref.refcount === 0 && !ref.weak) {
        const value = ref.value;
        const isObject = value !== null && (typeof value === 'object' || typeof value === 'function');
        if (isObject) {
          ref.value = new WeakRef(value);
          ref.weak = true;
        }
        this._referencedHandles.delete(ref.handle);
        this.handles.delete(ref.handle); // allow GC
      }
    }
    if (resultPtr) this._writeU32(resultPtr, ref ? ref.refcount : 0);
    return napi_ok;
  }

  napi_delete_reference(args) {
    const [env, refPtr] = args;
    const refId = this._resolveRefId(refPtr);
    const ref = this.refs.get(refId);
    if (ref) {
      this._referencedHandles.delete(ref.handle);
      this.handles.delete(ref.handle); // allow GC
    }
    this.refs.delete(refId);
    this._refPtrToId?.delete(refPtr);
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
    if (obj != null && (typeof obj === 'object' || typeof obj === 'function')) {
      if (this.wraps.has(obj)) return napi_invalid_arg; // already wrapped
      this.wraps.set(obj, nativePtr);
      this._registerFinalizer(obj, finalizeCb, nativePtr, finalizeHint);
    }
    if (resultPtr) {
      const refId = this.nextRef++;
      const refPtr = this._allocRefPtr(refId);
      this.refs.set(refId, { handle: objectHandle, refcount: 0, ptr: refPtr });
      this._writeU32(resultPtr, refPtr);
    }
    return napi_ok;
  }

  napi_unwrap(args) {
    const [env, objectHandle, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    const ptr = (obj != null && (typeof obj === 'object' || typeof obj === 'function')) ? (this.wraps.get(obj) ?? 0) : 0;
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
    this._referencedHandles.add(h); // persistent — survives scope cleanup
    if (funcHandle) this._referencedHandles.add(funcHandle); // keep JS callback alive
    this._writeResult(resultPtr, h);

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
    const INT64_MAX = 9223372036854775807n;
    const INT64_MIN = -9223372036854775808n;
    if (i64val > INT64_MAX) i64val = INT64_MAX;
    else if (i64val < INT64_MIN) i64val = INT64_MIN;
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
    if (!objectHandle || !namePtr || !resultPtr) return napi_invalid_arg;
    const obj = this._getHandle(objectHandle);
    const name = this._readNullTermString(namePtr);
    const has = obj && typeof obj === 'object' && name in obj;
    this._writeBool(resultPtr, has);
    return napi_ok;
  }

  // napi_has_property(env, object, key, result_ptr)
  napi_has_property(args) {
    const [env, objectHandle, keyHandle, resultPtr] = args;
    if (!objectHandle || !keyHandle || !resultPtr) return napi_invalid_arg;
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
    if (len > 0x7FFFFFFF && len !== 0xFFFFFFFF) return napi_invalid_arg;
    const base = this._guestBase();
    const mem = new Uint8Array(this._buf());
    let str;
    if (len === 0xFFFFFFFF || len === -1) {
      // null-terminated
      let end = strPtr;
      while (mem[base + end] !== 0) end++;
      str = Array.from(mem.subarray(base + strPtr, base + end), b => String.fromCharCode(b)).join('');
    } else {
      str = Array.from(mem.subarray(base + strPtr, base + strPtr + len), b => String.fromCharCode(b)).join('');
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
    this._abMemory.set(buf, { address: guestPtr, ownership: 0, runtimeAllocated: 1 });
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
    this._abMemory.set(buf, { address: guestPtr, ownership: 0, runtimeAllocated: 1 });
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
    // Ensure JS-created buffers have a guest memory mapping
    if (!this._abMemory.has(val) && val.byteLength > 0) {
      const guestAddr = this._guestAlloc(val.byteLength);
      this._abMemory.set(val, { address: guestAddr, ownership: 0, runtimeAllocated: 1 });
    }
    // Always sync JS content to guest memory
    if (this._abMemory.has(val) && val.byteLength > 0) {
      const base = this._guestBase();
      const info = this._abMemory.get(val);
      new Uint8Array(this._buf()).set(new Uint8Array(val.buffer, val.byteOffset, val.byteLength), base + info.address);
    }
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
    if (!resultPtr) return napi_invalid_arg;
    // Allocate in guest-accessible memory (same as napi_create_arraybuffer)
    const guestAddr = byteLength > 0 ? this._guestAlloc(byteLength) : 0;
    if (guestAddr) {
      const base = this._guestBase();
      new Uint8Array(this._buf()).fill(0, base + guestAddr, base + guestAddr + byteLength);
    }
    const sab = new SharedArrayBuffer(byteLength);
    this._abMemory.set(sab, { address: guestAddr, ownership: 0, runtimeAllocated: 1 }); // emnapi_runtime
    if (dataPtr) this._writeU32(dataPtr, guestAddr);
    const h = this._newHandle(sab);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // ===== Cleanup hooks =====
  napi_add_env_cleanup_hook(args) {
    const [env, cbPtr, dataPtr] = args;
    if (!this._cleanupHooks) this._cleanupHooks = [];
    this._cleanupHooks.push({ cb: cbPtr, data: dataPtr });
    return napi_ok;
  }
  napi_remove_env_cleanup_hook(args) {
    const [env, cbPtr, dataPtr] = args;
    if (this._cleanupHooks) {
      const idx = this._cleanupHooks.findIndex(h => h.cb === cbPtr && h.data === dataPtr);
      if (idx >= 0) this._cleanupHooks.splice(idx, 1);
    }
    return napi_ok;
  }

  // Run cleanup hooks (called at process exit)
  runCleanupHooks() {
    if (!this._cleanupHooks) return;
    // Run in reverse order (LIFO)
    while (this._cleanupHooks.length > 0) {
      const { cb, data } = this._cleanupHooks.pop();
      const ap = this.k.kernel_alloc(4);
      new DataView(this._buf()).setUint32(ap, data, true);
      this.k.kernel_call_indirect(cb, 1, ap);
    }
  }

  // ===== Fatal exception =====
  napi_fatal_exception(args) {
    const [env, errorHandle] = args;
    const err = this._getHandle(errorHandle);
    // Propagate as uncaughtException (matches Node.js behavior)
    process.nextTick(() => { throw err; });
    return napi_ok;
  }

  // ===== Filename =====
  node_api_get_module_file_name(args) {
    const [env, resultPtr] = args;
    // Write a C string pointer to guest memory (not a napi_value)
    const filename = this._moduleFilename || "";
    const encoded = new TextEncoder().encode(filename);
    const guestAddr = this._guestAlloc(encoded.length + 1);
    const base = this._guestBase();
    new Uint8Array(this._buf()).set(encoded, base + guestAddr);
    new Uint8Array(this._buf())[base + guestAddr + encoded.length] = 0;
    this._writeU32(resultPtr, guestAddr);
    return napi_ok;
  }

  // ===== External strings =====
  node_api_create_external_string_latin1(args) {
    const [env, strPtr, length, finalizeCb, finalizeHint, resultPtr, copiedPtr] = args;
    // Latin1: read bytes and convert via String.fromCharCode (not TextDecoder which is UTF-8)
    const base = this._guestBase();
    const mem = new Uint8Array(this._buf());
    let str;
    if (length === 0xFFFFFFFF || length === -1) {
      let end = strPtr;
      while (mem[base + end] !== 0) end++;
      str = Array.from(mem.subarray(base + strPtr, base + end), b => String.fromCharCode(b)).join('');
    } else {
      str = Array.from(mem.subarray(base + strPtr, base + strPtr + length), b => String.fromCharCode(b)).join('');
    }
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
    if (dataPtr === 0 && byteLength === 0) {
      // NULL data + 0 length = create a detached/neutered ArrayBuffer
      try { new MessageChannel().port1.postMessage(null, [ab]); } catch {}
      ab._detached = true;
    } else {
      // Map to existing guest memory at dataPtr
      this._abMemory.set(ab, { address: dataPtr, ownership: 0, runtimeAllocated: 0 });
      this._syncGuestToJS(ab);
    }
    this._registerFinalizer(ab, finalizeCb, dataPtr, finalizeHint);
    const h = this._newHandle(ab);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_detach_arraybuffer(env, arraybuffer)
  napi_detach_arraybuffer(args) {
    const [env, abHandle] = args;
    const val = this._getHandle(abHandle);
    const ab = val instanceof ArrayBuffer ? val : val?.buffer;
    if (ab instanceof ArrayBuffer) {
      try { new MessageChannel().port1.postMessage(null, [ab]); } catch {}
      ab._detached = true;
    }
    return napi_ok;
  }

  // napi_get_dataview_info(env, dataview, byte_length, data, arraybuffer, byte_offset)
  napi_get_dataview_info(args) {
    const [env, valueHandle, byteLengthPtr, dataPtr, abPtr, byteOffsetPtr] = args;
    const val = this._getHandle(valueHandle);
    if (byteLengthPtr) this._writeU32(byteLengthPtr, val?.byteLength ?? 0);
    if (dataPtr) {
      const ab = val?.buffer;
      if (ab instanceof ArrayBuffer && !this._abMemory.has(ab) && ab.byteLength > 0) {
        const guestAddr = this._guestAlloc(ab.byteLength);
        this._abMemory.set(ab, { address: guestAddr, ownership: 0, runtimeAllocated: 1 });
      }
      if (ab instanceof ArrayBuffer && this._abMemory.has(ab) && ab.byteLength > 0) {
        const base = this._guestBase();
        const info = this._abMemory.get(ab);
        new Uint8Array(this._buf()).set(new Uint8Array(ab), base + info.address);
      }
      const info = this._abMemory.get(ab);
      this._writeU32(dataPtr, info ? info.address + (val?.byteOffset ?? 0) : 0);
    }
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
    let detached = false;
    const ab = val instanceof ArrayBuffer ? val : val?.buffer;
    if (ab instanceof ArrayBuffer) {
      detached = ab.detached === true || ab._detached === true;
    }
    this._writeBool(resultPtr, detached);
    return napi_ok;
  }

  // emnapi-specific functions
  emnapi_is_support_weakref(args) { return 1; } // WeakRef supported

  // uv_thread_create(tid_ptr, entry, arg) — spawn thread via wasi_thread_spawn
  uv_thread_create(args) {
    const [tidPtr, entryFuncPtr, argPtr] = args;
    // Build start_args struct in guest memory:
    // { void* stack, void* tls_base, void* (*start_func)(void*), void* start_arg }
    // Allocate stack and TLS within guest's actual memory pages.
    // Use a bump allocator starting at 1MB (well within 16MB initial memory,
    // far from the guest's own stack/data which is in first ~200KB).
    const stackSize = 65536;
    const tlsSize = 4096;
    if (!this._threadAllocOffset) this._threadAllocOffset = 1048576; // 1MB
    // Layout: [argsAddr(16)] [TLS(4K)] [guard(4K)] [STACK(64K)]
    // Stack grows DOWN from stackTop. Guard gap prevents stack overflow
    // into TLS/args.
    const argsAddr = this._threadAllocOffset;
    this._threadAllocOffset += 16;
    const tlsBase = this._threadAllocOffset;
    this._threadAllocOffset += tlsSize;
    this._threadAllocOffset += 4096; // guard gap
    const stackBase = this._threadAllocOffset;
    this._threadAllocOffset += stackSize;
    const stackTop = stackBase + stackSize;
    const base = this._guestBase();
    const dv = new DataView(this._buf());
    dv.setUint32(base + argsAddr + 0, stackTop, true);    // stack (grows down)
    dv.setUint32(base + argsAddr + 4, tlsBase, true);      // tls_base
    dv.setUint32(base + argsAddr + 8, entryFuncPtr, true);  // start_func
    dv.setUint32(base + argsAddr + 12, argPtr, true);       // start_arg

    // Call wasi.thread-spawn via the kernel
    // The kernel handles this by creating a new instance and registering
    // with the cooperative scheduler
    const spawnArgv = this.k.kernel_alloc(4);
    new DataView(this._buf()).setUint32(spawnArgv, argsAddr, true);
    // wasi.thread-spawn is import func[30] in the guest, but we can't call
    // imports directly. Instead, find the guest's exported call to it.

    // Actually: the guest exports wasi_thread_start. The wasi.thread-spawn
    // native is handled by WAMR internally. We can trigger it by calling
    // kernel_call_indirect on a function that calls thread_spawn.
    // But there's no such exported function.

    // Simpler: use kernel_call with the function name if the guest exports
    // a thread_spawn wrapper. But it doesn't.

    // The most direct approach: add a kernel export for spawning threads.
    // For now, let's just call the underlying wasm import directly.

    // WAMR's thread_spawn is a native function. When the guest calls
    // wasi.thread-spawn(start_arg), WAMR handles it. We need to trigger
    // this from the host side.

    // We can add a kernel_thread_spawn export that wraps wasi_thread_spawn
    if (this.k.kernel_thread_spawn) {
      const tid = this.k.kernel_thread_spawn(argsAddr);
      if (tidPtr) this._writeU32(tidPtr, tid > 0 ? tid : 0);
      return tid > 0 ? 0 : -1;
    }

    // Fallback: return error
    if (tidPtr) this._writeU32(tidPtr, 0);
    return -1;
  }

  uv_thread_join(args) {
    // Wait for thread to complete — check scheduler
    // For now, no-op (thread runs cooperatively)
    return 0;
  }

  // emnapi async send — used by spawned threads to send callbacks to main thread
  _emnapi_async_send_js(args) {
    const [type, callback, data] = args;
    // Schedule callback on main thread via kernel_call_indirect
    // type: 0=setImmediate, 1=nextTick
    if (!this._asyncSendQueue) this._asyncSendQueue = [];
    this._asyncSendQueue.push({ callback, data });
    return 0;
  }

  // Drain async send queue (called from stepper)
  drainAsyncSendQueue() {
    if (!this._asyncSendQueue || !this._asyncSendQueue.length) return;
    while (this._asyncSendQueue.length > 0) {
      const { callback, data } = this._asyncSendQueue.shift();
      // Call the guest callback function with (data) arg
      const ap = this.k.kernel_alloc(8);
      new DataView(this._buf()).setUint32(ap, data, true);
      this.k.kernel_call_indirect(callback, 1, ap);
    }
  }
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
  emnapi_sync_memory(args) {
    // (env, js_to_wasm, arraybuffer_handle_ptr, byte_offset, byte_length)
    const [env, jsToWasm, abHandlePtr, byteOffset, byteLength] = args;
    if (!abHandlePtr) return napi_ok;
    const handleId = this._readU32(abHandlePtr);
    if (!handleId) return napi_ok;
    const val = this._getHandle(handleId);
    const ab = (val instanceof ArrayBuffer || val instanceof SharedArrayBuffer) ? val : val?.buffer;
    if (!ab) return napi_ok;
    const info = this._abMemory.get(ab);
    if (!info || ab.byteLength === 0) return napi_ok;
    const base = this._guestBase();
    const offset = byteOffset || 0;
    const len = (byteLength === 0xFFFFFFFF || !byteLength) ? ab.byteLength - offset : Math.min(byteLength, ab.byteLength - offset);
    if (len <= 0) return napi_ok;
    if (jsToWasm) {
      new Uint8Array(this._buf(), base + info.address + offset, len).set(new Uint8Array(ab, offset, len));
    } else {
      new Uint8Array(ab, offset, len).set(new Uint8Array(this._buf(), base + info.address + offset, len));
    }
    return napi_ok;
  }

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
      if (resultPtr) this._writeU32(resultPtr, writeLen);
    } else if (resultPtr) {
      this._writeU32(resultPtr, val.length);
    }
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
      if (resultPtr) this._writeU32(resultPtr, writeLen);
    } else if (resultPtr) {
      this._writeU32(resultPtr, val.length);
    }
    return napi_ok;
  }

  // napi_create_string_utf16(env, str_ptr, len, result)
  napi_create_string_utf16(args) {
    const [env, strPtr, len, resultPtr] = args;
    if (!resultPtr) return napi_invalid_arg;
    if (len > 0x7FFFFFFF && len !== 0xFFFFFFFF) return napi_invalid_arg;
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
    // SIZE_MAX = clearly invalid arg (not a RangeError, just bad input)
    if (wordCount >= 0xFFFFFFFF) return napi_invalid_arg;
    // Check if wordCount is too large — would exceed BigInt engine limits
    const guestSize = this.k.kernel_guest_memory_size();
    if (wordCount * 8 > guestSize || wordCount > 1000000) {
      this.lastException = new RangeError('Maximum BigInt size exceeded');
      this.exceptionPending = true;
      return napi_pending_exception;
    }
    try {
      let val = 0n;
      const base = this._guestBase();
      for (let i = 0; i < wordCount; i++) {
        const word = new DataView(this._buf()).getBigUint64(base + wordsPtr + i * 8, true);
        val += word << (BigInt(i) * 64n);
      }
      if (signBit) val = -val;
      const h = this._newHandle(val);
      this._writeResult(resultPtr, h);
    } catch (e) {
      this.lastException = e;
      this.exceptionPending = true;
      return napi_pending_exception;
    }
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
    if (!objectHandle || (propCount > 0 && !propsPtr)) return napi_invalid_arg;
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
    if (!objectHandle || !resultPtr) return napi_invalid_arg;
    const obj = this._getHandle(objectHandle);
    this._writeBool(resultPtr, obj && index in obj);
    return napi_ok;
  }

  // napi_delete_element(env, object, index, result) — result is bool* (1 byte)
  napi_delete_element(args) {
    const [env, objectHandle, index, resultPtr] = args;
    if (!objectHandle) return napi_invalid_arg;
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
    if (!objectHandle || !keyHandle) return napi_invalid_arg;
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
    if (!objectHandle || !resultPtr) return napi_invalid_arg;
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
    if (!objectHandle || !ctorHandle) return napi_invalid_arg;
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
    if (!objectHandle || !resultPtr) return napi_invalid_arg;
    const obj = this._getHandle(objectHandle);
    const proto = Object.getPrototypeOf(obj);
    const h = this._newHandle(proto);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_get_property_names(env, object, result)
  napi_get_property_names(args) {
    // Equivalent to get_all_property_names with include_prototypes, enumerable, skip_symbols, numbers_to_strings
    const [env, objectHandle, resultPtr] = args;
    if (!objectHandle || !resultPtr) return napi_invalid_arg;
    const obj = this._getHandle(objectHandle);
    if (!obj) { this._writeResult(resultPtr, this._newHandle([])); return napi_ok; }
    const names = [];
    for (const key in obj) { // for..in includes prototype chain, enumerable only, strings only
      names.push(key);
    }
    this._writeResult(resultPtr, this._newHandle(names));
    return napi_ok;
  }

  // napi_get_all_property_names(env, object, key_mode, key_filter, key_conversion, result)
  napi_get_all_property_names(args) {
    const [env, objectHandle, keyMode, keyFilter, keyConversion, resultPtr] = args;
    if (!objectHandle || !resultPtr) return napi_invalid_arg;
    const obj = this._getHandle(objectHandle);
    if (!obj) { this._writeResult(resultPtr, this._newHandle([])); return napi_ok; }
    // key_mode: 0=include_prototypes, 1=own_only
    // key_filter: 1=writable, 2=enumerable, 4=configurable, 8=skip_strings, 16=skip_symbols
    let names = [];
    let current = obj;
    do {
      for (const key of Reflect.ownKeys(current)) {
        if (names.includes(key)) continue;
        const desc = Object.getOwnPropertyDescriptor(current, key);
        if (keyFilter) {
          if ((keyFilter & 1) && desc && !desc.writable && !desc.set) continue;
          if ((keyFilter & 2) && desc && !desc.enumerable) continue;
          if ((keyFilter & 4) && desc && !desc.configurable) continue;
          if ((keyFilter & 8) && typeof key === 'string') continue;
          if ((keyFilter & 16) && typeof key === 'symbol') continue;
        }
        names.push(keyConversion === 1 && typeof key === 'number' ? String(key) : key);
      }
      current = Object.getPrototypeOf(current);
    } while (keyMode === 0 && current != null);
    this._writeResult(resultPtr, this._newHandle(names));
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
    const deferredGuestPtr = this._allocRefPtr(deferredId);
    this.refs.set(deferredId, { resolve, reject, ptr: deferredGuestPtr });
    this._writeU32(deferredPtr, deferredGuestPtr);
    const h = this._newHandle(promise);
    this._writeResult(resultPtr, h);
    return napi_ok;
  }

  // napi_resolve_deferred(env, deferred, value)
  napi_resolve_deferred(args) {
    const [env, deferredPtr, valueHandle] = args;
    const deferredId = this._resolveRefId(deferredPtr);
    const d = this.refs.get(deferredId);
    if (d?.resolve) { d.resolve(this._getHandle(valueHandle)); this.refs.delete(deferredId); this._refPtrToId?.delete(deferredPtr); }
    return napi_ok;
  }

  // napi_reject_deferred(env, deferred, value)
  napi_reject_deferred(args) {
    const [env, deferredPtr, valueHandle] = args;
    const deferredId = this._resolveRefId(deferredPtr);
    const d = this.refs.get(deferredId);
    if (d?.reject) { d.reject(this._getHandle(valueHandle)); this.refs.delete(deferredId); this._refPtrToId?.delete(deferredPtr); }
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
    const [env, refPtr, resultPtr] = args;
    const refId = this._resolveRefId(refPtr);
    const ref = this.refs.get(refId);
    if (ref && ref.refcount !== undefined) {
      ref.refcount++;
      // Transition from weak to strong when refcount goes from 0 to 1
      if (ref.refcount === 1 && ref.weak) {
        const value = ref.value.deref();
        if (value !== undefined) {
          ref.value = value;
          ref.weak = false;
          this._referencedHandles.add(ref.handle);
        }
      }
    }
    if (resultPtr) this._writeU32(resultPtr, ref?.refcount ?? 0);
    return napi_ok;
  }

  // napi_remove_wrap(env, object, result)
  napi_remove_wrap(args) {
    const [env, objectHandle, resultPtr] = args;
    const obj = this._getHandle(objectHandle);
    const isObj = obj != null && (typeof obj === 'object' || typeof obj === 'function');
    const ptr = isObj ? (this.wraps.get(obj) ?? 0) : 0;
    if (isObj) this.wraps.delete(obj);
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
    if (obj != null && (typeof obj === 'object' || typeof obj === 'function')) {
      this._registerFinalizer(obj, finalizeCb, dataPtr, finalizeHint);
    }
    if (resultPtr) {
      const refId = this.nextRef++;
      const refPtr = this._allocRefPtr(refId);
      this.refs.set(refId, { handle: objectHandle, refcount: 0, ptr: refPtr });
      this._writeU32(resultPtr, refPtr);
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
    work.status = napi_cancelled;
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
          const ap = this.k.kernel_alloc(16);
          new DataView(this._buf()).setUint32(ap, this._guestEnv || 1, true);
          new DataView(this._buf()).setUint32(ap + 4, work.dataPtr, true);
          const r = this.k.kernel_call_indirect_simple(work.executeCb, 2, ap);
          if (r !== 0) { work.status = 1; }
        }
        this._pendingAsyncQueue.push({ type: 'complete', work });
      } else if (item.type === 'complete') {
        if (work.completeCb) {
          const ap = this.k.kernel_alloc(16);
          new DataView(this._buf()).setUint32(ap, this._guestEnv || 1, true);
          new DataView(this._buf()).setUint32(ap + 4, work.status, true);
          new DataView(this._buf()).setUint32(ap + 8, work.dataPtr, true);
          this.k.kernel_call_indirect_simple(work.completeCb, 3, ap);
          // Propagate any exception from the complete callback
          if (this.exceptionPending) {
            const exc = this.lastException;
            this.lastException = null;
            this.exceptionPending = false;
            if (exc) process.nextTick(() => { throw exc; });
          }
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

  // napi_async_init/destroy — integrated with Node.js async_hooks
  _nextAsyncContextId = 1;
  _asyncContexts = new Map(); // contextId -> AsyncResource

  napi_async_init(args) {
    const [env, asyncResource, asyncResourceName, resultPtr] = args;
    const id = this._nextAsyncContextId++;
    const name = (asyncResourceName ? this._getHandle(asyncResourceName) : null) || 'napi_async';
    if (AsyncResource) {
      try {
        const ar = new AsyncResource(name, { requireManualDestroy: true });
        this._asyncContexts.set(id, { ar });
      } catch {}
    }
    this._writeU32(resultPtr, id);
    return napi_ok;
  }

  napi_async_destroy(args) {
    const [env, contextId] = args;
    const ctx = this._asyncContexts.get(contextId);
    if (ctx?.ar) {
      try { ctx.ar.emitDestroy(); } catch {}
    }
    this._asyncContexts.delete(contextId);
    return napi_ok;
  }

  // napi_make_callback(env, async_context, recv, func, argc, argv, result)
  napi_make_callback(args) {
    const [env, asyncCtx, recvHandle, funcHandle, argc, argvPtr, resultPtr] = args;
    const ctx = this._asyncContexts.get(asyncCtx);
    if (ctx?.ar) {
      // Run the callback inside the async resource's scope
      const fn = this._getHandle(funcHandle);
      const recv = this._getHandle(recvHandle);
      const fnArgs = [];
      for (let i = 0; i < argc; i++) {
        const argHandle = this._readU32(argvPtr + i * 4);
        fnArgs.push(this._getHandle(argHandle));
      }
      try {
        const result = ctx.ar.runInAsyncScope(fn, recv, ...fnArgs);
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
    // Fallback: delegate to napi_call_function
    return this.napi_call_function([env, recvHandle, funcHandle, argc, argvPtr, resultPtr]);
  }

  // Threadsafe functions — enhanced implementation
  napi_acquire_threadsafe_function(args) { return napi_ok; }
  napi_get_threadsafe_function_context(args) {
    // Note: this function takes (tsfn, result) — NO env parameter
    const [tsfnHandle, resultPtr] = args;
    const tsf = this._getHandle(tsfnHandle);
    this._writeU32(resultPtr, tsf?.context ?? 0);
    return napi_ok;
  }
  napi_call_threadsafe_function(args) {
    // No env parameter: (tsfn, data, mode)
    const [tsfnHandle, dataPtr, mode] = args;
    const tsf = this._getHandle(tsfnHandle);
    if (!tsf) return napi_generic_failure;
    // Queue the call — dispatch happens on the main thread via drainTsfnQueue
    tsf.queue.push(dataPtr);
    return napi_ok;
  }

  // Drain queued threadsafe function calls (called from outside kernel_step)
  drainTsfnQueue() {
    for (const [id, val] of this.handles) {
      if (val?.type !== 'threadsafe_function' || !val.queue.length) continue;
      while (val.queue.length > 0) {
        const dataPtr = val.queue.shift();
        if (val.callJsCb) {
          // Call the C call_js_cb which will invoke the JS function
          const argvPtr = this.k.kernel_alloc(16);
          new DataView(this._buf()).setUint32(argvPtr, this._guestEnv || 1, true);
          new DataView(this._buf()).setUint32(argvPtr + 4, val.funcHandle, true);
          new DataView(this._buf()).setUint32(argvPtr + 8, val.context, true);
          new DataView(this._buf()).setUint32(argvPtr + 12, dataPtr, true);
          this.k.kernel_call_indirect(val.callJsCb, 4, argvPtr);
        } else if (val.funcHandle) {
          // No C callback — call the JS function directly with data
          const jsFn = this._getHandle(val.funcHandle);
          if (typeof jsFn === 'function') jsFn(dataPtr);
        }
      }
    }
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
    // Allocate in guest-accessible memory
    const guestAddr = byteLength > 0 ? this._guestAlloc(byteLength) : 0;
    // Zero-initialize
    if (guestAddr) {
      const base = this._guestBase();
      new Uint8Array(this._buf()).fill(0, base + guestAddr, base + guestAddr + byteLength);
    }
    const ab = new ArrayBuffer(byteLength);
    this._abMemory.set(ab, { address: guestAddr, ownership: 0, runtimeAllocated: 1 }); // emnapi_runtime
    if (dataPtr) this._writeU32(dataPtr, guestAddr);
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
    if (val instanceof ArrayBuffer || val instanceof SharedArrayBuffer) {
      // Ensure this ArrayBuffer/SharedArrayBuffer has a guest memory mapping
      if (!this._abMemory.has(val) && val.byteLength > 0) {
        const guestAddr = this._guestAlloc(val.byteLength);
        this._abMemory.set(val, { address: guestAddr, ownership: 0, runtimeAllocated: 1 });
      }
      // Always sync JS content to guest memory
      if (this._abMemory.has(val) && val.byteLength > 0) {
        const base = this._guestBase();
        const info = this._abMemory.get(val);
        new Uint8Array(this._buf()).set(new Uint8Array(val), base + info.address);
      }
      const info = this._abMemory.get(val);
      if (dataPtr) this._writeU32(dataPtr, info?.address ?? 0);
      if (lengthPtr) this._writeU32(lengthPtr, val.byteLength);
    } else {
      return napi_invalid_arg;
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
    // Sync guest→JS before creating view (guest may have written data)
    if (ab instanceof ArrayBuffer || ab instanceof SharedArrayBuffer) this._syncGuestToJS(ab);
    const ctors = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, typeof Float16Array !== 'undefined' ? Float16Array : Uint16Array];
    const Ctor = ctors[type] ?? Uint8Array;
    try {
      const ta = new Ctor(ab, byteOffset, length);
      const h = this._newHandle(ta);
      this._writeResult(resultPtr, h);
    } catch (e) {
      this.lastException = e;
      this.exceptionPending = true;
      return napi_pending_exception;
    }
    return napi_ok;
  }

  napi_get_typedarray_info(args) {
    const [env, valueHandle, typePtr, lengthPtr, dataPtr, abPtr, offsetPtr] = args;
    const val = this._getHandle(valueHandle);
    if (typePtr) {
      const typeMap = { Int8Array: 0, Uint8Array: 1, Uint8ClampedArray: 2, Int16Array: 3, Uint16Array: 4, Int32Array: 5, Uint32Array: 6, Float32Array: 7, Float64Array: 8, BigInt64Array: 9, BigUint64Array: 10, Float16Array: 11 };
      this._writeU32(typePtr, typeMap[val?.constructor?.name] ?? 1);
    }
    if (lengthPtr) this._writeU32(lengthPtr, val?.length ?? 0);
    if (dataPtr) {
      // Get the underlying ArrayBuffer's guest address
      const ab = val?.buffer;
      if (ab instanceof ArrayBuffer && !this._abMemory.has(ab) && ab.byteLength > 0) {
        const guestAddr = this._guestAlloc(ab.byteLength);
        this._abMemory.set(ab, { address: guestAddr, ownership: 0, runtimeAllocated: 1 });
      }
      // Always sync
      if (ab instanceof ArrayBuffer && this._abMemory.has(ab) && ab.byteLength > 0) {
        const base = this._guestBase();
        const info = this._abMemory.get(ab);
        new Uint8Array(this._buf()).set(new Uint8Array(ab), base + info.address);
      }
      const info = this._abMemory.get(ab);
      this._writeU32(dataPtr, info ? info.address + (val?.byteOffset ?? 0) : 0);
    }
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
    // Check lossless: value fits in signed int64 (-2^63 to 2^63-1)
    if (losslessPtr) {
      const lossless = n >= -9223372036854775808n && n <= 9223372036854775807n;
      this._writeBool(losslessPtr, lossless);
    }
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
    // Capture guest env pointer for use in finalizer callbacks
    if (args[0] && funcName.startsWith('napi_')) this._guestEnv = args[0];
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
