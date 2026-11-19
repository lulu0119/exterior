import { McpServer, type Transport } from "@modelcontextprotocol/server";
import { memorySkillFiles, SkillsExtension } from "@modelcontextprotocol/server/ext/skills";

export async function createSkillProvider({ name, version, files }: {
  name: string;
  version: string;
  files: Record<string, string | Uint8Array>;
}) {
  const catalog = await SkillsExtension.load(memorySkillFiles(files), { strict: true });
  return async (transport: Transport) => {
    const server = new McpServer({ name, version });
    catalog.attach(server);
    await server.connect(transport);
  };
}
