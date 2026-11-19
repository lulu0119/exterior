import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { expect, it } from "vitest";
import { createMcpApp } from "./index.js";
import { connectTestClient } from "../test-support/client.js";

it("lets independent MCP clients discover metadata and read verified files on demand", async () => {
  const instructions = "Read references/windows.md before choosing a window.";
  const reference = "Resolve the selected window by application ID.";
  const connect = await createMcpApp({
    name: "reports", version: "1",
    skills: {
      "reports/SKILL.md": `---\nname: reports\ndescription: Read window reports.\n---\n${instructions}`,
      "reports/references/windows.md": reference,
    },
  });
  for (let session = 0; session < 2; session++) {
    const reads: string[] = [];
    const client = await connectTestClient(connect, async (request) => {
      const message = await request.json();
      if (message.method === "resources/read") reads.push(message.params.uri);
    });
    const skills = new SkillsClient(client);
    expect(skills.supported).toBe(true);
    const { skills: [entry] } = await skills.list();
    expect(entry.uri).toBe("skill://reports/SKILL.md");
    expect(JSON.stringify(entry)).not.toContain(instructions);
    expect(JSON.stringify(entry)).not.toContain(reference);
    expect(reads).toEqual([]);
    expect(await skills.read(entry)).toMatchObject({ verified: true, body: expect.stringContaining(instructions) });
    expect(reads).toEqual([entry.uri]);
    expect(await skills.read(entry, "references/windows.md")).toMatchObject({ verified: true, text: reference });
    expect(reads).toEqual([entry.uri, "skill://reports/references/windows.md"]);
  }
});
