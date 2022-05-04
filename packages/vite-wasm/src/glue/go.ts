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

interface GoWasmInstance extends WebAssembly.Instance {
  exports: GoWasmExports;
}

const decoder = new TextDecoder("utf-8");
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

type GoWasmMemory = {
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

function createGoWasmMemory(jsGo: GoWasm): GoWasmMemory {
  const data = {
    instance: {} as GoWasmInstance,
    buffer: new DataView(new ArrayBuffer(0)),
    _values: [
      // JS values that Go currently has references to, indexed by reference id
      NaN,
      0,
      null,
      true,
      false,
      globalThis,
      jsGo,
    ],
    _goRefCounts: new Array(7).fill(Infinity), // number of references that Go has to a JS value, indexed by reference id
    _ids: new Map<any, number>([
      // mapping from JS values to reference ids
      [0, 1],
      [null, 2],
      [true, 3],
      [false, 4],
      [globalThis, 5],
      [jsGo, 6],
    ]),
    _idPool: [] as number[], // unused ids that have been garbage collected
  };

  function storeArguments(
    args: string[] = [],
    env: Record<string, string> = {}
  ): { argv: number; argc: number } {
    // Pass command line arguments and environment variables to WebAssembly by writing them to the linear memory.
    let offset = 4096;

    const strPtr = (str: string) => {
      const ptr = offset;
      const bytes = encoder.encode(str + "\0");
      new Uint8Array(data.buffer.buffer, offset, bytes.length).set(bytes);
      offset += bytes.length;
      if (offset % 8 !== 0) {
        offset += 8 - (offset % 8);
      }
      return ptr;
    };

    const argc = args.length;

    const argvPtrs = [];
    args.forEach((arg) => {
      argvPtrs.push(strPtr(arg));
    });
    argvPtrs.push(0);

    const keys = Object.keys(env).sort();
    keys.forEach((key) => {
      argvPtrs.push(strPtr(`${key}=${env[key]}`));
    });
    argvPtrs.push(0);

    const argv = offset;
    argvPtrs.forEach((ptr) => {
      data.buffer.setUint32(offset, ptr, true);
      data.buffer.setUint32(offset + 4, 0, true);
      offset += 8;
    });

    // The linker guarantees global data starts from at least wasmMinDataAddr.
    // Keep in sync with cmd/link/internal/ld/data.go:wasmMinDataAddr.
    const wasmMinDataAddr = 4096 + 8192;
    if (offset >= wasmMinDataAddr) {
      throw new Error(
        "total length of command line and environment variables exceeds limit"
      );
    }
    return { argc, argv };
  }

  function setInt64(addr: number, v: number) {
    data.buffer.setUint32(addr + 0, v, true);
    data.buffer.setUint32(addr + 4, Math.floor(v / 4294967296), true);
  }

  function getInt64(addr: number) {
    const low = data.buffer.getUint32(addr + 0, true);
    const high = data.buffer.getInt32(addr + 4, true);
    return low + high * 4294967296;
  }

  function loadValue(addr: number) {
    const f = data.buffer.getFloat64(addr, true);
    if (f === 0) {
      return undefined;
    }
    if (!isNaN(f)) {
      return f;
    }

    const id = data.buffer.getUint32(addr, true);
    return data._values[id];
  }

  function storeValue(addr: number, v: any) {
    const nanHead = 0x7ff80000;

    if (typeof v === "number" && v !== 0) {
      if (isNaN(v)) {
        data.buffer.setUint32(addr + 4, nanHead, true);
        data.buffer.setUint32(addr, 0, true);
        return;
      }
      data.buffer.setFloat64(addr, v, true);
      return;
    }

    if (v === undefined) {
      data.buffer.setFloat64(addr, 0, true);
      return;
    }

    let id = data._ids.get(v);
    if (id === undefined) {
      id = data._idPool.pop();
      if (id === undefined) {
        id = data._values.length;
      }
      data._values[id] = v;
      data._goRefCounts[id] = 0;
      data._ids.set(v, id);
    }
    data._goRefCounts[id]++;
    let typeFlag = 0;
    switch (typeof v) {
      case "object":
        if (v !== null) {
          typeFlag = 1;
        }
        break;
      case "string":
        typeFlag = 2;
        break;
      case "symbol":
        typeFlag = 3;
        break;
      case "function":
        typeFlag = 4;
        break;
    }
    data.buffer.setUint32(addr + 4, nanHead | typeFlag, true);
    data.buffer.setUint32(addr, id, true);
  }

  function loadSlice(addr: number) {
    const array = getInt64(addr + 0);
    const len = getInt64(addr + 8);
    return new Uint8Array(data.instance.exports.mem.buffer, array, len);
  }

  function loadSliceOfValues(addr: number) {
    const array = getInt64(addr + 0);
    const len = getInt64(addr + 8);
    const a = new Array(len);
    for (let i = 0; i < len; i++) {
      a[i] = loadValue(array + i * 8);
    }
    return a;
  }

  function loadString(addr: number) {
    const saddr = getInt64(addr + 0);
    const len = getInt64(addr + 8);
    return decoder.decode(
      new DataView(data.instance.exports.mem.buffer, saddr, len)
    );
  }

  function removeRef(id: number) {
    data._goRefCounts[id]--;
    if (data._goRefCounts[id] === 0) {
      const v = data._values[id];
      data._values[id] = null;
      data._ids.delete(v);
      data._idPool.push(id);
    }
  }

  function updateDataBuffer(buffer: ArrayBuffer) {
    data.buffer = new DataView(buffer);
  }

  function setInstance(instance: GoWasmInstance) {
    data.instance = instance;
    updateDataBuffer(instance.exports.mem.buffer);
  }

  return {
    setUint8: (addr: number, v: number) => data.buffer.setUint8(addr, v),
    getInt32: (addr: number) => data.buffer.getInt32(addr, true),
    setInt32: (addr: number, v: number) => data.buffer.setInt32(addr, v, true),
    getUint32: (addr: number) => data.buffer.getUint32(addr, true),
    setInt64,
    getInt64,
    loadValue,
    storeValue,
    loadSlice,
    loadSliceOfValues,
    loadString,
    storeArguments,
    removeRef,
    setInstance,
    updateDataBuffer,
  };
}

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
  private _memory: GoWasmMemory;

  constructor() {
    this._resolveExitPromise = () => {};
    this._inst = {} as GoWasmInstance;
    this._memory = createGoWasmMemory(this);

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
          this._memory.updateDataBuffer(this._inst.exports.mem.buffer);
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
    this._memory.setInstance(instance);

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
