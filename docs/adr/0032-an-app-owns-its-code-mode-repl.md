# An app owns its Code Mode REPL

Status: accepted.

Apps such as AUV Playground need to expose their own SDK operations and keep the values an agent discovers across tool calls. The optional Client SDK, `@exterioragentprotocol/client-sdk`, provides the capability catalog, script execution and MCP tools. The protocol SDK retains the EAP roles described in [ADR 0024](0024-the-protocol-ships-as-one-sdk.md). Separating the packages gives apps a reusable execution layer and keeps the JavaScript engine and TypeScript tooling out of protocol-only installs.

The app serves the tools on an existing [MCP endpoint](0030-a-web-app-serves-mcp-through-the-relay.md). The same capability catalog describes script bindings and determines which operations are exposed, including those on returned objects. Discovery reads the catalog without executing a cell. The app selects the active conversation and the device or other application context, binds its capabilities to that context, and keeps policy, credentials, domain operations and their results in its own integration. The relay and daemon keep their existing EAP behavior.

The app owns an in-memory QuickJS REPL for that context. Calls to execute a cell are serialized and ordinary JavaScript bindings can carry values forward. A runtime error can leave earlier assignments in place. Stop, timeout, connection loss, or a change of conversation, target, or permitted capabilities ends the context and discards its JavaScript state. The app can reset the REPL explicitly. A small committed JSON store is available when an app needs explicit state; the app scopes it and commits changes after successful execution. Resetting the REPL has no rollback semantics for an application action already dispatched.

Starting a fresh sandbox for every cell would require an agent to reconstruct its live handles from identifiers or move all state into the JSON store. A REPL keeps ordinary variables available for interactive work, with context changes providing a clear point to release handles and rebuild bindings.
