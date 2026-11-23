import type {
  CodemodeExecuteOptions,
  CodemodeSandboxBase,
  CodemodeSandboxBaseOptions,
  CodemodeTool,
} from "@earendil-works/pi-codemode/portable";
import { createHostSession, hostPrelude, type CodeModeHost } from "./host.js";

type CodeModeExecution = CodemodeExecuteOptions & { globals?: CodemodeTool[] };
type Sandbox = Pick<CodemodeSandboxBase, "execute" | "close">;

export interface CodeModeSandboxOptions extends CodemodeSandboxBaseOptions {
  createSandbox(options: CodemodeSandboxBaseOptions, signal: AbortSignal): Sandbox;
  host?: CodeModeHost;
}

export function createCodeModeSandbox({ createSandbox, host, ...options }: CodeModeSandboxOptions) {
  const lifetime = new AbortController();

  async function run({ code, globals = [], ...execution }: CodeModeExecution & { code: string }) {
    const signal = execution.signal
      ? AbortSignal.any([lifetime.signal, execution.signal])
      : lifetime.signal;
    const session = host && !signal.aborted ? createHostSession(host, signal) : undefined;
    let sandbox: Sandbox | undefined;
    try {
      sandbox = createSandbox({
        ...options,
        globals: [...(options.globals ?? []), ...globals, ...(session?.globals ?? [])],
      }, signal);
      const source = session ? `${hostPrelude}\n${code}` : code;
      return await sandbox.execute(source, { ...execution, signal });
    } finally {
      session?.close();
      await sandbox?.close();
    }
  }

  return {
    run,
    execute(code: string, execution: CodeModeExecution = {}) {
      return run({ ...execution, code });
    },
    close() {
      lifetime.abort();
    },
  };
}
