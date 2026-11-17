import { renderToolSample } from "@earendil-works/pi-codemode/declarations";
import type { CodemodeResult, CodemodeTool } from "@earendil-works/pi-codemode/portable";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type CodeModeRequest = { code: string; signal: AbortSignal; timeoutMs: number };

export type CodeModeMcpOptions = {
  name: string;
  version: string;
  description?: string;
  tools: readonly Omit<CodemodeTool, "execute">[];
  run(request: CodeModeRequest): Promise<CodemodeResult>;
};

const inputSchema = z.strictObject({
  code: z.string().max(100_000).refine((value) => value.trim().length > 0, "Script must not be empty."),
  timeoutMs: z.number().int().min(1).max(120_000).default(30_000),
});

const maxTextBytes = 1024 * 1024;
const maxContentBytes = 4 * 1024 * 1024;
const encoder = new TextEncoder();

function describe({ description, tools }: CodeModeMcpOptions): string {
  const introduction = description ? [description] : [];
  const instructions = [
    "Execute a JavaScript script with top-level await and return.",
    "Call app tools with await tools.<name>(args). Each execution starts with fresh variables.",
    "Use text(value) or return to report results, and image(value) to report an image.",
    "Discover tools with ALL_TOOLS. For example, text(ALL_TOOLS.slice(0, 5)).",
  ];
  const declarations = tools.map((tool) => renderToolSample(tool));
  return [...introduction, instructions.join("\n"), ...declarations].join("\n\n");
}

function toolResult(result: CodemodeResult): CallToolResult {
  const content: CallToolResult["content"] = [];
  let textBytes = 0;
  let size = 0;
  let omitted = 0;

  function append(item: CallToolResult["content"][number]) {
    // Count actual JSON bytes. Pi's character limit does not account for
    // multibyte text, JSON escaping, or the MCP content envelope.
    const bytes = encoder.encode(JSON.stringify(item)).byteLength + 1;
    if (size + bytes > maxContentBytes || (item.type === "text" && textBytes + bytes > maxTextBytes)) {
      omitted++;
      return;
    }
    content.push(item);
    size += bytes;
    if (item.type === "text") textBytes += bytes;
  }

  for (const item of result.output) {
    append(item.type === "text" ? { type: "text", text: item.text } : item);
  }
  if (!result.ok) {
    append({ type: "text", text: result.error.message });
  } else if (result.value !== undefined) {
    const text = typeof result.value === "string" ? result.value : JSON.stringify(result.value);
    append({ type: "text", text });
  }
  if (omitted) content.push({ type: "text", text: `Omitted ${omitted} output item(s) because they exceeded the response size limit.` });
  if (!content.length) content.push({ type: "text", text: "Script completed." });
  return { content, isError: !result.ok };
}

/** Serve the app's Pi sandbox through one MCP tool. The app owns each execution's sandbox and state. */
export async function connectCodeMode(transport: Transport, options: CodeModeMcpOptions): Promise<void> {
  const server = new McpServer({ name: options.name, version: options.version });
  server.registerTool("execute", { description: describe(options), inputSchema }, async ({ code, timeoutMs }, { signal }) => {
    return toolResult(await options.run({ code, signal, timeoutMs }));
  });
  await server.connect(transport);
}
