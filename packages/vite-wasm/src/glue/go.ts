import { initializeImports } from "./imports";
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

  private _inst: JsGoInstance;

  constructor() {
    this._inst = initJsGoInstance();

    this.argv = ["js"];
    this.env = {};

    this.importObject = {
      go: initializeImports(this._inst),
    };
  }

  async run(instance: GoWasmInstance) {
    this._inst.loadModule(instance);

    this._inst.run(this.argv, this.env);
    if (this.exited) {
      this._inst._exitPromise;
    }
    await this._inst._exitPromise;
  }
}

export type JsGoInstance = {
  loadModule: (module: GoWasmInstance) => void;
  run(args: string[], env: Record<string, string>): void;
  exit: (code: number) => void;
  getsp: () => number;
  resetMemoryDataView: () => void;
  memory: JsGoMemory;
  timeouts: {
    schedule: (timeout: number) => number;
    getTimeoutId: (id: number) => number | undefined;
    remove: (id: number) => void;
  };
  timeOrigin: number;
  sys: {
    fs: any;
  };
  _exitPromise: Promise<unknown>;
  _makeFuncWrapper: (id: number) => (...args: any[]) => any;
  _resume: () => void;
  _pendingEvent: null | GoWasmPendingEvent;
  _resolveExitPromise: (_value?: unknown) => void;
};

function initJsGoInstance(): JsGoInstance {
  let _module: GoWasmInstance | null = null;
  let _exited = false;
  let _pendingEvent: null | GoWasmPendingEvent = null;
  let _resolveExitPromise = (_value?: unknown) => {};
  const _exitPromise = new Promise((resolve) => {
    _resolveExitPromise = resolve;
  });

  const jsGo = withMemory({
    timeOrigin: Date.now() - performance.now(),
    timeouts: initTimeouts(),
    loadModule,
    exit,
    run,
    getsp,
    resetMemoryDataView,
    sys: {
      fs,
    },
    _exitPromise,
    _makeFuncWrapper,
    _resume,
    _pendingEvent,
    _resolveExitPromise,
  });

  function withMemory(jsGo: Omit<JsGoInstance, "memory">): JsGoInstance {
    (jsGo as JsGoInstance).memory = initJsGoMemory(jsGo);
    return jsGo as JsGoInstance;
  }

  function loadModule(module: GoWasmInstance) {
    _module = module;
    resetMemoryDataView();
  }

  function run(args: string[], env: Record<string, string>) {
    if (_module === null) throw new Error("Go Wasm Module not loaded");
    const { argc, argv } = jsGo.memory.storeArguments(args, env);
    _module.exports.run(argc, argv);
  }

  function exit(code: number): void {
    if (code !== 0) {
      console.warn("exit code:", code);
    }
  }

  function getsp(): number {
    if (_module === null) throw new Error("Go Wasm Module not loaded");
    return _module.exports.getsp();
  }

  function resetMemoryDataView() {
    if (_module === null) throw new Error("Go Wasm Module not loaded");
    jsGo.memory.setBuffer(_module.exports.mem.buffer);
  }

  function _resume() {
    if (_module === null) throw new Error("Go Wasm Module not loaded");
    if (_exited) {
      throw new Error("Go program has already exited");
    }
    _module.exports.resume();
    if (_exited) {
      _resolveExitPromise();
    }
  }

  function _makeFuncWrapper(id: number) {
    const go = jsGo;
    return function () {
      const event: GoWasmPendingEvent = { id: id, this: this, args: arguments };
      go._pendingEvent = event;
      go._resume();
      return event.result;
    };
  }

  function initTimeouts() {
    const _scheduledTimeouts: Map<number, number> = new Map();
    let _nextCallbackTimeoutID: number = 1;

    function schedule(timeout: number) {
      const id = _nextCallbackTimeoutID;
      _nextCallbackTimeoutID++;
      _scheduledTimeouts.set(
        id,
        setTimeout(
          () => {
            _resume();
            while (_scheduledTimeouts.has(id)) {
              // for some reason Go failed to register the timeout event, log and try again
              // (temporary workaround for https://github.com/golang/go/issues/28975)
              console.warn("scheduleTimeoutEvent: missed timeout event");
              _resume();
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

  return jsGo;
}
