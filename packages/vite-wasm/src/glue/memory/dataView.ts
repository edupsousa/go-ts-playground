const decoder = new TextDecoder("utf-8");

export type JsGoMemoryBuffer = {
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

export function initMemoryBuffer(): JsGoMemoryBuffer {
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
