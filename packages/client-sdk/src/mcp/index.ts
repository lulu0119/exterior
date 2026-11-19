import { McpServer, type McpRequestContext } from "@modelcontextprotocol/server";

export async function createMcpApp({ name, version, skills, configure }: {
  name: string;
  version: string;
  skills?: Record<string, string | Uint8Array>;
  configure?: (server: McpServer, context: McpRequestContext) => void | Promise<void>;
}) {
  const catalog = skills && await import("@modelcontextprotocol/server/ext/skills").then(({ SkillsExtension, memorySkillFiles }) =>
    SkillsExtension.load(memorySkillFiles(skills), { strict: true }));
  return async (context: McpRequestContext) => {
    const server = new McpServer({ name, version });
    catalog?.attach(server);
    await configure?.(server, context);
    return server;
  };
}
