import { JsGoInstance } from "../go";
import { initMemoryBuffer, JsGoMemoryBuffer } from "./dataView";
import { initMemoryRefs, JsGoMemoryRefs } from "./valueRefs";

export type JsGoMemory = JsGoMemoryBuffer & JsGoMemoryRefs;

export function initJsGoMemory(jsGo: Partial<JsGoInstance>): JsGoMemory {
  const buffer = initMemoryBuffer();
  const refs = initMemoryRefs(buffer, jsGo);

  return {
    ...buffer,
    ...refs,
  };
}
