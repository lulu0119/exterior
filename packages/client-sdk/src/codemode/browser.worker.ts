import {
  serveCodemodeRemote,
  type CodemodeRemoteExchange,
  type CodemodeRemoteRequest,
} from "@earendil-works/pi-codemode/portable";
import { createBirpc, type BirpcReturn } from "birpc";

interface WorkerApi {
  execute(request: CodemodeRemoteRequest): Promise<void>;
}

interface HostApi {
  exchange: CodemodeRemoteExchange;
}

const worker = globalThis as unknown as Pick<Worker, "postMessage" | "addEventListener">;
let rpc: BirpcReturn<HostApi, WorkerApi>;
rpc = createBirpc<HostApi, WorkerApi>({
  execute(request) {
    const wasm = fetch(new URL("./quickjs.wasm", import.meta.url)).then(async (response) => {
      if (!response.ok) throw new Error(`QuickJS WASM request failed with HTTP ${response.status}.`);
      return WebAssembly.compile(await response.arrayBuffer());
    });
    return serveCodemodeRemote(request, (messages) => rpc.exchange(messages), {
      maxMemoryLimitBytes: 64 * 1024 * 1024,
      wasm,
    });
  },
}, {
  post: (message) => worker.postMessage(message),
  on: (receive) => worker.addEventListener("message", (event) => receive(event.data)),
  timeout: -1,
});
