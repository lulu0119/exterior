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

A page can give an agent MCP tools that run in the page. `serveMcp(relayUrl, accessToken, connect, signal?)` opens an MCP endpoint on the relay and returns `{ url, headers, closed, close }`. Pass `url` and `headers` to the agent as an HTTP MCP server:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const tools = await serveMcp(relayUrl, await session.accessToken(), (transport) => {
  const server = new McpServer({ name: "playground", version: "1.0.0" });
  server.registerTool("report_title", {}, async () => ({
    content: [{ type: "text", text: reportTitle() }],
  }));
  void server.connect(transport);
});
// In ACP session/new, session/load and session/resume:
mcpServers: [{ type: "http", name: "playground", url: tools.url, headers: tools.headers }]
```

Check that the agent's `initialize` response has `agentCapabilities.mcpCapabilities.http` first; an agent without it cannot reach the endpoint. `connect` runs once for each MCP session the agent starts, with that session's transport; connect a new server to each. An agent that cancels a call aborts the handler's `signal`.

The endpoint lasts as long as its socket. Closing the page or calling `close()` ends it: calls still running fail, and the address answers 404. `closed` resolves with `revoked` when the person revokes the app, and otherwise with undefined. Open one endpoint per connection, and pass it again under the same `name` when that connection resumes a session. An agent may share the servers it is given between its sessions (OpenCode does, per working directory), so do not rely on an endpoint being one ACP session's alone.

For code execution and discovery tools, use the [Exterior Client SDK](../client-sdk/README.md) with this transport.

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

The relay side of MCP endpoints is not in `relay`: it speaks MCP's Streamable HTTP, so Exterior's relay keeps it beside its routes. The root exports the wire: `mcpEndpointsPath`, `mcpSocketCloseCodes`, `mcpFrameBytes`, and `parseMcpFrame`.
