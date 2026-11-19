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
    run: sandbox.run,
  });
});
void endpoint.closed.then(() => sandbox.close());
```

The example uses Vite's `?worker` import. The browser SDK keeps app tools in the page and gives each execution a fresh Pi VM in a module worker. The published worker includes a reference to the packaged WASM asset. A different browser bundler needs to emit that worker and asset. Pass `sandbox.run` as the MCP callback. Use `sandbox.execute(code, options)` for running source directly from the app. A Node app can construct Pi's `CodemodeSandbox` with the app tools and `request.program?.globals`, then execute `request.program?.code ?? request.code` with the request's signal and timeout.

The agent receives Pi's generated declarations in the `execute` description. Inside JavaScript, use `tools.report_scores({})` and `ALL_TOOLS` to list the available operations. Use top-level `await` and `return`, `text(value)`, or `image(value)` for output. If the app needs explicit state across calls, it can pass a JSON store and apply the `storeWrites` from successful runs. Scope state and operations to the authorized app context. Closing the sandbox stops active scripts and aborts their pending tool calls. An app effect already dispatched remains in effect.

## Saved scripts

The Code Mode extension can use an app-owned catalog inspired by [Cloudflare Code Mode snippets](https://github.com/cloudflare/agents/blob/06a271526fd7d4a6dd1ee0ea238fe30402494880/docs/codemode/snippets.md). The app saves useful source explicitly. Changing a harness or ACP session leaves the catalog in the app's storage. Apps that only need ad hoc execution can omit the catalog and storage configuration.

Configure an [unstorage](https://unstorage.unjs.io/) instance for the app. The following browser example uses IndexedDB; install `unstorage@^1.17.6` and its optional `idb-keyval` driver dependency in the consuming app. The published driver path is spelled `indexedb`.

```ts
import { createStorage } from "unstorage";
import indexedb from "unstorage/drivers/indexedb";
import { createScriptLibrary } from "@exterioragentprotocol/client-sdk/codemode";

const storage = createStorage({
  driver: indexedb({ dbName: "report-app", storeName: "scripts" }),
});
const scripts = createScriptLibrary({ storage });

await scripts.save({
  name: "report-scores",
  description: "Read the selected report's scores above a minimum.",
  tags: ["reports"],
  code: `const scores = await tools.report_scores({});
return scores.filter(score => score >= input.minimum);`,
  inputSchema: {
    type: "object",
    properties: { minimum: { type: "number" } },
    required: ["minimum"],
    additionalProperties: false,
  },
});
```

Pass `scripts` to `connectCodeMode` alongside `tools` and `run`. The browser sandbox's `run` callback reads the full request, including any assembled source and catalog globals. Apps that wrap the callback for recording or to set their current context can retain the original `request.code` and forward the full request to `sandbox.run(request)`.

The harness calls the MCP `execute` tool with JavaScript. Inside that JavaScript it can use:

| Function | Result |
| --- | --- |
| `await codemode.search(query)` | `{ results, total, truncated }` with up to 10 matching app tools and saved scripts. Each result has a `kind` and a `path`. |
| `await codemode.describe(path)` | The tool's declaration or the saved script's source, metadata, and optional input schema. |
| `await codemode.run(name, input?)` | The saved script's return value, available for further computation in the same execution. |

```js
const { results } = await codemode.search("report-scores");
const script = results.find(({ kind, path }) => kind === "snippet" && path === "report-scores");
text(await codemode.describe(script.path));
const scores = await codemode.run(script.path, { minimum: 0.5 });
return { count: scores.length, total: scores.reduce((sum, score) => sum + score, 0) };
```

Saved source uses the same JavaScript body format as `execute`, with an additional `input` variable. It uses the current Pi VM, App tools, deadline, output and JSON store. Saved scripts can call other saved scripts. An error from saved source can be caught by its caller.

Saving and deletion are app-facing operations. A failed or canceled execution does not automatically save a script. Apps choose which source to save, and can connect their editor to the same records without exposing a second catalog to the harness.

| Library method | Behavior |
| --- | --- |
| `save({ name, description, code, tags?, inputSchema? })` | Validate and save a record, replacing an existing record with the same name. Returns the saved record. |
| `get(name)` | Read the full record, or `null` when absent. |
| `list()` | Read metadata sorted by name, without code or input schemas. |
| `search(query, limit?)` | Fuzzy search over names, descriptions, and tags. |
| `remove(name)` | Remove one record. |

Names contain at most 64 letters, numbers, underscores, or hyphens; Unicode letters are supported. Source is stored verbatim. Optional JSON Schema documents describe the script's expected input. `codemode.run` passes the supplied value directly to saved code.

The library uses a `scripts` namespace inside the supplied storage and leaves its lifetime with the app. Names are case-sensitive; internal keys use a SHA-256 digest of the name so case-insensitive filesystems keep distinct names separate. Give each app an independent IndexedDB database, filesystem base, or appropriately scoped storage instance. Node apps can use `unstorage/drivers/fs-lite`; SQL and remote apps can select other unstorage drivers. The extension never imports a particular driver and does not expose whole-store clearing or mount controls. Backend transaction and consistency guarantees remain those of the chosen driver.

See [ADR 0033](../../docs/adr/0033-an-app-keeps-its-code-mode-scripts.md) for the catalog and execution design. Client SDK tests cover persistent records, app scope, MCP discovery, composition in Pi, and cancellation.
