import { JsGoSyscallJsApi } from "../jsGo";
import { JsGoMemoryBuffer } from "./dataView";

const encoder = new TextEncoder();

export type JsGoMemoryRefs = {
  loadValue: (addr: number) => any;
  loadSliceOfValues: (addr: number) => any[];
  storeValue: (addr: number, v: any) => void;
  removeRef: (id: number) => void;
  storeArguments: (
    args?: string[],
    env?: Record<string, string>
  ) => {
    argv: number;
    argc: number;
  };
};

export function initMemoryRefs(
  buffer: JsGoMemoryBuffer,
  syscallApi: JsGoSyscallJsApi
): JsGoMemoryRefs {
  const values = [
    // JS values that Go currently has references to, indexed by reference id
    NaN,
    0,
    null,
    true,
    false,
    globalThis,
    syscallApi,
  ];

  const goRefCounts = new Array(7).fill(Infinity); // number of references that Go has to a JS value, indexed by reference id

  // mapping from JS values to reference ids
  const ids = new Map<any, number>([
    [0, 1],
    [null, 2],
    [true, 3],
    [false, 4],
    [globalThis, 5],
    [syscallApi, 6],
  ]);

  // unused ids that have been garbage collected
  const idPool = [] as number[];

  function loadValue(addr: number) {
    const f = buffer.getFloat64(addr);
    if (f === 0) {
      return undefined;
    }
    if (!isNaN(f)) {
      return f;
    }

    const id = buffer.getUint32(addr);
    return values[id];
  }

  function loadSliceOfValues(addr: number) {
    const array = buffer.getInt64(addr + 0);
    const len = buffer.getInt64(addr + 8);
    const a = new Array(len);
    for (let i = 0; i < len; i++) {
      a[i] = loadValue(array + i * 8);
    }
    return a;
  }

  function storeValue(addr: number, v: any) {
    const nanHead = 0x7ff80000;

    if (typeof v === "number" && v !== 0) {
      if (isNaN(v)) {
        buffer.setUint32(addr + 4, nanHead);
        buffer.setUint32(addr, 0);
        return;
      }
      buffer.setFloat64(addr, v);
      return;
    }

    if (v === undefined) {
      buffer.setFloat64(addr, 0);
      return;
    }

    let id = ids.get(v);
    if (id === undefined) {
      id = idPool.pop();
      if (id === undefined) {
        id = values.length;
      }
      values[id] = v;
      goRefCounts[id] = 0;
      ids.set(v, id);
    }
    goRefCounts[id]++;
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
    buffer.setUint32(addr + 4, nanHead | typeFlag);
    buffer.setUint32(addr, id);
  }

  function removeRef(id: number) {
    goRefCounts[id]--;
    if (goRefCounts[id] === 0) {
      const v = values[id];
      values[id] = null;
      ids.delete(v);
      idPool.push(id);
    }
  }

  function storeArguments(
    args: string[] = [],
    env: Record<string, string> = {}
  ): { argv: number; argc: number } {
    // Pass command line arguments and environment variables to WebAssembly by writing them to the linear memory.
    let offset = 4096;

    const strPtr = (str: string) => {
      const ptr = offset;
      const bytes = encoder.encode(str + "\0");
      new Uint8Array(buffer.getBuffer(), offset, bytes.length).set(bytes);
      offset += bytes.length;
      if (offset % 8 !== 0) {
        offset += 8 - (offset % 8);
      }
      return ptr;
    };

    const argc = args.length;

    const argvPtrs: number[] = [];
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
      buffer.setUint32(offset, ptr);
      buffer.setUint32(offset + 4, 0);
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

  return {
    loadValue,
    loadSliceOfValues,
    storeValue,
    removeRef,
    storeArguments,
  };
}
