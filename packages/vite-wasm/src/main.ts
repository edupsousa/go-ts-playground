import "./style.css";
import "./wasm/dist/wasm_exec.js";
import main from "./wasm/dist/main.wasm";

const go = new Go();
main(go.importObject).then((exports) => {
  console.info(`WASM Module Loaded via Vite`);
  const instance: WebAssembly.Instance = { exports };
  go.run(instance);
});

const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
  <h1>Hello Vite!</h1>
  <a href="https://vitejs.dev/guide/features.html" target="_blank">Documentation</a>
`;
