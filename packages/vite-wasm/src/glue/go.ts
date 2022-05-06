import { initializeImports, JsGoImports } from "./imports";
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

export type JsGoInstance = {
  loadModule: (module: GoWasmInstance) => void;
  run(args: string[], env: Record<string, string>): Promise<void>;
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
  importObject: WebAssembly.Imports & { go: JsGoImports };
  _exitPromise: Promise<unknown>;
  _makeFuncWrapper: (id: number) => (...args: any[]) => any;
  _resume: () => void;
  _pendingEvent: null | GoWasmPendingEvent;
  _resolveExitPromise: (_value?: unknown) => void;
};

export function createJsGoInstance(): JsGoInstance {
  let _module: GoWasmInstance | null = null;
  let _exited = false;
  let _pendingEvent: null | GoWasmPendingEvent = null;
  let _resolveExitPromise = (_value?: unknown) => {};
  const _exitPromise = new Promise((resolve) => {
    _resolveExitPromise = resolve;
  });

  const jsGo = withMemoryAndImports({
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

  function withMemoryAndImports(
    jsGo: Omit<JsGoInstance, "memory" | "importObject">
  ): JsGoInstance {
    (jsGo as JsGoInstance).memory = initJsGoMemory(jsGo);
    (jsGo as JsGoInstance).importObject = {
      go: initializeImports(jsGo as Omit<JsGoInstance, "importObject">),
    };
    return jsGo as JsGoInstance;
  }

  function loadModule(module: GoWasmInstance) {
    _module = module;
    resetMemoryDataView();
  }

  async function run(args: string[], env: Record<string, string>) {
    if (_module === null) throw new Error("Go Wasm Module not loaded");
    const { argc, argv } = jsGo.memory.storeArguments(args, env);
    _module.exports.run(argc, argv);
    if (_exited) {
      _resolveExitPromise();
    }
    await _exitPromise;
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
