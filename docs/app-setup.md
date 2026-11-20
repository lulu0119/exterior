# Connect a web app to Exterior

Instructions for a coding assistant integrating a new or existing app. Use an existing relay. Device and relay operation is in [the manual](manual.md); the supported client interface is in [the SDK README](../packages/sdk/README.md).

## Inspect

Read the SDK README before changing the app. Identify the app's name and exact URL that handles sign-in, including its base path and trailing slash. Set `redirectUri` to the app's entry URL, such as `http://localhost:5173/studio/`, or to a dedicated callback. Keep `localhost` and `127.0.0.1` consistent with the page the person opens.

## Establish the app identity

If the app already has a client ID usable on this relay, use it. Otherwise, choose either path:

- **A client ID for one relay.** An account registers the app on that relay. Use the returned configuration in the app.
- **One identity across relays.** Publish a [Client ID Metadata Document](../packages/sdk/README.md#which-client-id) at a public HTTPS address and use that address as `clientId`. The document lists the redirects the app uses. The relay reads the document when the app signs in.

## Register on a relay

Use **Register app** and **Copy configuration** on the relay dashboard, or ask a coding assistant to run these two steps:

1. Choose a random setup id of 22 to 128 letters, digits, `-` or `_`, such as a UUID. Build the link with the app's name (1 to 64 characters, not starting with "Exterior") and its callback (https, or http on `localhost`, `127.0.0.1`, or `[::1]`), each URL-encoded:

   ```
   <relay>/apps/register?setup_id=<id>&client_name=<name>&redirect_uri=<callback>
   ```

   Give the link to the person. They sign in to the relay and confirm the prefilled registration, on this computer or another.

2. Poll every two seconds while they decide:

   ```sh
   curl -s -w '\n%{http_code}\n' <relay>/api/clients/setup/<id>
   ```

   - `202` `{ "status": "pending" }`: keep polling. If nothing changes for several minutes, ask the person whether they opened the link.
   - `200` `{ "status": "registered", "config": { "relayUrl", "clientId", "redirectUri" } }`: check that `config.redirectUri` is the URL you sent. Pass `config` to the SDK.
   - `200` `{ "status": "denied" }`: the person cancelled. Ask before starting again with a new id.
   - `200` `{ "status": "failed", "code", "message" }`: report the message.
   - `404`: check the relay URL and the setup result path.

The result stays for ten minutes after the person decides. It contains no account tokens. Setting up again for the same account, name, and callback returns the same client id. Registration does not grant access to devices.

Save that public configuration where the app keeps its settings.

## Integrate and verify

Install the SDK using its documented package address and pass the configuration to `useAccount(config)`. After the callback is handled, the SDK opens the page where the person started sign-in. Use `session.listDevices()` and `session.openConnection(...)` to list devices and open an agent. Follow the SDK's [connection and resume guidance](../packages/sdk/README.md#devices-and-connections).

Run the app's checks and build. Start it at the configured origin and have the person sign in and approve device access. Devices must be signed in and online on the same relay; offer the manual's device setup only when needed. Verify device discovery, opening an installed agent, and ACP `initialize` with that agent.

When using a metadata document, check from outside the deployment that its HTTPS address returns JSON and that both `client_id` and `redirect_uris` match the SDK configuration:

```sh
curl -fsS "$client_id" | jq -e --arg id "$client_id" --arg uri "$redirect_uri" \
  '.client_id == $id and (.redirect_uris | index($uri) != null)'
```

Setup is complete when the app signs in and initializes a real agent. Report the configuration and the checks you ran, including any live steps still pending. Publish or commit only when requested.

## Expose app tools

Use the protocol SDK's [`serveMcp`](../packages/sdk/README.md#serving-tools-to-an-agent) to serve tools through the relay. To offer Code Mode, import the SDK's [Code Mode entry point](../packages/sdk/README.md#code-mode) and declare the app operations a script can call. Give the agent the MCP endpoint during ACP session setup after checking its HTTP MCP capability.

Bind the operations to the selected app context, such as a report or the current AUV device. With a real agent, verify that it can find an operation, compose two operations in one execution, and cancel a running script. Verify the next call uses the newly selected context after switching.
