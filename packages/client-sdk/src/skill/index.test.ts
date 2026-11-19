import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { expect, it, vi } from "vitest";
import { createSkillProvider } from "./index.js";

it("lets independent MCP clients discover metadata and read verified files on demand", async () => {
  const instructions = "Read references/windows.md before choosing a window.";
  const reference = "Resolve the selected window by application ID.";
  const connect = await createSkillProvider({
    name: "reports", version: "1",
    files: {
      "reports/SKILL.md": `---\nname: reports\ndescription: Read window reports.\n---\n${instructions}`,
      "reports/references/windows.md": reference,
    },
  });
  for (let session = 0; session < 2; session++) {
    const [agent, app] = InMemoryTransport.createLinkedPair();
    const send = vi.spyOn(agent, "send");
    const client = new Client({ name: "skill-reader", version: "1" }, { versionNegotiation: { mode: "legacy" } });
    try {
      await connect(app);
      await client.connect(agent);
      const skills = new SkillsClient(client);
      expect(skills.supported).toBe(true);
      const { skills: [entry] } = await skills.list();
      expect(entry.uri).toBe("skill://reports/SKILL.md");
      expect(JSON.stringify(entry)).not.toContain(instructions);
      expect(JSON.stringify(entry)).not.toContain(reference);
      const reads = () => send.mock.calls.flatMap(([message]) => "method" in message && message.method === "resources/read" ? [message.params?.uri] : []);
      expect(reads()).toEqual([]);
      expect(await skills.read(entry)).toMatchObject({ verified: true, body: expect.stringContaining(instructions) });
      expect(reads()).toEqual([entry.uri]);
      expect(await skills.read(entry, "references/windows.md")).toMatchObject({ verified: true, text: reference });
      expect(reads()).toEqual([entry.uri, "skill://reports/references/windows.md"]);
    } finally {
      await client.close();
    }
  }
});
