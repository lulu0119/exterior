# Connect a web app to Exterior

Instructions for a coding assistant integrating a new or existing app. Use an existing relay. Device and relay operation is in [the manual](manual.md); the supported client interface is in [the SDK README](../packages/sdk/README.md).

## Inspect

Read the SDK README before changing the app. Identify the app's name and exact entry URL, including its base path and trailing slash. Use that as `redirectUri`, for example `http://127.0.0.1:5180/playground/`. Keep `localhost` and `127.0.0.1` consistent with the page the person opens.

## Establish the app identity

A released app names itself by a Client ID Metadata Document on its own https site; [the SDK README](../packages/sdk/README.md#which-client-id) shows one. If the app has such a document, or already has a client id on this relay, use it and skip to the next section. If the app is deployed at an https address but has no document yet, offer to write one, listing the local callback beside the deployed one, and use its address once it is published.

Otherwise the app is in development: register a client for it with two plain HTTP calls. No Exterior software is needed. A registered id works only on this relay and belongs to the person's account, so it is the identity for development, not for release.

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
   - `200` `{ "status": "registered", "config": { "relayUrl", "clientId", "redirectUri" } }`: check that `config.redirectUri` is the entry URL you sent. Pass `config` to the SDK.
   - `200` `{ "status": "denied" }`: the person cancelled. Ask before starting again with a new id.
   - `200` `{ "status": "failed", "code", "message" }`: report the message.
   - `404`: check the relay URL and the setup result path.

The result stays for ten minutes after the person decides. It contains no account tokens. Setting up again for the same account, name, and callback returns the same client id. Registration does not grant access to devices.

If the person registers by hand, ask them for the configuration from **Copy configuration** on the relay dashboard.

Save that public configuration where the app keeps its settings.

## Integrate and verify

Install the SDK using its documented package address and pass the configuration to `useAccount(config)`. Use `session.listDevices()` and `session.openConnection(...)` to list devices and open an agent. Follow the SDK's [connection and resume guidance](../packages/sdk/README.md#devices-and-connections).

Run the app's checks and build. Start it at the configured origin and have the person sign in and approve device access. Devices must be signed in and online on the same relay; offer the manual's device setup only when needed. Verify device discovery, opening an installed agent, and ACP `initialize` with that agent. App-specific dependencies such as a codemode proxy remain the app's responsibility.

Before release, publish the metadata document and use its HTTPS address as `clientId`. Add the released entry URL to `redirect_uris` alongside the local entry you use for development. From outside the deployment, check that `clientId` returns JSON and that both the ID and entry URL match the SDK configuration:

```sh
curl -fsS "$client_id" | jq -e --arg id "$client_id" --arg uri "$redirect_uri" \
  '.client_id == $id and (.redirect_uris | index($uri) != null)'
```

People authorize the released identity on first use. Setup is complete when the app signs in and initializes a real agent. Report the configuration and the checks you ran, including any live steps still pending. Publish or commit only when requested.
