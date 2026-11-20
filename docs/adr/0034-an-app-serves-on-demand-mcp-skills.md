# An app serves on-demand MCP Skills

Status: updated by [ADR 0035](0035-an-app-serves-one-modern-mcp-endpoint.md). The original decision follows.

An app can publish a skill directory with `createMcpApp` from the SDK's client entry. Each MCP request gets a server attached to the app's catalog. The Relay carries the ordinary MCP messages and the user’s harness controls discovery, loading, approval and origin tracking. An app can publish skills alongside Code Mode or on their own.

The official MCP TypeScript SDK parses the frontmatter, validates the files, computes their integrity metadata and serves the [MCP Skills extension](https://modelcontextprotocol.io/extensions/skills/overview). A supporting client discovers the available instructions and reads individual files on demand. This delivery method requires harness support for MCP Skills. Filesystem skill installations have a separate origin and lifecycle.
