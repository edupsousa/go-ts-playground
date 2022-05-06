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
