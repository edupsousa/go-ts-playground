import { JsGoSyscallJsApi } from "../jsGo";
import { initMemoryBuffer, JsGoMemoryBuffer } from "./dataView";
import { initMemoryRefs, JsGoMemoryRefs } from "./valueRefs";

export type JsGoMemory = JsGoMemoryBuffer & JsGoMemoryRefs;

export function initJsGoMemory(syscallApi: JsGoSyscallJsApi): JsGoMemory {
  const buffer = initMemoryBuffer();
  const refs = initMemoryRefs(buffer, syscallApi);

  return {
    ...buffer,
    ...refs,
  };
}
