import {
  RemoteCodemodeSandbox,
  type CodemodeExecuteOptions,
  type CodemodeSandboxBaseOptions,
  type CodemodeTool,
} from "@earendil-works/pi-codemode/portable";
import { defineInvoke, defineInvokeHandler } from "@moeru/eventa";
import { createContext } from "@moeru/eventa/adapters/webworkers";

import { exchangeEvent, executeEvent } from "./protocol.js";

type BrowserExecution = CodemodeExecuteOptions & { globals?: CodemodeTool[] };

export interface BrowserCodeModeOptions extends CodemodeSandboxBaseOptions {
  /** Construct a fresh module worker from the Code Mode worker entry. */
  createWorker(): Worker;
}

/** Pi runs each script in a disposable browser worker and calls tools on this thread. */
export function createBrowserCodeModeSandbox({ createWorker, ...options }: BrowserCodeModeOptions) {
  const lifetime = new AbortController();

  async function run({ code, globals = [], ...execution }: BrowserExecution & { code: string }) {
    const signal = execution.signal
      ? AbortSignal.any([lifetime.signal, execution.signal])
      : lifetime.signal;
    let disposeWorker: (() => void) | undefined;
    const sandbox = new RemoteCodemodeSandbox({
      ...options,
      globals: [...(options.globals ?? []), ...globals],
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
    try {
      return await sandbox.execute(code, { ...execution, signal });
    } finally {
      // Pi settles the host at the deadline. Termination also preempts a worker
      // computing synchronously without making a tool call.
      disposeWorker?.();
      await sandbox.close();
    }
  }

  return {
    run,
    execute(code: string, execution: BrowserExecution = {}) {
      return run({ ...execution, code });
    },
    close() {
      lifetime.abort();
    },
  };
}
