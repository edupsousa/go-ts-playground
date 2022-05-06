import { JsGoInstance } from "./go";

type JsGoWithoutImports = Omit<JsGoInstance, "importObject">;

export type JsGoImports = {
  // Go's SP does not change as long as no Go code is running. Some operations (e.g. calls, getters and setters)
  // may synchronously trigger a Go event handler. This makes Go code get executed in the middle of the imported
  // function. A goroutine can switch to a new stack if the current stack is too small (see morestack function).
  // This changes the SP, thus we have to update the SP used by the imported function.
  // func wasmExit(code int32)
  "runtime.wasmExit": (sp: number) => void;
  // func wasmWrite(fd uintptr, p unsafe.Pointer, n int32)
  "runtime.wasmWrite": (sp: number) => void;
  // func resetMemoryDataView()
  "runtime.resetMemoryDataView": (sp: number) => void;
  // func nanotime1() int64
  "runtime.nanotime1": (sp: number) => void;
  // func walltime() (sec int64, nsec int32)
  "runtime.walltime": (sp: number) => void;
  // func scheduleTimeoutEvent(delay int64) int32
  "runtime.scheduleTimeoutEvent": (sp: number) => void;
  // func clearTimeoutEvent(id int32)
  "runtime.clearTimeoutEvent": (sp: number) => void;
  // func getRandomData(r []byte)
  "runtime.getRandomData": (sp: number) => void;
  // func finalizeRef(v ref)
  "syscall/js.finalizeRef": (sp: number) => void;
  // func stringVal(value string) ref
  "syscall/js.stringVal": (sp: number) => void;
  // func valueGet(v ref, p string) ref
  "syscall/js.valueGet": (sp: number) => void;
  // func valueSet(v ref, p string, x ref)
  "syscall/js.valueSet": (sp: number) => void;
  // func valueDelete(v ref, p string)
  "syscall/js.valueDelete": (sp: number) => void;
  // func valueIndex(v ref, i int) ref
  "syscall/js.valueIndex": (sp: number) => void;
  // valueSetIndex(v ref, i int, x ref)
  "syscall/js.valueSetIndex": (sp: number) => void;
  // func valueCall(v ref, m string, args []ref) (ref, bool)
  "syscall/js.valueCall": (sp: number) => void;
  // func valueInvoke(v ref, args []ref) (ref, bool)
  "syscall/js.valueInvoke": (sp: number) => void;
  // func valueNew(v ref, args []ref) (ref, bool)
  "syscall/js.valueNew": (sp: number) => void;
  // func valueLength(v ref) int
  "syscall/js.valueLength": (sp: number) => void;
  // valuePrepareString(v ref) (ref, int)
  "syscall/js.valuePrepareString": (sp: number) => void;
  // valueLoadString(v ref, b []byte)
  "syscall/js.valueLoadString": (sp: number) => void;
  // func valueInstanceOf(v ref, t ref) bool
  "syscall/js.valueInstanceOf": (sp: number) => void;
  // func copyBytesToGo(dst []byte, src ref) (int, bool)
  "syscall/js.copyBytesToGo": (sp: number) => void;
  // func copyBytesToJS(dst ref, src []byte) (int, bool)
  "syscall/js.copyBytesToJS": (sp: number) => void;
  debug: (value: any) => void;
};

function initTimeouts(instance: JsGoWithoutImports) {
  const _scheduledTimeouts: Map<number, number> = new Map();
  let _nextCallbackTimeoutID: number = 1;

  function schedule(timeout: number) {
    const id = _nextCallbackTimeoutID;
    _nextCallbackTimeoutID++;
    _scheduledTimeouts.set(
      id,
      setTimeout(
        () => {
          instance.resume();
          while (_scheduledTimeouts.has(id)) {
            // for some reason Go failed to register the timeout event, log and try again
            // (temporary workaround for https://github.com/golang/go/issues/28975)
            console.warn("scheduleTimeoutEvent: missed timeout event");
            instance.resume();
          }
        },
        timeout // setTimeout has been seen to fire up to 1 millisecond early
      )
    );
    return id;
  }

  function getTimeoutId(id: number) {
    return _scheduledTimeouts.get(id);
  }

  function remove(id: number) {
    _scheduledTimeouts.delete(id);
  }

  return {
    schedule,
    getTimeoutId,
    remove,
  };
}

const encoder = new TextEncoder();
const timeOrigin = Date.now() - performance.now();

export function initializeImports(instance: JsGoWithoutImports): JsGoImports {
  const timeouts = initTimeouts(instance);

  return {
    // Go's SP does not change as long as no Go code is running. Some operations (e.g. calls, getters and setters)
    // may synchronously trigger a Go event handler. This makes Go code get executed in the middle of the imported
    // function. A goroutine can switch to a new stack if the current stack is too small (see morestack function).
    // This changes the SP, thus we have to update the SP used by the imported function.

    // func wasmExit(code int32)
    "runtime.wasmExit": (sp: number): void => {
      sp >>>= 0;
      const code = instance.memory.getInt32(sp + 8);
      // this.exited = true;
      // delete this._inst;
      // delete this._values;
      // delete this._goRefCounts;
      // delete this._ids;
      // delete this._idPool;
      instance.exit(code);
    },

    // func wasmWrite(fd uintptr, p unsafe.Pointer, n int32)
    "runtime.wasmWrite": (sp: number): void => {
      sp >>>= 0;
      const fd = instance.memory.getInt64(sp + 8);
      const p = instance.memory.getInt64(sp + 16);
      const n = instance.memory.getInt32(sp + 24);
      instance.sys.fs.writeSync(
        fd,
        new Uint8Array(instance.memory.getBuffer(), p, n)
      );
    },

    // func resetMemoryDataView()
    "runtime.resetMemoryDataView": (_sp: number): void => {
      _sp >>>= 0;
      instance.resetMemoryDataView();
    },

    // func nanotime1() int64
    "runtime.nanotime1": (sp: number): void => {
      sp >>>= 0;
      instance.memory.setInt64(
        sp + 8,
        (timeOrigin + performance.now()) * 1000000
      );
    },

    // func walltime() (sec int64, nsec int32)
    "runtime.walltime": (sp: number): void => {
      sp >>>= 0;
      const msec = new Date().getTime();
      instance.memory.setInt64(sp + 8, msec / 1000);
      instance.memory.setInt32(sp + 16, (msec % 1000) * 1000000);
    },

    // func scheduleTimeoutEvent(delay int64) int32
    "runtime.scheduleTimeoutEvent": (sp: number): void => {
      sp >>>= 0;
      const id = timeouts.schedule(instance.memory.getInt64(sp + 8) + 1);
      instance.memory.setInt32(sp + 16, id);
    },

    // func clearTimeoutEvent(id int32)
    "runtime.clearTimeoutEvent": (sp: number): void => {
      sp >>>= 0;
      const id = instance.memory.getInt32(sp + 8);
      const timeoutId = timeouts.getTimeoutId(id);
      if (timeoutId === undefined) return;
      clearTimeout(timeoutId);
      timeouts.remove(id);
    },

    // func getRandomData(r []byte)
    "runtime.getRandomData": (sp: number): void => {
      sp >>>= 0;
      crypto.getRandomValues(instance.memory.loadSlice(sp + 8));
    },

    // func finalizeRef(v ref)
    "syscall/js.finalizeRef": (sp: number): void => {
      sp >>>= 0;
      const id = instance.memory.getUint32(sp + 8);
      instance.memory.removeRef(id);
    },

    // func stringVal(value string) ref
    "syscall/js.stringVal": (sp: number): void => {
      sp >>>= 0;
      instance.memory.storeValue(sp + 24, instance.memory.loadString(sp + 8));
    },

    // func valueGet(v ref, p string) ref
    "syscall/js.valueGet": (sp: number): void => {
      sp >>>= 0;
      const result = Reflect.get(
        instance.memory.loadValue(sp + 8),
        instance.memory.loadString(sp + 16)
      );
      sp = instance.getsp() >>> 0; // see comment above
      instance.memory.storeValue(sp + 32, result);
    },

    // func valueSet(v ref, p string, x ref)
    "syscall/js.valueSet": (sp: number): void => {
      sp >>>= 0;
      Reflect.set(
        instance.memory.loadValue(sp + 8),
        instance.memory.loadString(sp + 16),
        instance.memory.loadValue(sp + 32)
      );
    },

    // func valueDelete(v ref, p string)
    "syscall/js.valueDelete": (sp: number): void => {
      sp >>>= 0;
      Reflect.deleteProperty(
        instance.memory.loadValue(sp + 8),
        instance.memory.loadString(sp + 16)
      );
    },

    // func valueIndex(v ref, i int) ref
    "syscall/js.valueIndex": (sp: number): void => {
      sp >>>= 0;
      instance.memory.storeValue(
        sp + 24,
        Reflect.get(
          instance.memory.loadValue(sp + 8),
          instance.memory.getInt64(sp + 16)
        )
      );
    },

    // valueSetIndex(v ref, i int, x ref)
    "syscall/js.valueSetIndex": (sp: number): void => {
      sp >>>= 0;
      Reflect.set(
        instance.memory.loadValue(sp + 8),
        instance.memory.getInt64(sp + 16),
        instance.memory.loadValue(sp + 24)
      );
    },

    // func valueCall(v ref, m string, args []ref) (ref, bool)
    "syscall/js.valueCall": (sp: number): void => {
      sp >>>= 0;
      try {
        const v = instance.memory.loadValue(sp + 8);
        const m = Reflect.get(v, instance.memory.loadString(sp + 16));
        const args = instance.memory.loadSliceOfValues(sp + 32);
        const result = Reflect.apply(m, v, args);
        sp = instance.getsp() >>> 0; // see comment above
        instance.memory.storeValue(sp + 56, result);
        instance.memory.setUint8(sp + 64, 1);
      } catch (err) {
        sp = instance.getsp() >>> 0; // see comment above
        instance.memory.storeValue(sp + 56, err);
        instance.memory.setUint8(sp + 64, 0);
      }
    },

    // func valueInvoke(v ref, args []ref) (ref, bool)
    "syscall/js.valueInvoke": (sp: number): void => {
      sp >>>= 0;
      try {
        const v = instance.memory.loadValue(sp + 8);
        const args = instance.memory.loadSliceOfValues(sp + 16);
        const result = Reflect.apply(v, undefined, args);
        sp = instance.getsp() >>> 0; // see comment above
        instance.memory.storeValue(sp + 40, result);
        instance.memory.setUint8(sp + 48, 1);
      } catch (err) {
        sp = instance.getsp() >>> 0; // see comment above
        instance.memory.storeValue(sp + 40, err);
        instance.memory.setUint8(sp + 48, 0);
      }
    },

    // func valueNew(v ref, args []ref) (ref, bool)
    "syscall/js.valueNew": (sp: number): void => {
      sp >>>= 0;
      try {
        const v = instance.memory.loadValue(sp + 8);
        const args = instance.memory.loadSliceOfValues(sp + 16);
        const result = Reflect.construct(v, args);
        sp = instance.getsp() >>> 0; // see comment above
        instance.memory.storeValue(sp + 40, result);
        instance.memory.setUint8(sp + 48, 1);
      } catch (err) {
        sp = instance.getsp() >>> 0; // see comment above
        instance.memory.storeValue(sp + 40, err);
        instance.memory.setUint8(sp + 48, 0);
      }
    },

    // func valueLength(v ref) int
    "syscall/js.valueLength": (sp: number): void => {
      sp >>>= 0;
      instance.memory.setInt64(
        sp + 16,
        parseInt(instance.memory.loadValue(sp + 8).length)
      );
    },

    // valuePrepareString(v ref) (ref, int)
    "syscall/js.valuePrepareString": (sp: number): void => {
      sp >>>= 0;
      const str = encoder.encode(String(instance.memory.loadValue(sp + 8)));
      instance.memory.storeValue(sp + 16, str);
      instance.memory.setInt64(sp + 24, str.length);
    },

    // valueLoadString(v ref, b []byte)
    "syscall/js.valueLoadString": (sp: number): void => {
      sp >>>= 0;
      const str = instance.memory.loadValue(sp + 8);
      instance.memory.loadSlice(sp + 16).set(str);
    },

    // func valueInstanceOf(v ref, t ref) bool
    "syscall/js.valueInstanceOf": (sp: number): void => {
      sp >>>= 0;
      instance.memory.setUint8(
        sp + 24,
        instance.memory.loadValue(sp + 8) instanceof
          instance.memory.loadValue(sp + 16)
          ? 1
          : 0
      );
    },

    // func copyBytesToGo(dst []byte, src ref) (int, bool)
    "syscall/js.copyBytesToGo": (sp: number): void => {
      sp >>>= 0;
      const dst = instance.memory.loadSlice(sp + 8);
      const src = instance.memory.loadValue(sp + 32);
      if (!(src instanceof Uint8Array || src instanceof Uint8ClampedArray)) {
        instance.memory.setUint8(sp + 48, 0);
        return;
      }
      const toCopy = src.subarray(0, dst.length);
      dst.set(toCopy);
      instance.memory.setInt64(sp + 40, toCopy.length);
      instance.memory.setUint8(sp + 48, 1);
    },

    // func copyBytesToJS(dst ref, src []byte) (int, bool)
    "syscall/js.copyBytesToJS": (sp: number): void => {
      sp >>>= 0;
      const dst = instance.memory.loadValue(sp + 8);
      const src = instance.memory.loadSlice(sp + 16);
      if (!(dst instanceof Uint8Array || dst instanceof Uint8ClampedArray)) {
        instance.memory.setUint8(sp + 48, 0);
        return;
      }
      const toCopy = src.subarray(0, dst.length);
      dst.set(toCopy);
      instance.memory.setInt64(sp + 40, toCopy.length);
      instance.memory.setUint8(sp + 48, 1);
    },

    debug: (value: any): void => {
      console.log(value);
    },
  };
}
