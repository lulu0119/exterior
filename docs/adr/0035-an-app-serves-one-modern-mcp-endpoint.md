# An app serves one modern MCP endpoint

Status: accepted. Updates the transport in [ADR 0030](0030-a-web-app-serves-mcp-through-the-relay.md) and the Skills entry in [ADR 0034](0034-an-app-serves-on-demand-mcp-skills.md).

One endpoint identifies the app to the harness. The app can register Code Mode, a skill catalog, prompts and resources on the same official MCP server. The SDK exposes a server factory to apps that need custom capabilities. App permissions, SDK objects and execution state stay with the app.

Use MCP 2026-07-28 exclusively. Each HTTP exchange has an independent wire identity and signal. The page uses the official strict HTTP handler to negotiate the version, validate MCP metadata and serve streamed or ordinary responses. The relay checks the endpoint token, forwards protocol headers, and routes response chunks as the HTTP reader asks for them. The page's socket closes every exchange for its endpoint. The registration response confirms the revision before the page opens its socket.

A dual-protocol deployment would retain the old session registry and its lifecycle alongside per-request routing. We chose one protocol even though harnesses that only send the 2025 initialize handshake must upgrade. Official extensions remain opt-in on both ends. Enabling Skills does not imply native activation by every harness.

[Protocol changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) · [SDK negotiation](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/docs/protocol-versions.md) · [Wire contract](../protocol/exterior-agent-protocol.md#12-mcp-endpoints)
