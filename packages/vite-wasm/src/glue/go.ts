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

type JsGo = {
  loadModule: (module: GoWasmInstance) => void;
  run(args: string[], env: Record<string, string>): Promise<void>;
  importObject: WebAssembly.Imports & { go: JsGoImports };
};

type JsGoExternal = {
  exit: (code: number) => void;
  getsp: () => number;
  resetMemoryDataView: () => void;
  memory: JsGoMemory;
  sys: {
    fs: any;
  };
};

type GoEventHandler = {
  _makeFuncWrapper: (id: number) => (...args: any[]) => any;
  _pendingEvent: null | GoWasmPendingEvent;
  _resume: () => void;
};

export type JsGoInstance = JsGo & JsGoExternal & GoEventHandler;

export function createJsGoInstance(): JsGo {
  let _module: GoWasmInstance | null = null;
  let _exited = false;
  let _pendingEvent: null | GoWasmPendingEvent = null;
  let _resolveExitPromise = (_value?: unknown) => {};
  const _exitPromise = new Promise((resolve) => {
    _resolveExitPromise = resolve;
  });

  const jsGo = withMemoryAndImports({
    loadModule,
    exit,
    run,
    getsp,
    resetMemoryDataView,
    sys: {
      fs,
    },
    _makeFuncWrapper,
    _resume,
    _pendingEvent,
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
    _exited = true;
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

  return jsGo;
}
