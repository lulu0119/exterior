import Fuse from "fuse.js";
import { prefixStorage, type Storage } from "unstorage";
import { z } from "zod";

const inputSchema = z.union([z.boolean(), z.record(z.string(), z.json())]);
const nameSchema = z.string().min(1).max(64).regex(
  /^[\p{L}\p{N}_-]+$/u,
  "Script names may contain letters, numbers, underscores, and hyphens.",
);
const definitionSchema = z.strictObject({
  name: nameSchema,
  description: z.string().min(1).max(2_000),
  code: z.string().max(100_000).refine((code) => code.trim().length > 0, "Script must not be empty."),
  tags: z.array(z.string().min(1).max(64)).max(16).default([]),
  inputSchema: inputSchema.optional(),
});
const recordSchema = definitionSchema.extend({ updatedAt: z.number().int().nonnegative() });
const querySchema = z.string().trim().min(1).max(500);
const limitSchema = z.number().int().min(1).max(50);

export type ScriptDefinition = z.input<typeof definitionSchema>;
export type SavedScript = z.output<typeof recordSchema>;
export type ScriptSummary = Omit<SavedScript, "code" | "inputSchema">;

export type ScriptLibrary = {
  save(script: ScriptDefinition): Promise<SavedScript>;
  get(name: string): Promise<SavedScript | null>;
  list(): Promise<ScriptSummary[]>;
  search(query: string, limit?: number): Promise<ScriptSummary[]>;
  remove(name: string): Promise<void>;
};

export function findCatalogEntries<T extends { name: string; description?: string; tags?: string[] }>(
  entries: readonly T[],
  query: string,
): T[] {
  const term = querySchema.parse(query);
  const index = new Fuse(entries, {
    keys: [{ name: "name", weight: 3 }, { name: "description", weight: 2 }, "tags"],
    ignoreLocation: true,
    threshold: 0.3,
  });
  return index.search(term).map(({ item }) => item);
}

function summary({ code: _code, inputSchema: _inputSchema, ...metadata }: SavedScript): ScriptSummary {
  return metadata;
}

export function createScriptLibrary({ storage }: { storage: Storage }): ScriptLibrary {
  const records = prefixStorage(storage, "scripts");

  async function storageKey(name: string): Promise<string> {
    const bytes = new TextEncoder().encode(nameSchema.parse(name));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return `script-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  async function get(name: string): Promise<SavedScript | null> {
    const value = await records.getItem(await storageKey(name));
    return value === null ? null : recordSchema.parse(value);
  }

  async function list(): Promise<ScriptSummary[]> {
    const keys = (await records.getKeys()).filter((key) => key.startsWith("script-"));
    const values = await Promise.all(keys.map((key) => records.getItem(key)));
    return values
      .filter((value) => value !== null)
      .map((value) => summary(recordSchema.parse(value)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    async save(definition) {
      const script = definitionSchema.parse(definition);
      const saved = { ...script, updatedAt: Date.now() };
      await records.setItem(await storageKey(saved.name), saved);
      return saved;
    },
    get,
    list,
    async search(query, limit = 10) {
      const count = limitSchema.parse(limit);
      return findCatalogEntries(await list(), query).slice(0, count);
    },
    async remove(name) {
      await records.removeItem(await storageKey(name));
    },
  };
}
