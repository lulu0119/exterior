import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpTransport } from "../client/mcp.js";
import type { ApiHelp } from "./catalog.js";
import { codeExecutionLimits as limits } from "./limits.js";

export type CodeModeMcpOptions = {
  name: string;
  version: string;
  /** Describes the script language and the objects available during execution. */
  description: string;
  api: ApiHelp;
  run(request: { code: string; timeoutMs: number; signal: AbortSignal }): Promise<CallToolResult>;
};

const tools: Tool[] = [
  {
    name: "help",
    description: "Read the script environment, rules, and starter examples.",
    inputSchema: { type: "object", additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search",
    description: "Find available script methods and values. Returns paths, short descriptions, and signatures.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        namespace: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 10 },
        offset: { type: "integer", minimum: 0 },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "describe",
    description: "Read the signature, examples, and related types of an exact script method or type.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string", minLength: 1 } },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
];

function output(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

/** Connect one MCP session. Discovery reads the catalog directly and never invokes the application runner. */
export async function connectCodeMode(transport: McpTransport | Transport, options: CodeModeMcpOptions): Promise<void> {
  const execute: Tool = {
    name: "execute",
    description: options.description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string", minLength: 1, maxLength: limits.maxCodeCharacters },
        timeoutMs: { type: "integer", minimum: 1, maximum: limits.maxTimeoutMs, default: limits.defaultTimeoutMs },
      },
      required: ["code"],
    },
  };
  const server = new Server({ name: options.name, version: options.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [execute, ...tools] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    const args = params.arguments ?? {};
    try {
      switch (params.name) {
        case "help": return output(options.api.help());
        case "search": return output(options.api.search(args));
        case "describe": {
          if (typeof args.path !== "string") throw new TypeError("describe requires a path from search or a related type name.");
          return output(options.api.describe({ path: args.path }));
        }
        case "execute": {
          const { code, timeoutMs = limits.defaultTimeoutMs } = args;
          if (typeof code !== "string" || !code.trim() || code.length > limits.maxCodeCharacters
            || typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > limits.maxTimeoutMs) {
            throw new TypeError(`execute requires code and a timeoutMs from 1 to ${limits.maxTimeoutMs}.`);
          }
          return await options.run({ code, timeoutMs, signal });
        }
        default: throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
      }
    } catch (cause) {
      if (cause instanceof McpError) throw cause;
      return { content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }], isError: true };
    }
  });
  await server.connect(transport);
}
