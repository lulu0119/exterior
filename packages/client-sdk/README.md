# Exterior Client SDK

Install the [Client SDK preview](https://pkg.pr.new/lulu0119/exterior/@exterioragentprotocol/client-sdk@main), the [protocol SDK](../sdk/README.md), and `@modelcontextprotocol/sdk` v1. The protocol SDK provides sign-in and `serveMcp`. The Client SDK serves a single MCP `execute` tool backed by [Pi Code Mode](https://github.com/earendil-works/pi/tree/main/packages/codemode).

An app supplies the Pi tools it wants scripts to call. Each tool includes a name, a description, optional JSON schemas for the generated declarations, and an `execute` callback. Validate arguments and enforce permissions in the callback. SDK objects and credentials stay in the app. Use plain JSON or resource references for results.

```ts
import {
  connectCodeMode,
  createBrowserCodeModeSandbox,
  type CodemodeTool,
} from "@exterioragentprotocol/client-sdk/codemode";
import CodeModeWorker from "@exterioragentprotocol/client-sdk/codemode/worker?worker";
import { serveMcp } from "@exterioragentprotocol/sdk/client";

const reportTools: CodemodeTool[] = [
  {
    name: "report_scores",
    description: "Read the selected report's scores.",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "array", items: { type: "number" } },
    execute(_args, { signal }) {
      signal.throwIfAborted();
      return selectedReport().scores();
    },
  },
];
const sandbox = createBrowserCodeModeSandbox({
  createWorker: () => new CodeModeWorker(),
  tools: reportTools,
});
const endpoint = await serveMcp(relayUrl, accessToken, (transport) => {
  void connectCodeMode(transport, {
    name: "reports",
    version: "1.0.0",
    tools: reportTools,
    run: ({ code, signal, timeoutMs }) => sandbox.execute(code, { signal, timeoutMs }),
  });
});
void endpoint.closed.then(() => sandbox.close());
```

The example uses Vite's `?worker` import. The browser SDK keeps app tools in the page and gives each execution a fresh Pi VM in a module worker. The published worker includes a reference to the packaged WASM asset. A different browser bundler needs to emit that worker and asset. A Node app can instead pass Pi's `CodemodeSandbox.execute` through the same `run` callback.

The agent receives Pi's generated declarations in the `execute` description. Inside JavaScript, use `tools.report_scores({})` and `ALL_TOOLS` to list the available operations. Use top-level `await` and `return`, `text(value)`, or `image(value)` for output. If the app needs explicit state across calls, it can pass a JSON store and apply the `storeWrites` from successful runs. Scope state and operations to the authorized app context. Closing the sandbox stops active scripts and aborts their pending tool calls. An app effect already dispatched remains in effect.
