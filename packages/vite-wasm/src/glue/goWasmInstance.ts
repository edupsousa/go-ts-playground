interface GoWasmExports extends WebAssembly.Exports {
  mem: WebAssembly.Memory;
  run: (argc: number, argv: number) => void;
  getsp: () => number;
  resume: () => void;
}

export interface GoWasmInstance extends WebAssembly.Instance {
  exports: GoWasmExports;
}

export function isGoWasmInstance(instance: any): instance is GoWasmInstance {
  const expected = [
    { name: "getsp", argc: 0, type: "function" },
    { name: "run", argc: 2, type: "function" },
    { name: "resume", argc: 0, type: "function" },
    { name: "mem", type: "object", objInstance: WebAssembly.Memory },
  ];

  return (
    typeof instance === "object" &&
    instance !== null &&
    typeof instance.exports === "object" &&
    instance.exports !== null &&
    expected.every(({ name, argc, type, objInstance }) => {
      const _export = instance.exports[name];
      return (
        typeof _export === type &&
        ((argc !== undefined && _export.length === argc) ||
          (objInstance !== undefined && _export instanceof objInstance))
      );
    })
  );
}
