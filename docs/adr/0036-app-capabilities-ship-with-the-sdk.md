# App capabilities ship with the SDK

Status: accepted. Extends [ADR 0024](0024-the-protocol-ships-as-one-sdk.md).

An app installs `@exterioragentprotocol/sdk` and uses `/client` to create and serve its MCP endpoint. Code Mode and its worker have separate client entry points, so importing the protocol SDK does not load the sandbox. Shipping those entries in one package removes the need to coordinate separate package versions. Package installation includes the Code Mode dependencies and the packaged Wasm asset.
