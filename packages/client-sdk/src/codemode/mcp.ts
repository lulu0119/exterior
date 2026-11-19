import { renderToolSample } from "@earendil-works/pi-codemode/declarations";
import type { CodemodeResult, CodemodeTool } from "@earendil-works/pi-codemode/portable";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createCatalogGlobals, withSavedScripts, type CodeModeProgram } from "./script-runtime.js";
import type { ScriptLibrary } from "./scripts.js";

export type CodeModeRequest = { code: string; signal: AbortSignal; timeoutMs: number; program?: CodeModeProgram };

export type CodeModeMcpOptions = {
  description?: string;
  tools: readonly Omit<CodemodeTool, "execute">[];
  run(request: CodeModeRequest): Promise<CodemodeResult>;
  scripts?: ScriptLibrary;
};

const inputSchema = z.strictObject({
  code: z.string().max(100_000).refine((value) => value.trim().length > 0, "Script must not be empty."),
  timeoutMs: z.number().int().min(1).max(120_000).default(30_000),
});

const maxTextBytes = 1024 * 1024;
const maxContentBytes = 4 * 1024 * 1024;
const encoder = new TextEncoder();

function describe({ description, tools, scripts }: CodeModeMcpOptions): string {
  const introduction = description ? [description] : [];
  const instructions = [
    "Run JavaScript with top-level await and return.",
    "Each execution starts with fresh variables.",
    "Output with text(value) or return. Use image(value) for images.",
  ];
  if (tools.length) instructions.push("Call app tools as await tools.<name>(args). ALL_TOOLS lists their names and descriptions.");
  if (scripts) {
    instructions.push(
      "Use await codemode.search(query) to find app tools and saved scripts. Pass a match's path to await codemode.describe(path) for types or saved source.",
      "Use await codemode.run(name, input) to execute a saved script and use its return value in this script. Saved source receives input.",
    );
  }
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

export function registerCodeMode(server: McpServer, options: CodeModeMcpOptions): void {
  const catalogGlobals = options.scripts ? createCatalogGlobals(options.scripts, options.tools) : undefined;
  server.registerTool("execute", { description: describe(options), inputSchema }, async ({ code, timeoutMs }, { mcpReq: { signal } }) => {
    const program = catalogGlobals ? { code: withSavedScripts(code), globals: catalogGlobals } : undefined;
    return toolResult(await options.run({ code, signal, timeoutMs, ...(program && { program }) }));
  });
}
