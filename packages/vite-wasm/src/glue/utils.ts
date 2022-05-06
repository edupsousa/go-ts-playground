/**
 * This function creates a WebAssembly instance from the exports object,
 * useful when the WebAssembly module is loaded using Rollup/Vite plugin.
 *
 * @param exports WebAssembly Instance Exports
 * @returns
 */
export function createWasmInstance(
  exports: WebAssembly.Exports
): WebAssembly.Instance {
  const instance = Object.setPrototypeOf(
    { exports },
    WebAssembly.Instance.prototype
  );
  return instance;
}
