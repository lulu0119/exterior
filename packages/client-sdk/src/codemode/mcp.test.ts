import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { catalogBindings, createApiHelp } from "./catalog.js";
import { createRepl } from "./executor.js";
import { connectCodeMode } from "./mcp.js";
import { buildTypeScriptCatalog } from "./typescript-catalog.js";
import { compileTypeScript } from "./typescript.js";

export class BenchmarkReport {
  #scores = [0.9, 0.3];

  /** Read benchmark scores. */
  scores() {
    return this.#scores;
  }

  get credentials() {
    throw new Error("Report credentials should never be read.");
  }
}

it("serves a report's discovery directly over MCP and exposes the same catalog and bindings in scripts", async () => {
  const catalog = buildTypeScriptCatalog({
    namespaces: [{
      source: fileURLToPath(import.meta.url),
      symbol: "BenchmarkReport",
      namespace: "report",
      members: ["scores"],
    }],
    examples: { "report.scores": ["text(report.scores())"] },
  });
  const api = createApiHelp(catalog, { starter: ["report.scores"] });
  const report = catalogBindings(catalog, "report", new BenchmarkReport());
  const repl = createRepl({ bindings: { api, report } });
  const run = vi.fn(async ({ code, timeoutMs, signal }: { code: string; timeoutMs: number; signal: AbortSignal }) => {
    const outcome = await repl.execute({
      ...compileTypeScript(code),
      timeoutMs,
      signal,
    });
    return { content: outcome.content, isError: outcome.status !== "ok" };
  });
  const client = new Client({ name: "benchmark-agent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await connectCodeMode(serverTransport, {
      name: "benchmark-report",
      version: "1.0.0",
      description: "Run TypeScript against the selected benchmark report.",
      api,
      run,
    });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name)).toEqual(["execute", "help", "search", "describe"]);
    expect(tools.find(({ name }) => name === "search")?.annotations?.readOnlyHint).toBe(true);

    const help = await client.callTool({ name: "help" });
    expect(help.structuredContent).toMatchObject({ starter: [{ path: "report.scores" }] });
    const search = await client.callTool({ name: "search", arguments: { query: "benchmark" } });
    expect(search.structuredContent).toMatchObject({ items: [{ path: "report.scores" }] });
    const details = await client.callTool({ name: "describe", arguments: { path: "report.scores" } });
    expect(details.structuredContent).toMatchObject({
      examples: ["text(report.scores())"],
      found: true,
      signature: "report.scores(): Array<number>",
    });
    expect(run).not.toHaveBeenCalled();

    const execution = await client.callTool({
      name: "execute",
      arguments: {
        code: `
          const { items } = api.search({ query: "benchmark" });
          const [entry] = items;
          const minimum: number = 0.5;
          function filteredScores() { return report.scores().filter((score) => score >= minimum) }
          ({
            path: entry.path,
            help: api.describe({ path: entry.path }).signature,
            scores: filteredScores(),
            privateBinding: typeof report.credentials,
          });
        `,
      },
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(execution.isError).toBe(false);
    expect(execution.content).toEqual([{
      type: "text",
      text: JSON.stringify({
        path: "report.scores",
        help: "report.scores(): Array<number>",
        scores: [0.9],
        privateBinding: "undefined",
      }),
    }]);
    const next = await client.callTool({ name: "execute", arguments: { code: "[entry.path, minimum, filteredScores()]" } });
    expect(next.isError).toBe(false);
    expect(next.content).toEqual([{ type: "text", text: '["report.scores",0.5,[0.9]]' }]);
  } finally {
    repl.close();
    await client.close();
    await serverTransport.close();
  }
});
