# @exterioragentprotocol/sdk

The [Exterior Agent Protocol](../../docs/protocol/exterior-agent-protocol.md) for each of its roles. A web app signs the person in through a relay, lists devices, and opens agent connections. A device runs agents for the relay. A relay joins the two. It speaks standard OAuth against any relay and never touches Exterior's login cookie.

The SDK speaks EAP v1 as the spec states it: the endpoints under `/eap/v1/`, the authorization server found from the relay's protected resource metadata, the `eap:client` and `eap:device` scopes, devices identified by a key their tokens are bound to (DPoP), and one agent socket per connection.

Install (until the npm release):

```bash
pnpm add https://pkg.pr.new/lulu0119/exterior/@exterioragentprotocol/sdk@main
```

Import only the entry for your role. `client` and the root run in a browser; `device` and `relay` need Node.

| Entry | For |
| --- | --- |
| `@exterioragentprotocol/sdk/client` | A web app: sign-in, devices, connections. |
| `@exterioragentprotocol/sdk/client/react` | A React web app: `useAccount`. |
| `@exterioragentprotocol/sdk/client/codemode` | A web app serving [Code Mode](#code-mode) to an agent. |
| `@exterioragentprotocol/sdk/device` | A daemon: device sign-in, the device socket, and agent processes. |
| `@exterioragentprotocol/sdk/relay` | A relay: the device and connection registry. |
| `@exterioragentprotocol/sdk` | The wire messages, paths, and close codes every role shares. |

## Quick start (React)

```tsx
import { useAccount } from "@exterioragentprotocol/sdk/client/react";

const session = useAccount({
  relayUrl,
  clientId: "https://my-app.example.com/studio/oauth-client.json",
  redirectUri: "https://my-app.example.com/studio/",
});

if (session.account.phase === "signed-in") {
  const devices = await session.listDevices();
  // session.openConnection({ deviceId, agentName }) also obtains a live token.
}
```

Set `redirectUri` to the exact URL the relay can return to. Use the app entry or a dedicated callback. Mount the hook at that address before routing code rewrites the URL or third-party scripts read it. The hook clears OAuth parameters, validates the response, and stores tokens in `sessionStorage`. After sign-in it restores the page that started the flow. Set `returnTo` in `useAccount` to override that destination with a URL on the same origin as the callback. `signOut()` clears the stored session.

The hook reports its `account` phase (`checking`, `signed-out`, or `signed-in`), `busy`, and `error`. `listDevices(signal?)` and `openConnection({ deviceId, agentName }, signal?)` obtain a live token for each request. Use `accessToken()` for lower-level calls.

## Which client id

An app names itself in one of two ways.

**Publish a Client ID Metadata Document** to use one identity across relays. Pass the document's public HTTPS address as `clientId`. Each relay reads the app name and allowed redirects from it. A document can list both HTTPS and loopback redirects. The relay asks for consent on every loopback sign-in and accepts any loopback port (RFC 8252). For the Studio app above:

```json
{
  "client_id": "https://my-app.example.com/studio/oauth-client.json",
  "client_name": "Studio",
  "client_uri": "https://my-app.example.com/studio/",
  "redirect_uris": ["https://my-app.example.com/studio/", "http://localhost:5173/studio/"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

**Register a client on one relay** when the app will use that relay. Follow [app setup](../../docs/app-setup.md) or use Register app on its dashboard. Pass the configuration directly to `useAccount(config)`. An account owns the registration, and the ID belongs to that relay. The app asks for device access when a person signs in.

There is no anonymous registration.

## Without React

`beginBrowserSignIn({ relayUrl, redirectUri, store, clientId, returnTo })` returns the relay address to navigate to. Pass `sessionStorage` as `store`. `returnTo` is optional. `finishBrowserSignIn({ relayUrl, redirectUri, callbackUrl, store, clientId })` redeems the code and returns the tokens and saved `returnTo`. Racing callers share one redemption. `storedAccessToken({ relayUrl, store, clientId })` returns a live access token, refreshing within the last minute of expiry, or `undefined` once the sign-in is gone. Callers that race share one refresh. `clearBrowserSignIn(store)` signs out.

## Devices and connections

With an access token: `listDevices(relayUrl, accessToken)` lists the account's online devices, each with its agents and its `platform` (`macos`, `windows`, or `linux`); `openConnection(relayUrl, accessToken, { deviceId, agentName })` starts the agent and returns `{ url }`: dial `url` once, right away, and use it as the ACP connection. A request the relay refuses throws `RelayError`; decide by its `code` (`target_not_found`, `agent_start_failed`, `device_timeout`, …).

A connection lasts as long as its socket. When the socket closes, `closeReason(attachCloseCodes, event.code)` says why: `ticket_rejected` (the ticket was dialed already, or expired: open a new connection), `agent_exited`, `device_gone`, `revoked` (sign in again first), or `frame_too_large` (an ACP message exceeded 4 MiB). To continue a conversation, open a new connection and use ACP `session/resume` or `session/load`. A page that may mount twice keeps one socket per connection; a second dial on the same ticket is rejected and costs a second agent start.

`listDevices` and `openConnection` accept an optional `AbortSignal` as their last argument. Use it to time out a request or cancel it when the person leaves the connection form.

## Serving tools to an agent

A page can give an agent MCP tools that run in the page. `serveMcp(relayUrl, accessToken, createServer, signal?)` opens an MCP endpoint on the relay and returns `{ url, headers, notify, closed, close }`. Pass `url` and `headers` to the agent as an HTTP MCP server:

```ts
import { McpServer } from "@modelcontextprotocol/server";

const tools = await serveMcp(relayUrl, await session.accessToken(), () => {
  const server = new McpServer({ name: "playground", version: "1.0.0" });
  server.registerTool("report_title", {}, async () => ({
    content: [{ type: "text", text: reportTitle() }],
  }));
  return server;
});
// In ACP session/new, session/load and session/resume:
mcpServers: [{ type: "http", name: "playground", url: tools.url, headers: tools.headers }]
```

The ACP harness must advertise HTTP MCP transport and its MCP client must speak revision `2026-07-28`. With the official TypeScript client, set `versionNegotiation: { mode: "auto" }`. Each MCP HTTP request gets a fresh server from the factory. An agent that aborts the HTTP request aborts the handler's `ctx.mcpReq.signal`. The endpoint's `notify` publishes catalog and resource updates to subscribed clients.

The endpoint lasts as long as its socket. Closing the page or calling `close()` ends it: calls still running fail, and the address answers 404. `closed` resolves with `revoked` when the person revokes the app, and otherwise with undefined. Open one endpoint per connection, and pass it again under the same `name` when that connection resumes a session. An agent may share the servers it is given between its sessions (OpenCode does, per working directory), so do not rely on an endpoint being one ACP session's alone.

For an execution tool with app operation discovery, use the [Code Mode entry point](#code-mode) with this transport.

## Tokens

`refreshAccessToken` rotates a refresh token and throws `RefreshTokenRejectedError` when the sign-in is gone. `revokeRefreshToken` revokes one. Both are in `client` and `device`.

## Running a device

`device` is what `exterior daemon` runs on; [`docs/manual.md`](../../docs/manual.md) covers setting one up.

- `generateDeviceKey()` makes a device's key, and `exportDeviceKey` and `importDeviceKey` keep it as a private JWK. Keep one per relay: a new key is a new device. `deviceIdOf(key)` is its thumbprint, the device id. `dpopProof(key, method, url, accessToken?)` proves the key for one request (RFC 9449).
- `beginDeviceAuthorization({ relayUrl, clientId })` and `pollDeviceAuthorization(pending, key, signal)` sign a device in with a code the person approves (RFC 8628). `clientId` is the device software's: a metadata document address or a client id the relay issued. The tokens are bound to `key`, and `refreshAccessToken` takes it as `deviceKey`.
- `createDeviceHost({ relayUrl, deviceKey, hostname, platform, workingDirectory, agents, launch, heartbeatMs })` runs the device's agents. For each `open` it calls `launch(agentName, workingDirectory)`, which returns `{ child, stop }` for a started process or a reason it cannot start one, then dials that connection's agent socket with a proof of the key and carries the agent over it, one frame per line, with backpressure both ways (`carryAgent`). The agent ending closes the socket, and the socket closing stops the agent. `setAgents` and `setWorkingDirectory` say hello again; running agents keep their agent and directory. `stop()` stops every agent, as the device shuts down.
- `connectDevice({ relayUrl, accessToken, deviceKey, host, inform, onConnected, heartbeatMs, signal })` opens one device socket with the key-bound token and a proof, attaches the host to it, pings the relay, and resolves with how the socket ended: `replaced` and `revoked` are the relay's close codes, `unauthorized` and `forbidden` a refused upgrade, and `unsupported_version` a relay without this version's path. Agents keep running across device sockets; reconnecting is the caller's.
- `devicePlatform(process.platform)` names the platform to report.

## Running a relay

`relay` holds what a relay keeps in memory. `createRegistry({ seen, ticketTtlMs, openTimeoutMs })` tracks online devices and live connections:

- `connectDevice({ userId, deviceId, send, close })` for a device socket the relay admitted, with the device id read from its token's `cnf.jkt`.
- `openConnection` sends `open` and resolves with the ticket once the device dials the agent socket.
- `acceptAgent({ connectionId, deviceId }, socket)` for an agent socket whose proof named `deviceId` and `acceptClient(ticket, socket)` for an attach socket. Each takes a `FrameSocket` (`send(frame, flushed)`, `unsent()`, `pause()`, `resume()`, `close`) and returns the link its handler reports frames and the close to, or `undefined` when the dial is refused. The registry joins the two and pauses one while the other is behind.
- `listDevices` and `listConnections` per account, `removeDevice` when a device is removed, and `revokeClient` when an account revokes a client.

`seen` is told when a device says hello and when its socket closes, so the relay can list it while offline. `heartbeat(socket, everyMs)` pings a `ws` socket and ends it when a ping goes unanswered. HTTP routing and authentication stay with the relay's own framework.

The `relay` entry exports `createMcpEndpoints` for HTTP routing, ticketed page sockets, concurrent exchanges and cancellation. The app-side MCP SDK handles discovery, headers, content and subscriptions. See the [endpoint wire contract](../../docs/protocol/exterior-agent-protocol.md#12-mcp-endpoints).

## Code Mode

The app defines one MCP endpoint for a harness that speaks MCP 2026-07-28. Code Mode and Skills can be enabled independently on that endpoint.

An app supplies the Pi tools it wants scripts to call. Each tool includes a name, a description, optional JSON schemas for the generated declarations, and an `execute` callback. Validate arguments and enforce permissions in the callback. SDK objects and credentials stay in the app. Use plain JSON or resource references for results.

```ts
import {
  registerCodeMode,
  createBrowserCodeModeSandbox,
  type CodemodeTool,
} from "@exterioragentprotocol/sdk/client/codemode";
import CodeModeWorker from "@exterioragentprotocol/sdk/client/codemode/worker?worker";
import { createMcpApp, serveMcp } from "@exterioragentprotocol/sdk/client";

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
const app = await createMcpApp({
  name: "reports",
  version: "1.0.0",
  configure: server => registerCodeMode(server, { tools: reportTools, run: sandbox.run }),
});
const endpoint = await serveMcp(relayUrl, accessToken, app);
void endpoint.closed.then(() => sandbox.close());
```

The example uses Vite's `?worker` import. The browser sandbox keeps app tools in the page and gives each execution a fresh Pi VM in a module worker. The published worker includes a reference to the packaged WASM asset. A different browser bundler needs to emit that worker and asset. Pass `sandbox.run` as the MCP callback. Use `sandbox.execute(code, options)` for running source directly from the app. A Node app can construct Pi's `CodemodeSandbox` with the app tools and `request.globals`, then execute `request.code` with the request's signal and timeout.

The agent receives Pi's generated declarations in the `execute` description. Inside JavaScript, use `tools.report_scores({})` and `ALL_TOOLS` to list the available operations. Use top-level `await` and `return`, `text(value)`, or `image(value)` for output. If the app needs explicit state across calls, it can pass a JSON store and apply the `storeWrites` from successful runs. Scope state and operations to the authorized app context. Closing the sandbox stops active scripts and aborts their pending tool calls. An app effect already dispatched remains in effect.

### Host objects

Pass a `host` factory to `createBrowserCodeModeSandbox` to expose a Cap’n Web `RpcTarget` for each execution. Script code can call `await host.read()` and pass callbacks to methods such as `await host.scan(update => update.done)`. The bridge carries `Uint8Array` values in both directions. Describe the methods in the app's `execute` tool description or skill so scripts know what they can call.

A Node app can use the same option with its Pi sandbox:

```ts
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodeModeSandbox, RpcTarget } from "@exterioragentprotocol/sdk/client/codemode";

class ReportHost extends RpcTarget {
  read() {
    return Uint8Array.of(2, 7, 9);
  }
}

const sandbox = createCodeModeSandbox({
  createSandbox: options => new CodemodeSandbox(options),
  host: () => new ReportHost(),
});
const result = await sandbox.execute("return Array.from(await host.read());");
```

Expose only methods and properties the running script is authorized to use. The host factory receives a signal that aborts when execution finishes, fails, times out, or is canceled. Pass it to operations that can outlive a call. Cap’n Web releases its remote references when the session closes. Host calls travel through Pi globals and the app can record their effects from its host methods.

For a callback that will be used after the receiving method returns, retain a copy with `callback.dup()` and dispose it when the operation ends. See [Cap’n Web disposal](https://capnweb.com/concepts/disposal/).

### Saved scripts

The Code Mode extension can use an app-owned catalog inspired by [Cloudflare Code Mode snippets](https://github.com/cloudflare/agents/blob/06a271526fd7d4a6dd1ee0ea238fe30402494880/docs/codemode/snippets.md). The app saves useful source explicitly. Changing a harness or ACP session leaves the catalog in the app's storage. Apps that only need ad hoc execution can omit the catalog and storage configuration.

Configure an [unstorage](https://unstorage.unjs.io/) instance for the app. The following browser example uses IndexedDB; install `unstorage@^1.17.6` and its optional `idb-keyval` driver dependency in the consuming app. The published driver path is spelled `indexedb`.

```ts
import { createStorage } from "unstorage";
import indexedb from "unstorage/drivers/indexedb";
import { createScriptLibrary } from "@exterioragentprotocol/sdk/client/codemode";

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

Pass `scripts` to `registerCodeMode` alongside `tools` and `run`. The request's `code` is the JavaScript to execute, including the saved-script helpers. `globals` carries the catalog bindings. To add SDK setup, prepend it to `request.code` and pass the updated request to `sandbox.run()`. To record the original submission, use `request.source ?? request.code`.

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

See [ADR 0033](../../docs/adr/0033-an-app-keeps-its-code-mode-scripts.md) for the catalog and execution design. SDK tests cover persistent records, app scope, MCP discovery, composition in Pi, and cancellation.

## On-demand MCP Skills

Add the app's skill files to the same server factory. The catalog is built once. Each request gets its own MCP server connected to that catalog. Omit `configure` for a skills-only app, or omit `skills` for a tools-only app.

```ts
const app = await createMcpApp({
  name: "reports",
  version: "1.0.0",
  skills: {
    "reports/SKILL.md": instructions,
    "reports/references/scores.md": scoreGuide,
  },
  configure: server => registerCodeMode(server, { tools: reportTools, run: sandbox.run }),
});
const endpoint = await serveMcp(relayUrl, accessToken, app);
```

The harness calls `server/discover`, lists skill metadata with `skills/list`, and reads a selected file with `resources/read`. The official Skills client verifies the file's digest. The same server can register ordinary prompts and resources in `configure`. Use the served endpoint's `notify` methods for catalog changes. Each capability requires a consuming client. [MCP Skills](https://modelcontextprotocol.io/extensions/skills/overview) · [Client compatibility probes](../../docs/research/2026-11-19-client-sdk-native-skills.md)
