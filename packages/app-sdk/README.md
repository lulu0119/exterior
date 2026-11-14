# Exterior App SDK

Install the [App SDK preview](https://pkg.pr.new/lulu0119/exterior/@exterioragentprotocol/app-sdk@main) alongside your app's MCP SDK and TypeScript. For an Exterior agent connection, use the [protocol SDK](../sdk/README.md) for sign-in and `serveMcp`.

`@exterioragentprotocol/app-sdk/codemode` shares a capability catalog between discovery and the app objects exposed to scripts. Supply an `ApiCatalog` directly or generate one at build time with `buildTypeScriptCatalog` from `/codemode/typescript-catalog` and your app's TypeScript dependency. A namespace can select SDK members and project a returned handle to another declared namespace. Add examples and restrictions specific to your app.

`connectCodeMode` from `/codemode/mcp` uses your MCP SDK dependency and serves `help`, `search`, `describe`, and `execute` on a transport from `serveMcp`. The discovery tools read the catalog without running code. Supply the same `api` from `createApiHelp` to scripts for discovery inside a run.

```ts
import { catalogBindings, createApiHelp } from "@exterioragentprotocol/app-sdk/codemode";
import { createRepl } from "@exterioragentprotocol/app-sdk/codemode/executor";
import { connectCodeMode } from "@exterioragentprotocol/app-sdk/codemode/mcp";
import { compileTypeScript } from "@exterioragentprotocol/app-sdk/codemode/typescript";
import { serveMcp } from "@exterioragentprotocol/sdk/client";

const api = createApiHelp(reportCatalog, { starter: ["report.scores"] });
const report = catalogBindings(reportCatalog, "report", selectedReport());
const repl = createRepl({ bindings: { api, report } });
const tools = await serveMcp(relayUrl, accessToken, (transport) => {
  void connectCodeMode(transport, {
    name: "reports",
    version: "1.0.0",
    description: "Run TypeScript against the selected benchmark report. Use help, search, and describe to discover report methods.",
    api,
    async run({ code, signal, timeoutMs }) {
      const result = await repl.execute({ ...compileTypeScript(code), signal, timeoutMs });
      const content = [...result.content];
      if (result.status === "error") content.push({ type: "text", text: result.message });
      if (result.status === "stopped") content.push({ type: "text", text: `Execution ${result.reason}. The REPL was reset.` });
      return { content, isError: result.status !== "ok" };
    },
  });
});
void tools.closed.then(() => repl.close());
```

The example serves one REPL for a selected report and conversation. Close its tools and REPL when that conversation or report changes. `compileTypeScript` erases type syntax and prepares a cell with top-level `await` and `return`. Top-level variables, functions, and classes can be used by later cells. Apps with their own compiler can pass the emitted JavaScript and optional prelude directly. `executeJavaScript` provides the same executor for a one-shot run.

Run one cell at a time. Ordinary runtime errors may leave earlier assignments in place. A canceled or timed-out cell resets the VM, and `repl.reset()` clears state explicitly. Host calls must finish within their cell. A guest continuation explicitly resumed by a later cell runs under that cell's execution. The app controls effects already dispatched and may commit the separate JSON `store` returned by a successful cell.

Bind trusted app objects selectively. An admitted data member exposes its complete plain value, so keep credentials in the host. Run the executor in a worker when the app must stay responsive during guest CPU work. The app remains responsible for choosing which conversation, records, and operations the REPL can access.
