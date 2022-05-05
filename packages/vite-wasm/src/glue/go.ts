import { initJsGoMemory, JsGoMemory } from "./memory";
import { fs, process } from "./sys";

type GlobalThis = any & {
  fs: any;
  process: any;
};

declare var globalThis: GlobalThis;

globalThis.fs = fs;
globalThis.process = process;

type GoWasmPendingEvent = {
  id: number;
  this: any;
  args: IArguments;
  result?: any;
};

interface GoWasmExports extends WebAssembly.Exports {
  mem: WebAssembly.Memory;
  run: (argc: number, argv: number) => void;
  getsp: () => number;
  resume: () => void;
}

export interface GoWasmInstance extends WebAssembly.Instance {
  exports: GoWasmExports;
}

const encoder = new TextEncoder();

export function createFromExports(
  exports: WebAssembly.Exports
): GoWasmInstance {
  const instance = Object.setPrototypeOf(
    { exports },
    WebAssembly.Instance.prototype
  );
  return instance;
}

export type GoWasmMemory = {
  setUint8: (addr: number, v: number) => void;
  getInt32: (addr: number) => number;
  setInt32: (addr: number, v: number) => void;
  getUint32: (addr: number) => number;
  setInt64: (addr: number, v: number) => void;
  getInt64: (addr: number) => number;
  loadValue: (addr: number) => any;
  storeValue: (addr: number, v: any) => void;
  loadSlice: (addr: number) => Uint8Array;
  loadSliceOfValues: (addr: number) => any[];
  loadString: (addr: number) => string;
  storeArguments: (
    args: string[],
    env: Record<string, string>
  ) => { argc: number; argv: number };
  removeRef: (id: number) => void;
  setInstance: (instance: GoWasmInstance) => void;
  updateDataBuffer: (buffer: ArrayBuffer) => void;
};

export class GoWasm {
  public argv: string[];
  public env: Record<string, string>;
  public importObject: WebAssembly.Imports;
  public exited = false;
  public outputBuf: string;

  private _inst: GoWasmInstance;
  private _exitPromise: Promise<void>;
  private _resolveExitPromise: () => void;
  // * It's used on the Go side (https://github.com/golang/go/blob/0b0d2fe66d2348fa694a925595807859bf08a391/src/syscall/js/func.go#L69)
  private _pendingEvent: null | GoWasmPendingEvent;
  private _scheduledTimeouts: Map<number, number>;
  private _nextCallbackTimeoutID: number;
  private _memory: JsGoMemory;

  constructor() {
    this._resolveExitPromise = () => {};
    this._inst = {} as GoWasmInstance;
    this._memory = initJsGoMemory(this);

    this.argv = ["js"];
    this.env = {};
    this._exitPromise = new Promise((resolve) => {
      this._resolveExitPromise = resolve;
    });
    this.outputBuf = "";
    this._pendingEvent = null;
    this._scheduledTimeouts = new Map();
    this._nextCallbackTimeoutID = 1;

    const timeOrigin = Date.now() - performance.now();
    this.importObject = {
      go: {
        // Go's SP does not change as long as no Go code is running. Some operations (e.g. calls, getters and setters)
        // may synchronously trigger a Go event handler. This makes Go code get executed in the middle of the imported
        // function. A goroutine can switch to a new stack if the current stack is too small (see morestack function).
        // This changes the SP, thus we have to update the SP used by the imported function.

        // func wasmExit(code int32)
        "runtime.wasmExit": (sp: number) => {
          sp >>>= 0;
          const code = this._memory.getInt32(sp + 8);
          this.exited = true;
          // delete this._inst;
          // delete this._values;
          // delete this._goRefCounts;
          // delete this._ids;
          // delete this._idPool;
          this.exit(code);
        },

        // func wasmWrite(fd uintptr, p unsafe.Pointer, n int32)
        "runtime.wasmWrite": (sp: number) => {
          sp >>>= 0;
          const fd = this._memory.getInt64(sp + 8);
          const p = this._memory.getInt64(sp + 16);
          const n = this._memory.getInt32(sp + 24);
          fs.writeSync(fd, new Uint8Array(this._inst.exports.mem.buffer, p, n));
        },

        // func resetMemoryDataView()
        "runtime.resetMemoryDataView": (sp: number) => {
          sp >>>= 0;
          this._memory.setBuffer(this._inst.exports.mem.buffer);
        },

        // func nanotime1() int64
        "runtime.nanotime1": (sp: number) => {
          sp >>>= 0;
          this._memory.setInt64(
            sp + 8,
            (timeOrigin + performance.now()) * 1000000
          );
        },

        // func walltime() (sec int64, nsec int32)
        "runtime.walltime": (sp: number) => {
          sp >>>= 0;
          const msec = new Date().getTime();
          this._memory.setInt64(sp + 8, msec / 1000);
          this._memory.setInt32(sp + 16, (msec % 1000) * 1000000);
        },

        // func scheduleTimeoutEvent(delay int64) int32
        "runtime.scheduleTimeoutEvent": (sp: number) => {
          sp >>>= 0;
          const id = this._nextCallbackTimeoutID;
          this._nextCallbackTimeoutID++;
          this._scheduledTimeouts.set(
            id,
            setTimeout(
              () => {
                this._resume();
                while (this._scheduledTimeouts.has(id)) {
                  // for some reason Go failed to register the timeout event, log and try again
                  // (temporary workaround for https://github.com/golang/go/issues/28975)
                  console.warn("scheduleTimeoutEvent: missed timeout event");
                  this._resume();
                }
              },
              this._memory.getInt64(sp + 8) + 1 // setTimeout has been seen to fire up to 1 millisecond early
            )
          );
          this._memory.setInt32(sp + 16, id);
        },

        // func clearTimeoutEvent(id int32)
        "runtime.clearTimeoutEvent": (sp: number) => {
          sp >>>= 0;
          const id = this._memory.getInt32(sp + 8);
          const timeoutId = this._scheduledTimeouts.get(id);
          if (timeoutId === undefined) return;
          clearTimeout(timeoutId);
          this._scheduledTimeouts.delete(id);
        },

        // func getRandomData(r []byte)
        "runtime.getRandomData": (sp: number) => {
          sp >>>= 0;
          crypto.getRandomValues(this._memory.loadSlice(sp + 8));
        },

        // func finalizeRef(v ref)
        "syscall/js.finalizeRef": (sp: number) => {
          sp >>>= 0;
          const id = this._memory.getUint32(sp + 8);
          this._memory.removeRef(id);
        },

        // func stringVal(value string) ref
        "syscall/js.stringVal": (sp: number) => {
          sp >>>= 0;
          this._memory.storeValue(sp + 24, this._memory.loadString(sp + 8));
        },

        // func valueGet(v ref, p string) ref
        "syscall/js.valueGet": (sp: number) => {
          sp >>>= 0;
          const result = Reflect.get(
            this._memory.loadValue(sp + 8),
            this._memory.loadString(sp + 16)
          );
          sp = this._inst.exports.getsp() >>> 0; // see comment above
          this._memory.storeValue(sp + 32, result);
        },

        // func valueSet(v ref, p string, x ref)
        "syscall/js.valueSet": (sp: number) => {
          sp >>>= 0;
          Reflect.set(
            this._memory.loadValue(sp + 8),
            this._memory.loadString(sp + 16),
            this._memory.loadValue(sp + 32)
          );
        },

        // func valueDelete(v ref, p string)
        "syscall/js.valueDelete": (sp: number) => {
          sp >>>= 0;
          Reflect.deleteProperty(
            this._memory.loadValue(sp + 8),
            this._memory.loadString(sp + 16)
          );
        },

        // func valueIndex(v ref, i int) ref
        "syscall/js.valueIndex": (sp: number) => {
          sp >>>= 0;
          this._memory.storeValue(
            sp + 24,
            Reflect.get(
              this._memory.loadValue(sp + 8),
              this._memory.getInt64(sp + 16)
            )
          );
        },

        // valueSetIndex(v ref, i int, x ref)
        "syscall/js.valueSetIndex": (sp: number) => {
          sp >>>= 0;
          Reflect.set(
            this._memory.loadValue(sp + 8),
            this._memory.getInt64(sp + 16),
            this._memory.loadValue(sp + 24)
          );
        },

        // func valueCall(v ref, m string, args []ref) (ref, bool)
        "syscall/js.valueCall": (sp: number) => {
          sp >>>= 0;
          try {
            const v = this._memory.loadValue(sp + 8);
            const m = Reflect.get(v, this._memory.loadString(sp + 16));
            const args = this._memory.loadSliceOfValues(sp + 32);
            const result = Reflect.apply(m, v, args);
            sp = this._inst.exports.getsp() >>> 0; // see comment above
            this._memory.storeValue(sp + 56, result);
            this._memory.setUint8(sp + 64, 1);
          } catch (err) {
            sp = this._inst.exports.getsp() >>> 0; // see comment above
            this._memory.storeValue(sp + 56, err);
            this._memory.setUint8(sp + 64, 0);
          }
        },

        // func valueInvoke(v ref, args []ref) (ref, bool)
        "syscall/js.valueInvoke": (sp: number) => {
          sp >>>= 0;
          try {
            const v = this._memory.loadValue(sp + 8);
            const args = this._memory.loadSliceOfValues(sp + 16);
            const result = Reflect.apply(v, undefined, args);
            sp = this._inst.exports.getsp() >>> 0; // see comment above
            this._memory.storeValue(sp + 40, result);
            this._memory.setUint8(sp + 48, 1);
          } catch (err) {
            sp = this._inst.exports.getsp() >>> 0; // see comment above
            this._memory.storeValue(sp + 40, err);
            this._memory.setUint8(sp + 48, 0);
          }
        },

        // func valueNew(v ref, args []ref) (ref, bool)
        "syscall/js.valueNew": (sp: number) => {
          sp >>>= 0;
          try {
            const v = this._memory.loadValue(sp + 8);
            const args = this._memory.loadSliceOfValues(sp + 16);
            const result = Reflect.construct(v, args);
            sp = this._inst.exports.getsp() >>> 0; // see comment above
            this._memory.storeValue(sp + 40, result);
            this._memory.setUint8(sp + 48, 1);
          } catch (err) {
            sp = this._inst.exports.getsp() >>> 0; // see comment above
            this._memory.storeValue(sp + 40, err);
            this._memory.setUint8(sp + 48, 0);
          }
        },

        // func valueLength(v ref) int
        "syscall/js.valueLength": (sp: number) => {
          sp >>>= 0;
          this._memory.setInt64(
            sp + 16,
            parseInt(this._memory.loadValue(sp + 8).length)
          );
        },

        // valuePrepareString(v ref) (ref, int)
        "syscall/js.valuePrepareString": (sp: number) => {
          sp >>>= 0;
          const str = encoder.encode(String(this._memory.loadValue(sp + 8)));
          this._memory.storeValue(sp + 16, str);
          this._memory.setInt64(sp + 24, str.length);
        },

        // valueLoadString(v ref, b []byte)
        "syscall/js.valueLoadString": (sp: number) => {
          sp >>>= 0;
          const str = this._memory.loadValue(sp + 8);
          this._memory.loadSlice(sp + 16).set(str);
        },

        // func valueInstanceOf(v ref, t ref) bool
        "syscall/js.valueInstanceOf": (sp: number) => {
          sp >>>= 0;
          this._memory.setUint8(
            sp + 24,
            this._memory.loadValue(sp + 8) instanceof
              this._memory.loadValue(sp + 16)
              ? 1
              : 0
          );
        },

        // func copyBytesToGo(dst []byte, src ref) (int, bool)
        "syscall/js.copyBytesToGo": (sp: number) => {
          sp >>>= 0;
          const dst = this._memory.loadSlice(sp + 8);
          const src = this._memory.loadValue(sp + 32);
          if (
            !(src instanceof Uint8Array || src instanceof Uint8ClampedArray)
          ) {
            this._memory.setUint8(sp + 48, 0);
            return;
          }
          const toCopy = src.subarray(0, dst.length);
          dst.set(toCopy);
          this._memory.setInt64(sp + 40, toCopy.length);
          this._memory.setUint8(sp + 48, 1);
        },

        // func copyBytesToJS(dst ref, src []byte) (int, bool)
        "syscall/js.copyBytesToJS": (sp: number) => {
          sp >>>= 0;
          const dst = this._memory.loadValue(sp + 8);
          const src = this._memory.loadSlice(sp + 16);
          if (
            !(dst instanceof Uint8Array || dst instanceof Uint8ClampedArray)
          ) {
            this._memory.setUint8(sp + 48, 0);
            return;
          }
          const toCopy = src.subarray(0, dst.length);
          dst.set(toCopy);
          this._memory.setInt64(sp + 40, toCopy.length);
          this._memory.setUint8(sp + 48, 1);
        },

        debug: (value: any) => {
          console.log(value);
        },
      },
    };
  }

  exit(code: number): void {
    if (code !== 0) {
      console.warn("exit code:", code);
    }
  }

  async run(instance: GoWasmInstance) {
    this._inst = instance;
    this._memory.setBuffer(instance.exports.mem.buffer);

    this.exited = false; // whether the Go program has exited
    const { argc, argv } = this._memory.storeArguments(this.argv, this.env);
    this._inst.exports.run(argc, argv);
    if (this.exited) {
      this._resolveExitPromise();
    }
    await this._exitPromise;
  }

  _resume() {
    if (this.exited) {
      throw new Error("Go program has already exited");
    }
    this._inst.exports.resume();
    if (this.exited) {
      this._resolveExitPromise();
    }
  }

  _makeFuncWrapper(id: number) {
    const go = this;
    return function () {
      const event: GoWasmPendingEvent = { id: id, this: this, args: arguments };
      go._pendingEvent = event;
      go._resume();
      return event.result;
    };
  }
}
