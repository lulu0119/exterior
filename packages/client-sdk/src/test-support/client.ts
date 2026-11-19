import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, type McpServerFactory } from "@modelcontextprotocol/server";
import { createMcpApp } from "../mcp/index.js";
import { registerCodeMode, type CodeModeMcpOptions } from "../codemode/mcp.js";
import { onTestFinished } from "vitest";

export async function connectTestClient(factory: McpServerFactory, inspect?: (request: Request) => Promise<void>) {
  const handler = createMcpHandler(factory, { legacy: "reject" });
  const client = new Client({ name: "harness", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  onTestFinished(async () => { await client.close(); await handler.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: async (url, init) => {
      const request = new Request(url, init);
      if (inspect) await inspect(request.clone());
      return handler.fetch(request);
    },
  }));
  return client;
}

export async function connectTestCodeMode({ name, version, ...options }: CodeModeMcpOptions & { name: string; version: string }) {
  return connectTestClient(await createMcpApp({ name, version, configure: server => registerCodeMode(server, options) }));
}
