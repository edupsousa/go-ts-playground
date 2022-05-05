import { GoWasm, GoWasmInstance, GoWasmMemory } from "./go";

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

type JsGoMemoryBuffer = {
  setUint8: (addr: number, v: number) => void;
  getInt32: (addr: number) => number;
  setInt32: (addr: number, v: number) => void;
  getUint32: (addr: number) => number;
  setUint32: (addr: number, v: number) => void;
  setInt64: (addr: number, v: number) => void;
  getInt64: (addr: number) => number;
  getFloat64: (addr: number) => number;
  setFloat64: (addr: number, v: number) => void;
  loadSlice: (addr: number) => Uint8Array;
  loadString: (addr: number) => string;
  setBuffer: (buffer: ArrayBuffer) => void;
  getBuffer: () => ArrayBuffer;
};

function initMemoryBuffer(): JsGoMemoryBuffer {
  let dataView = new DataView(new ArrayBuffer(0));

  function setInt64(addr: number, v: number) {
    dataView.setUint32(addr + 0, v, true);
    dataView.setUint32(addr + 4, Math.floor(v / 4294967296), true);
  }

  function getInt64(addr: number) {
    const low = dataView.getUint32(addr + 0, true);
    const high = dataView.getInt32(addr + 4, true);
    return low + high * 4294967296;
  }

  function setUint8(addr: number, v: number) {
    dataView.setUint8(addr, v);
  }

  function getInt32(addr: number) {
    return dataView.getInt32(addr, true);
  }

  function setInt32(addr: number, v: number) {
    dataView.setInt32(addr, v, true);
  }

  function getUint32(addr: number) {
    return dataView.getUint32(addr, true);
  }

  function setUint32(addr: number, v: number) {
    dataView.setUint32(addr, v, true);
  }

  function getFloat64(addr: number) {
    return dataView.getFloat64(addr, true);
  }

  function setFloat64(addr: number, v: number) {
    dataView.setFloat64(addr, v, true);
  }

  function loadSlice(addr: number) {
    const array = getInt64(addr + 0);
    const len = getInt64(addr + 8);
    return new Uint8Array(dataView.buffer, array, len);
  }

  function loadString(addr: number) {
    const saddr = getInt64(addr + 0);
    const len = getInt64(addr + 8);
    return decoder.decode(new DataView(dataView.buffer, saddr, len));
  }

  function getBuffer() {
    return dataView.buffer;
  }

  function setBuffer(buffer: ArrayBuffer) {
    dataView = new DataView(buffer);
  }

  return {
    setUint8,
    getInt32,
    setInt32,
    getUint32,
    setUint32,
    setInt64,
    getInt64,
    getFloat64,
    setFloat64,
    loadSlice,
    loadString,
    setBuffer,
    getBuffer,
  };
}

type JsGoMemoryRefs = {
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

function initMemoryRefs(
  jsGo: GoWasm,
  buffer: JsGoMemoryBuffer
): JsGoMemoryRefs {
  const values = [
    // JS values that Go currently has references to, indexed by reference id
    NaN,
    0,
    null,
    true,
    false,
    globalThis,
    jsGo,
  ];

  const goRefCounts = new Array(7).fill(Infinity); // number of references that Go has to a JS value, indexed by reference id

  // mapping from JS values to reference ids
  const ids = new Map<any, number>([
    [0, 1],
    [null, 2],
    [true, 3],
    [false, 4],
    [globalThis, 5],
    [jsGo, 6],
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

export type JsGoMemory = JsGoMemoryBuffer & JsGoMemoryRefs;

export function initJsGoMemory(jsGo: GoWasm): JsGoMemory {
  const buffer = initMemoryBuffer();
  const refs = initMemoryRefs(jsGo, buffer);

  return {
    ...buffer,
    ...refs,
  };
}
