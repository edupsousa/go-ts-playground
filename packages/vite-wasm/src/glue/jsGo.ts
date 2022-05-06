import { GoWasmInstance } from "./goWasmInstance";
import { initializeImports, JsGoImports } from "./imports";
import { initJsGoMemory, JsGoMemory } from "./memory";
import { fs, process } from "./sys";

type GlobalThis = any & {
  fs: any;
  process: any;
};

declare var globalThis: GlobalThis;

type JsGoPendingEvent = {
  id: number;
  this: any;
  args: IArguments;
  result?: any;
};

/**
 * Methods and properties used to load and run Go WebAssembly modules.
 */
type JsGo = {
  loadModule: (module: GoWasmInstance) => void;
  run(args: string[], env: Record<string, string>): Promise<void>;
  importObject: WebAssembly.Imports & { go: JsGoImports };
};

/**
 * Methods and properties used by the Go imports to control the WebAssembly
 * instance execution.
 */
export type JsGoRuntimeApi = {
  exit: (code: number) => void;
  getsp: () => number;
  resetMemoryDataView: () => void;
  resume: () => void;
  memory: JsGoMemory;
};

/**
 * Those methods are used by the Go runtime to create and execute functions
 * callable from the JS code.
 */
export type JsGoEventHandlerApi = {
  _makeFuncWrapper: (id: number) => (...args: any[]) => any;
  _pendingEvent: null | JsGoPendingEvent;
};

type JsGoInstance = JsGo & JsGoEventHandlerApi & JsGoRuntimeApi;

globalThis.fs = fs;
globalThis.process = process;

export function createJsGoInstance(): JsGo {
  let _module: GoWasmInstance | null = null;
  let _exited = false;
  let _pendingEvent: null | JsGoPendingEvent = null;
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
    resume,
    _makeFuncWrapper,
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

  function resume() {
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
      const event: JsGoPendingEvent = { id: id, this: this, args: arguments };
      go._pendingEvent = event;
      go.resume();
      return event.result;
    };
  }

  return jsGo;
}
