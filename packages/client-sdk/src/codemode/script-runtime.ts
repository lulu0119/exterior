import { renderToolSignature, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import type { CodemodeTool } from "@earendil-works/pi-codemode/portable";
import { z } from "zod";
import { findCatalogEntries, type ScriptLibrary } from "./scripts.js";

export type CodeModeProgram = { code: string; globals: CodemodeTool[] };

const discoveryArgument = z.string();

export function createCatalogGlobals(scripts: ScriptLibrary, tools: readonly Omit<CodemodeTool, "execute">[]): CodemodeTool[] {
  const methods = new Map(tools.map((tool) => [`tools.${toCodemodeIdentifier(tool.name)}`, tool]));
  const methodEntries = [...methods].map(([name, tool]) => ({ kind: "method", name, description: tool.description }));

  return [
    {
      name: "codemode.search",
      async execute(query) {
        const snippets = await scripts.list();
        const entries = [...methodEntries, ...snippets.map((script) => ({ ...script, kind: "snippet" }))];
        const matches = findCatalogEntries(entries, discoveryArgument.parse(query));
        return {
          results: matches.slice(0, 10).map(({ name, ...entry }) => ({ ...entry, path: name })),
          total: matches.length,
          truncated: matches.length > 10,
        };
      },
    },
    {
      name: "codemode.describe",
      async execute(target) {
        const path = discoveryArgument.parse(target);
        const tool = methods.get(path);
        if (tool) {
          return { kind: "method", path, description: tool.description, types: `declare const tools: { ${renderToolSignature(tool)} };` };
        }
        const script = await scripts.get(path);
        if (!script) throw new Error(`No saved script named "${path}".`);
        return { ...script, kind: "snippet", path };
      },
    },
  ];
}

export function withSavedScripts(code: string): string {
  return `return await (async () => {
  const { search, describe } = globalThis.codemode;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const codemode = Object.freeze({
    search,
    describe,
    async run(name, input) {
      const script = await describe(name);
      if (script.kind !== "snippet") throw new Error(name + " is an app tool. Call it through tools.");
      const execute = new AsyncFunction("input", "codemode", "return await (async () => {\\n" + script.code + "\\n})();");
      return await execute(input, codemode);
    },
  });
  return await (async () => {
${code}
  })();
})();`;
}
