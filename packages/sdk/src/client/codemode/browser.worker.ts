import { serveCodemodeRemote } from "@earendil-works/pi-codemode/portable";
import { defineInvoke, defineInvokeHandler } from "@moeru/eventa";
import { createContext } from "@moeru/eventa/adapters/webworkers/worker";

import { exchangeEvent, executeEvent } from "./protocol.js";

const { context } = createContext();
const exchange = defineInvoke(context, exchangeEvent);

defineInvokeHandler(context, executeEvent, (request) => {
  const wasm = fetch(new URL("./quickjs.wasm", import.meta.url)).then(async (response) => {
    if (!response.ok) throw new Error(`QuickJS WASM request failed with HTTP ${response.status}.`);
    return WebAssembly.compile(await response.arrayBuffer());
  });
  return serveCodemodeRemote(request, (messages) => exchange(messages), {
    maxMemoryLimitBytes: 64 * 1024 * 1024,
    wasm,
  });
});
