import { CodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { connectCodeMode, type CodeModeRequest } from "./mcp.js";

const reportScores: CodemodeTool = {
  name: "report_scores",
  description: "Read benchmark scores.",
  inputSchema: { type: "object", properties: {} },
  outputSchema: { type: "array", items: { type: "number" } },
  execute: () => [0.9, 0.3],
};

it("exposes one MCP tool and executes JavaScript using Pi's tools and discovery", async () => {
  const sandbox = new CodemodeSandbox({ tools: [reportScores] });
  const run = vi.fn(({ code, ...options }: CodeModeRequest) => sandbox.execute(code, options));
  const client = new Client({ name: "benchmark-agent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await connectCodeMode(serverTransport, { name: "benchmark-report", version: "1.0.0", tools: [reportScores], run });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name)).toEqual(["execute"]);
    expect(tools[0].description).toContain("report_scores");
    expect(tools[0].description).toContain("Read benchmark scores.");
    expect(tools[0].description).toContain("ALL_TOOLS");
    expect(run).not.toHaveBeenCalled();

    for (const args of [{ code: "  " }, { code: "return 1", timeoutMs: 120_001 }, { code: "return 1", unknown: true }]) {
      const invalid = await client.callTool({ name: "execute", arguments: args });
      expect(invalid.isError).toBe(true);
    }
    expect(run).not.toHaveBeenCalled();

    const result = await client.callTool({
      name: "execute",
      arguments: {
        code: `
          const discovered = ALL_TOOLS.find(tool => tool.name === "report_scores");
          const scores = await tools.report_scores({});
          return { tool: discovered.name, scores: scores.filter(score => score >= 0.5) };
        `,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: '{"tool":"report_scores","scores":[0.9]}' }]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({ timeoutMs: 30_000, signal: expect.any(AbortSignal) });
  } finally {
    await sandbox.close();
    await client.close();
    await serverTransport.close();
  }
});

it("preserves image blocks and partial output and reports script and app failures", async () => {
  const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
  const client = new Client({ name: "agent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await connectCodeMode(serverTransport, {
      name: "report",
      version: "1.0.0",
      tools: [],
      async run({ code }) {
        if (code === "busy") throw new Error("Report is busy.");
        if (code === "large") {
          return {
            ok: true,
            value: undefined,
            output: [
              { type: "text", text: "Checking report." },
              { type: "text", text: "界".repeat(400_000) },
              { ...image, data: "a".repeat(4 * 1024 * 1024) },
              image,
            ],
            calls: [],
            storeWrites: { set: {}, delete: [] },
          };
        }
        return {
          ok: false,
          error: { kind: "script", message: "Cannot read score." },
          output: [{ type: "text", text: "Checking report.", console: true }, image],
          calls: [],
        };
      },
    });
    await client.connect(clientTransport);
    expect(await client.callTool({ name: "execute", arguments: { code: "test" } })).toEqual({
      isError: true,
      content: [{ type: "text", text: "Checking report." }, image, { type: "text", text: "Cannot read score." }],
    });
    expect(await client.callTool({ name: "execute", arguments: { code: "busy" } })).toEqual({
      isError: true,
      content: [{ type: "text", text: "Report is busy." }],
    });
    expect(await client.callTool({ name: "execute", arguments: { code: "large" } })).toEqual({
      isError: false,
      content: [
        { type: "text", text: "Checking report." },
        image,
        { type: "text", text: "Omitted 2 output item(s) because they exceeded the response size limit." },
      ],
    });
  } finally {
    await client.close();
    await serverTransport.close();
  }
});

it("propagates an MCP cancellation to a running Pi tool", async () => {
  let started: () => void = () => undefined;
  const hasStarted = new Promise<void>((resolve) => { started = resolve; });
  let canceled: () => void = () => undefined;
  const wasCanceled = new Promise<void>((resolve) => { canceled = resolve; });
  const wait: CodemodeTool = {
    name: "wait",
    execute: (_args, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        canceled();
        reject(signal.reason);
      }, { once: true });
      started();
    }),
  };
  const sandbox = new CodemodeSandbox({ tools: [wait] });
  const client = new Client({ name: "agent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const controller = new AbortController();
  try {
    await connectCodeMode(serverTransport, {
      name: "wait",
      version: "1.0.0",
      tools: [wait],
      run: ({ code, ...options }) => sandbox.execute(code, options),
    });
    await client.connect(clientTransport);
    const pending = client.callTool({ name: "execute", arguments: { code: "await tools.wait({});" } }, undefined, {
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toBeDefined();
    await hasStarted;
    controller.abort();
    await rejection;
    await wasCanceled;
  } finally {
    await sandbox.close();
    await client.close();
    await serverTransport.close();
  }
});
