import { GoWasmInstance } from "./go";
import { JsGoMemory } from "./memory";

type JsGoInstance = {
  exit: (code: number) => void;
  resume: () => void;
  getsp: () => number;
  updateMemory: () => void;
  timeouts: {
    schedule: (timeout: number) => number;
    getTimeoutId: (id: number) => number | undefined;
    delete: (id: number) => void;
  };
  timeOrigin: number;
  sys: {
    fs: any;
  };
};

const encoder = new TextEncoder();

export function initializeImports(memory: JsGoMemory, instance: JsGoInstance) {
  return {
    // Go's SP does not change as long as no Go code is running. Some operations (e.g. calls, getters and setters)
    // may synchronously trigger a Go event handler. This makes Go code get executed in the middle of the imported
    // function. A goroutine can switch to a new stack if the current stack is too small (see morestack function).
    // This changes the SP, thus we have to update the SP used by the imported function.

    // func wasmExit(code int32)
    "runtime.wasmExit": (sp: number) => {
      sp >>>= 0;
      const code = memory.getInt32(sp + 8);
      // this.exited = true;
      // delete this._inst;
      // delete this._values;
      // delete this._goRefCounts;
      // delete this._ids;
      // delete this._idPool;
      instance.exit(code);
    },

    // func wasmWrite(fd uintptr, p unsafe.Pointer, n int32)
    "runtime.wasmWrite": (sp: number) => {
      sp >>>= 0;
      const fd = memory.getInt64(sp + 8);
      const p = memory.getInt64(sp + 16);
      const n = memory.getInt32(sp + 24);
      instance.sys.fs.writeSync(fd, new Uint8Array(memory.getBuffer(), p, n));
    },

    // func resetMemoryDataView()
    "runtime.resetMemoryDataView": (sp: number) => {
      sp >>>= 0;
      instance.updateMemory();
    },

    // func nanotime1() int64
    "runtime.nanotime1": (sp: number) => {
      sp >>>= 0;
      memory.setInt64(
        sp + 8,
        (instance.timeOrigin + performance.now()) * 1000000
      );
    },

    // func walltime() (sec int64, nsec int32)
    "runtime.walltime": (sp: number) => {
      sp >>>= 0;
      const msec = new Date().getTime();
      memory.setInt64(sp + 8, msec / 1000);
      memory.setInt32(sp + 16, (msec % 1000) * 1000000);
    },

    // func scheduleTimeoutEvent(delay int64) int32
    "runtime.scheduleTimeoutEvent": (sp: number) => {
      sp >>>= 0;
      const id = instance.timeouts.schedule(memory.getInt64(sp + 8) + 1);
      memory.setInt32(sp + 16, id);
    },

    // func clearTimeoutEvent(id int32)
    "runtime.clearTimeoutEvent": (sp: number) => {
      sp >>>= 0;
      const id = memory.getInt32(sp + 8);
      const timeoutId = instance.timeouts.getTimeoutId(id);
      if (timeoutId === undefined) return;
      clearTimeout(timeoutId);
      instance.timeouts.delete(id);
    },

    // func getRandomData(r []byte)
    "runtime.getRandomData": (sp: number) => {
      sp >>>= 0;
      crypto.getRandomValues(memory.loadSlice(sp + 8));
    },

    // func finalizeRef(v ref)
    "syscall/js.finalizeRef": (sp: number) => {
      sp >>>= 0;
      const id = memory.getUint32(sp + 8);
      memory.removeRef(id);
    },

    // func stringVal(value string) ref
    "syscall/js.stringVal": (sp: number) => {
      sp >>>= 0;
      memory.storeValue(sp + 24, memory.loadString(sp + 8));
    },

    // func valueGet(v ref, p string) ref
    "syscall/js.valueGet": (sp: number) => {
      sp >>>= 0;
      const result = Reflect.get(
        memory.loadValue(sp + 8),
        memory.loadString(sp + 16)
      );
      sp = instance.getsp() >>> 0; // see comment above
      memory.storeValue(sp + 32, result);
    },

    // func valueSet(v ref, p string, x ref)
    "syscall/js.valueSet": (sp: number) => {
      sp >>>= 0;
      Reflect.set(
        memory.loadValue(sp + 8),
        memory.loadString(sp + 16),
        memory.loadValue(sp + 32)
      );
    },

    // func valueDelete(v ref, p string)
    "syscall/js.valueDelete": (sp: number) => {
      sp >>>= 0;
      Reflect.deleteProperty(
        memory.loadValue(sp + 8),
        memory.loadString(sp + 16)
      );
    },

    // func valueIndex(v ref, i int) ref
    "syscall/js.valueIndex": (sp: number) => {
      sp >>>= 0;
      memory.storeValue(
        sp + 24,
        Reflect.get(memory.loadValue(sp + 8), memory.getInt64(sp + 16))
      );
    },

    // valueSetIndex(v ref, i int, x ref)
    "syscall/js.valueSetIndex": (sp: number) => {
      sp >>>= 0;
      Reflect.set(
        memory.loadValue(sp + 8),
        memory.getInt64(sp + 16),
        memory.loadValue(sp + 24)
      );
    },

    // func valueCall(v ref, m string, args []ref) (ref, bool)
    "syscall/js.valueCall": (sp: number) => {
      sp >>>= 0;
      try {
        const v = memory.loadValue(sp + 8);
        const m = Reflect.get(v, memory.loadString(sp + 16));
        const args = memory.loadSliceOfValues(sp + 32);
        const result = Reflect.apply(m, v, args);
        sp = instance.getsp() >>> 0; // see comment above
        memory.storeValue(sp + 56, result);
        memory.setUint8(sp + 64, 1);
      } catch (err) {
        sp = instance.getsp() >>> 0; // see comment above
        memory.storeValue(sp + 56, err);
        memory.setUint8(sp + 64, 0);
      }
    },

    // func valueInvoke(v ref, args []ref) (ref, bool)
    "syscall/js.valueInvoke": (sp: number) => {
      sp >>>= 0;
      try {
        const v = memory.loadValue(sp + 8);
        const args = memory.loadSliceOfValues(sp + 16);
        const result = Reflect.apply(v, undefined, args);
        sp = instance.getsp() >>> 0; // see comment above
        memory.storeValue(sp + 40, result);
        memory.setUint8(sp + 48, 1);
      } catch (err) {
        sp = instance.getsp() >>> 0; // see comment above
        memory.storeValue(sp + 40, err);
        memory.setUint8(sp + 48, 0);
      }
    },

    // func valueNew(v ref, args []ref) (ref, bool)
    "syscall/js.valueNew": (sp: number) => {
      sp >>>= 0;
      try {
        const v = memory.loadValue(sp + 8);
        const args = memory.loadSliceOfValues(sp + 16);
        const result = Reflect.construct(v, args);
        sp = instance.getsp() >>> 0; // see comment above
        memory.storeValue(sp + 40, result);
        memory.setUint8(sp + 48, 1);
      } catch (err) {
        sp = instance.getsp() >>> 0; // see comment above
        memory.storeValue(sp + 40, err);
        memory.setUint8(sp + 48, 0);
      }
    },

    // func valueLength(v ref) int
    "syscall/js.valueLength": (sp: number) => {
      sp >>>= 0;
      memory.setInt64(sp + 16, parseInt(memory.loadValue(sp + 8).length));
    },

    // valuePrepareString(v ref) (ref, int)
    "syscall/js.valuePrepareString": (sp: number) => {
      sp >>>= 0;
      const str = encoder.encode(String(memory.loadValue(sp + 8)));
      memory.storeValue(sp + 16, str);
      memory.setInt64(sp + 24, str.length);
    },

    // valueLoadString(v ref, b []byte)
    "syscall/js.valueLoadString": (sp: number) => {
      sp >>>= 0;
      const str = memory.loadValue(sp + 8);
      memory.loadSlice(sp + 16).set(str);
    },

    // func valueInstanceOf(v ref, t ref) bool
    "syscall/js.valueInstanceOf": (sp: number) => {
      sp >>>= 0;
      memory.setUint8(
        sp + 24,
        memory.loadValue(sp + 8) instanceof memory.loadValue(sp + 16) ? 1 : 0
      );
    },

    // func copyBytesToGo(dst []byte, src ref) (int, bool)
    "syscall/js.copyBytesToGo": (sp: number) => {
      sp >>>= 0;
      const dst = memory.loadSlice(sp + 8);
      const src = memory.loadValue(sp + 32);
      if (!(src instanceof Uint8Array || src instanceof Uint8ClampedArray)) {
        memory.setUint8(sp + 48, 0);
        return;
      }
      const toCopy = src.subarray(0, dst.length);
      dst.set(toCopy);
      memory.setInt64(sp + 40, toCopy.length);
      memory.setUint8(sp + 48, 1);
    },

    // func copyBytesToJS(dst ref, src []byte) (int, bool)
    "syscall/js.copyBytesToJS": (sp: number) => {
      sp >>>= 0;
      const dst = memory.loadValue(sp + 8);
      const src = memory.loadSlice(sp + 16);
      if (!(dst instanceof Uint8Array || dst instanceof Uint8ClampedArray)) {
        memory.setUint8(sp + 48, 0);
        return;
      }
      const toCopy = src.subarray(0, dst.length);
      dst.set(toCopy);
      memory.setInt64(sp + 40, toCopy.length);
      memory.setUint8(sp + 48, 1);
    },

    debug: (value: any) => {
      console.log(value);
    },
  };
}
