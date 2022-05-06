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
  loadInstance: (instance: GoWasmInstance) => void;
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
export type JsGoSyscallJsApi = {
  _makeFuncWrapper: (id: number) => (...args: any[]) => any;
  _pendingEvent: null | JsGoPendingEvent;
};

globalThis.fs = fs;
globalThis.process = process;

export function createJsGo(): JsGo {
  let instance: GoWasmInstance | null = null;
  let exited = false;
  let _pendingEvent: null | JsGoPendingEvent = null;

  let resolveExitPromise = (_value?: unknown) => {};
  const exitPromise = new Promise((resolve) => {
    resolveExitPromise = resolve;
  });

  const syscallApi: JsGoSyscallJsApi = {
    _makeFuncWrapper,
    _pendingEvent,
  };

  const runtime: JsGoRuntimeApi = {
    exit,
    getsp,
    resetMemoryDataView,
    resume,
    memory: initJsGoMemory(syscallApi),
  };

  const jsGo: JsGo = {
    loadInstance,
    run,
    importObject: {
      go: initializeImports(runtime),
    },
  };

  function loadInstance(updatedInstance: GoWasmInstance) {
    instance = updatedInstance;
    resetMemoryDataView();
  }

  async function run(args: string[], env: Record<string, string>) {
    if (instance === null) throw new Error("Go Wasm Module not loaded");
    const { argc, argv } = runtime.memory.storeArguments(args, env);
    instance.exports.run(argc, argv);
    if (exited) {
      resolveExitPromise();
    }
    await exitPromise;
  }

  function exit(code: number): void {
    exited = true;
    if (code !== 0) {
      console.warn("exit code:", code);
    }
  }

  function getsp(): number {
    if (instance === null) throw new Error("Go Wasm Module not loaded");
    return instance.exports.getsp();
  }

  function resetMemoryDataView() {
    if (instance === null) throw new Error("Go Wasm Module not loaded");
    runtime.memory.setBuffer(instance.exports.mem.buffer);
  }

  function resume() {
    if (instance === null) throw new Error("Go Wasm Module not loaded");
    if (exited) {
      throw new Error("Go program has already exited");
    }
    instance.exports.resume();
    if (exited) {
      resolveExitPromise();
    }
  }

  function _makeFuncWrapper(id: number) {
    return function () {
      const event: JsGoPendingEvent = { id: id, this: this, args: arguments };
      _pendingEvent = event;
      resume();
      return event.result;
    };
  }

  return jsGo;
}
