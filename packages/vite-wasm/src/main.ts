import "./style.css";
import main from "./wasm/dist/go.wasm";
import { createFromExports, GoWasm } from "./go";

const go = new GoWasm();
main(go.importObject).then((exports) => {
  console.info(`WASM Module Loaded via Vite`);
  const instance = createFromExports(exports);
  go.run(instance);
});

const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
  <h1>Hello Vite!</h1>
  <a href="https://vitejs.dev/guide/features.html" target="_blank">Documentation</a>
`;
