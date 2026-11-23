# An app serves Code Mode with Pi

Status: accepted.

Apps such as AUV Playground expose selected operations so an external agent can compose them in JavaScript. The SDK's optional Code Mode entry serves an `execute` tool over the existing [MCP endpoint](0030-a-web-app-serves-mcp-through-the-relay.md). See [ADR 0036](0036-app-capabilities-ship-with-the-sdk.md) for the package and entry points.

The app defines Pi Code Mode tools with descriptions, data shapes and host callbacks. Pi generates the script-facing declarations from that list and exposes it to scripts through `ALL_TOOLS`. The app binds the callbacks to its selected context and checks permissions before effects. Its SDK clients and credentials stay in the host.

Each call uses a fresh [Pi Code Mode sandbox](https://github.com/earendil-works/pi/tree/main/packages/codemode). The browser sandbox runs Pi's portable VM off the page thread in a disposable worker. Scripts compose operations using data and resource references. Apps can carry Pi's successful JSON store changes between calls in the same authorized context.

An app can also supply a host object when its operations need callbacks or typed arrays. A per-execution Cap’n Web session carries these over Pi globals. Eventa carries the browser worker exchange. The SDK closes the RPC session and signals the host when execution ends. The app defines and authorizes the operations on its host object.

The draft originally retained JavaScript heaps and callable SDK objects between calls. Explicit resource references let the SDK delegate execution and value exchange to Pi. An external agent continues to own its own conversation and reaches the app through MCP.
