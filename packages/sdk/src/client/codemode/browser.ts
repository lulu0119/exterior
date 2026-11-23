import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { defineInvoke, defineInvokeHandler } from "@moeru/eventa";
import { createContext } from "@moeru/eventa/adapters/webworkers";

import { exchangeEvent, executeEvent } from "./protocol.js";
import { createCodeModeSandbox, type CodeModeSandboxOptions } from "./sandbox.js";

export interface BrowserCodeModeOptions extends Omit<CodeModeSandboxOptions, "createSandbox"> {
  /** Construct a fresh module worker from the Code Mode worker entry. */
  createWorker(): Worker;
}

/** Pi runs each script in a disposable browser worker and calls tools on this thread. */
export function createBrowserCodeModeSandbox({ createWorker, ...options }: BrowserCodeModeOptions) {
  return createCodeModeSandbox({
    ...options,
    createSandbox(settings, signal) {
      let disposeWorker: (() => void) | undefined;
      const sandbox = new RemoteCodemodeSandbox({
        ...settings,
        remote: () => ({
          async execute(request, exchange) {
            signal.throwIfAborted();
            const worker = createWorker();
            const { context } = createContext(worker);
            const workerLifetime = new AbortController();
            defineInvokeHandler(context, exchangeEvent, exchange);
            disposeWorker = () => {
              worker.terminate();
              workerLifetime.abort();
            };
            await defineInvoke(context, executeEvent)(request, { signal: workerLifetime.signal });
          },
        }),
      });
      return {
        execute: sandbox.execute.bind(sandbox),
        async close() {
          // Pi settles the host at the deadline. Termination also preempts a worker
          // computing synchronously without making a tool call.
          disposeWorker?.();
          await sandbox.close();
        },
      };
    },
  });
}
