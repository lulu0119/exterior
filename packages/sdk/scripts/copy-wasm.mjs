import { copyFile } from "node:fs/promises";

await copyFile(
  new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm")),
  new URL("../dist/client/codemode/quickjs.wasm", import.meta.url),
);
