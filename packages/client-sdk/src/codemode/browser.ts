import {
  RemoteCodemodeSandbox,
  type CodemodeExecuteOptions,
  type CodemodeRemoteExchange,
  type CodemodeRemoteRequest,
  type CodemodeSandboxBaseOptions,
} from "@earendil-works/pi-codemode/portable";
import { createBirpc } from "birpc";

interface WorkerApi {
  execute(request: CodemodeRemoteRequest): Promise<void>;
}

interface HostApi {
  exchange: CodemodeRemoteExchange;
}

export interface BrowserCodeModeOptions extends CodemodeSandboxBaseOptions {
  /** Construct a fresh module worker from the Client SDK worker entry. */
  createWorker(): Worker;
}

/** Pi runs each script in a disposable browser worker and calls tools on this thread. */
export function createBrowserCodeModeSandbox({ createWorker, ...options }: BrowserCodeModeOptions) {
  const lifetime = new AbortController();

  return {
    async execute(code: string, execution: CodemodeExecuteOptions = {}) {
      const signal = execution.signal
        ? AbortSignal.any([lifetime.signal, execution.signal])
        : lifetime.signal;
      let disposeWorker: (() => void) | undefined;
      const sandbox = new RemoteCodemodeSandbox({
        ...options,
        remote: () => ({
          async execute(request, exchange) {
            signal.throwIfAborted();
            const worker = createWorker();
            const rpc = createBirpc<WorkerApi, HostApi>({ exchange }, {
              post: (message) => worker.postMessage(message),
              on: (receive) => worker.addEventListener("message", (event) => receive(event.data)),
              timeout: -1,
            });
            const fail = () => rpc.$close(new Error("The Code Mode worker failed."));
            worker.addEventListener("error", fail);
            worker.addEventListener("messageerror", fail);
            disposeWorker = () => {
              worker.terminate();
              rpc.$close();
            };
            await rpc.execute(request);
          },
        }),
      });
      try {
        return await sandbox.execute(code, { ...execution, signal });
      } finally {
        // Pi settles the host at the deadline. Termination also preempts a worker
        // computing synchronously without making a tool call.
        disposeWorker?.();
        await sandbox.close();
      }
    },
    close() {
      lifetime.abort();
    },
  };
}
