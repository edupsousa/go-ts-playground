declare class TinyGoWasm {
  constructor();
  run(instance: WebAssembly.Instance): Promise<void>;
  importObject: WebAssembly.Imports;
}

declare global {
  var Go: typeof TinyGoWasm;
  interface Window {
    Go: typeof TinyGoWasm;
  }
}

export {};
