import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createStorage } from "unstorage";
import { expect, it, vi } from "vitest";
import { connectCodeMode, createScriptLibrary, type CodeModeRequest, type CodemodeTool } from "./index.js";

async function runInPi({ code, program, signal, timeoutMs }: CodeModeRequest, tools: CodemodeTool[] = []) {
  const sandbox = new CodemodeSandbox({ tools, globals: program?.globals });
  try {
    return await sandbox.execute(program?.code ?? code, { signal, timeoutMs, store: { baseline: 4 } });
  } finally {
    await sandbox.close();
  }
}

it("discovers app tools and saved scripts, then composes their results in one execution", async () => {
  const storage = createStorage();
  const inputSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { minimum: { type: "number" } },
  };
  const saved = await createScriptLibrary({ storage }).save({
    name: "scores",
    description: "Filter report scores.",
    code: `const scores = await tools.report_scores({});
store("minimum", input.minimum);
text(scores.length);
return scores.filter(score => score >= input.minimum);`,
    inputSchema,
  });
  const scripts = createScriptLibrary({ storage });
  await scripts.save({
    name: "total",
    description: "Add the filtered scores.",
    code: `const rows = await codemode.run("scores", input);
return rows.reduce((sum, score) => sum + score, 0);`,
  });
  let values = [3, 1, 7];
  const tools = [{ name: "report-scores", description: "Read report scores.", execute: () => values }];
  const run = vi.fn((request: CodeModeRequest) => runInPi(request, tools));
  const client = new Client({ name: "harness", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await connectCodeMode(serverTransport, { name: "reports", version: "1.0.0", tools, scripts, run });
    await client.connect(clientTransport);
    const { tools: [tool, ...others] } = await client.listTools();
    expect(others).toEqual([]);
    expect(tool).toMatchObject({ name: "execute" });
    expect(tool.description).toContain("codemode.search(query)");
    const code = `const { results } = await codemode.search("scores");
const descriptions = await Promise.all(results.map(item => codemode.describe(item.path)));
const total = await codemode.run("total", { minimum: "3" });
const result = total + load("baseline");
return { results, descriptions, result, minimum: load("minimum") };`;
    const result = await client.callTool({ name: "execute", arguments: { code } });
    expect(result.isError).toBe(false);
    expect(result.content).toMatchObject([{ type: "text", text: "3" }, { type: "text", text: expect.any(String) }]);
    const output = CallToolResultSchema.parse(result).content[1];
    if (output.type !== "text") throw new Error("Expected a text result.");
    expect(JSON.parse(output.text)).toMatchObject({
      result: 14, minimum: "3",
      results: expect.arrayContaining([
        { kind: "method", path: "tools.report_scores", description: tools[0].description },
        { kind: "snippet", path: "scores", description: saved.description, tags: [], updatedAt: saved.updatedAt },
      ]),
      descriptions: expect.arrayContaining([
        { kind: "method", path: "tools.report_scores", description: tools[0].description, types: expect.stringContaining("report_scores(args:") },
        { ...saved, kind: "snippet", path: "scores", inputSchema },
      ]),
    });
    expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code }));
    const execution = run.mock.settledResults[0];
    if (execution.type !== "fulfilled") throw new Error("Expected a completed execution.");
    const completed = execution.value;
    expect(completed.calls.map((call) => call.name)).toEqual(["report-scores"]);
    expect(completed).toMatchObject({ ok: true, storeWrites: { set: { minimum: "3" } } });

    values = [8, 6];
    const next = await client.callTool({
      name: "execute",
      arguments: { code: 'return (await codemode.run("scores", { minimum: 7 })).at(0);' },
    });
    expect(next.content).toEqual([{ type: "text", text: "2" }, { type: "text", text: "8" }]);
  } finally {
    await client.close();
    await serverTransport.close();
  }
});

it("keeps inputs inside the sandbox and lets scripts handle a saved script failing", async () => {
  const scripts = createScriptLibrary({ storage: createStorage() });
  await scripts.save({ name: "echo", description: "Echo input.", code: "return input;" });
  await scripts.save({ name: "local", description: "Use a local variable.", code: "const input = 42; return input;" });
  await scripts.save({ name: "fail", description: "Report a failure.", code: 'text("before"); throw new Error("Failed.");' });
  const client = new Client({ name: "harness", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await connectCodeMode(serverTransport, {
      name: "reports", version: "1.0.0", tools: [], scripts,
      run: runInPi,
    });
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "execute", arguments: { code: `
      const input = JSON.parse('{"__proto__":5}');
      const echoed = await codemode.run("echo", input);
      const local = await codemode.run("local");
      try {
        await codemode.run("fail");
      } catch (error) {
        return [echoed === input, echoed["__proto__"], local, error.message];
      }
    ` } });
    expect(result.content).toEqual([{ type: "text", text: "before" }, { type: "text", text: '[true,5,42,"Failed."]' }]);
  } finally {
    await client.close();
    await serverTransport.close();
  }
});

it("cancels a tool called by a saved script through the Pi tool signal", async () => {
  const scripts = createScriptLibrary({ storage: createStorage() });
  await scripts.save({ name: "wait", description: "Wait for an app result.", code: "await tools.wait({});" });
  let started: () => void = () => undefined;
  let canceled: () => void = () => undefined;
  const hasStarted = new Promise<void>((resolve) => { started = resolve; });
  const wasCanceled = new Promise<void>((resolve) => { canceled = resolve; });
  const tools = [{
    name: "wait",
    execute: (_args: unknown, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { canceled(); reject(signal.reason); }, { once: true });
      started();
    }),
  }];
  const client = new Client({ name: "harness", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const controller = new AbortController();
  try {
    await connectCodeMode(serverTransport, {
      name: "reports", version: "1.0.0", tools, scripts,
      run: (request) => runInPi(request, tools),
    });
    await client.connect(clientTransport);
    const pending = client.callTool({
      name: "execute", arguments: { code: 'await codemode.run("wait");' },
    }, undefined, { signal: controller.signal });
    const rejection = expect(pending).rejects.toBeDefined();
    await hasStarted;
    controller.abort();
    await rejection;
    await wasCanceled;
  } finally {
    await client.close();
    await serverTransport.close();
  }
});
