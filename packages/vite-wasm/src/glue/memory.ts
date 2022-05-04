import { GoWasm, GoWasmInstance, GoWasmMemory } from "./go";

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

export function createGoWasmMemory(jsGo: GoWasm): GoWasmMemory {
  const data = {
    instance: {} as GoWasmInstance,
    buffer: new DataView(new ArrayBuffer(0)),
    _values: [
      // JS values that Go currently has references to, indexed by reference id
      NaN,
      0,
      null,
      true,
      false,
      globalThis,
      jsGo,
    ],
    _goRefCounts: new Array(7).fill(Infinity), // number of references that Go has to a JS value, indexed by reference id
    _ids: new Map<any, number>([
      // mapping from JS values to reference ids
      [0, 1],
      [null, 2],
      [true, 3],
      [false, 4],
      [globalThis, 5],
      [jsGo, 6],
    ]),
    _idPool: [] as number[], // unused ids that have been garbage collected
  };

  function storeArguments(
    args: string[] = [],
    env: Record<string, string> = {}
  ): { argv: number; argc: number } {
    // Pass command line arguments and environment variables to WebAssembly by writing them to the linear memory.
    let offset = 4096;

    const strPtr = (str: string) => {
      const ptr = offset;
      const bytes = encoder.encode(str + "\0");
      new Uint8Array(data.buffer.buffer, offset, bytes.length).set(bytes);
      offset += bytes.length;
      if (offset % 8 !== 0) {
        offset += 8 - (offset % 8);
      }
      return ptr;
    };

    const argc = args.length;

    const argvPtrs = [];
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
      data.buffer.setUint32(offset, ptr, true);
      data.buffer.setUint32(offset + 4, 0, true);
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

  function setInt64(addr: number, v: number) {
    data.buffer.setUint32(addr + 0, v, true);
    data.buffer.setUint32(addr + 4, Math.floor(v / 4294967296), true);
  }

  function getInt64(addr: number) {
    const low = data.buffer.getUint32(addr + 0, true);
    const high = data.buffer.getInt32(addr + 4, true);
    return low + high * 4294967296;
  }

  function loadValue(addr: number) {
    const f = data.buffer.getFloat64(addr, true);
    if (f === 0) {
      return undefined;
    }
    if (!isNaN(f)) {
      return f;
    }

    const id = data.buffer.getUint32(addr, true);
    return data._values[id];
  }

  function storeValue(addr: number, v: any) {
    const nanHead = 0x7ff80000;

    if (typeof v === "number" && v !== 0) {
      if (isNaN(v)) {
        data.buffer.setUint32(addr + 4, nanHead, true);
        data.buffer.setUint32(addr, 0, true);
        return;
      }
      data.buffer.setFloat64(addr, v, true);
      return;
    }

    if (v === undefined) {
      data.buffer.setFloat64(addr, 0, true);
      return;
    }

    let id = data._ids.get(v);
    if (id === undefined) {
      id = data._idPool.pop();
      if (id === undefined) {
        id = data._values.length;
      }
      data._values[id] = v;
      data._goRefCounts[id] = 0;
      data._ids.set(v, id);
    }
    data._goRefCounts[id]++;
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
    data.buffer.setUint32(addr + 4, nanHead | typeFlag, true);
    data.buffer.setUint32(addr, id, true);
  }

  function loadSlice(addr: number) {
    const array = getInt64(addr + 0);
    const len = getInt64(addr + 8);
    return new Uint8Array(data.instance.exports.mem.buffer, array, len);
  }

  function loadSliceOfValues(addr: number) {
    const array = getInt64(addr + 0);
    const len = getInt64(addr + 8);
    const a = new Array(len);
    for (let i = 0; i < len; i++) {
      a[i] = loadValue(array + i * 8);
    }
    return a;
  }

  function loadString(addr: number) {
    const saddr = getInt64(addr + 0);
    const len = getInt64(addr + 8);
    return decoder.decode(
      new DataView(data.instance.exports.mem.buffer, saddr, len)
    );
  }

  function removeRef(id: number) {
    data._goRefCounts[id]--;
    if (data._goRefCounts[id] === 0) {
      const v = data._values[id];
      data._values[id] = null;
      data._ids.delete(v);
      data._idPool.push(id);
    }
  }

  function updateDataBuffer(buffer: ArrayBuffer) {
    data.buffer = new DataView(buffer);
  }

  function setInstance(instance: GoWasmInstance) {
    data.instance = instance;
    updateDataBuffer(instance.exports.mem.buffer);
  }

  return {
    setUint8: (addr: number, v: number) => data.buffer.setUint8(addr, v),
    getInt32: (addr: number) => data.buffer.getInt32(addr, true),
    setInt32: (addr: number, v: number) => data.buffer.setInt32(addr, v, true),
    getUint32: (addr: number) => data.buffer.getUint32(addr, true),
    setInt64,
    getInt64,
    loadValue,
    storeValue,
    loadSlice,
    loadSliceOfValues,
    loadString,
    storeArguments,
    removeRef,
    setInstance,
    updateDataBuffer,
  };
}
