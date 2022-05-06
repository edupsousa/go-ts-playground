import { createFromExports } from "./glue/goWasmInstance";
import { createJsGo } from "./glue/jsGo";
import "./style.css";
import main from "./wasm/dist/go.wasm";

const go = createJsGo();
main(go.importObject).then((exports) => {
  console.info(`WASM Module Loaded via Vite`);
  const instance = createFromExports(exports);
  go.loadModule(instance);
  go.run(["js"], {});
});

const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
  <h1>Hello Vite!</h1>
  <a href="https://vitejs.dev/guide/features.html" target="_blank">Documentation</a>
`;
