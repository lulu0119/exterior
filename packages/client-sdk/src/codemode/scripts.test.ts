import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorage, prefixStorage } from "unstorage";
import fsLite from "unstorage/drivers/fs-lite";
import { expect, it } from "vitest";
import { createScriptLibrary } from "./index.js";

it("keeps source intact and lists metadata without source", async () => {
  const scripts = createScriptLibrary({ storage: createStorage() });
  const code = "\nconst value = '123';\nreturn value;\n";
  const saved = await scripts.save({ name: "report", description: "Read the report.", code });

  expect(await scripts.get("report")).toEqual(saved);
  expect(saved.code).toBe(code);
  expect(saved.tags).toEqual([]);
  expect(await scripts.list()).toEqual([{
    name: "report",
    description: "Read the report.",
    tags: [],
    updatedAt: saved.updatedAt,
  }]);
});

it("finds partial descriptions and tags without returning source", async () => {
  const scripts = createScriptLibrary({ storage: createStorage() });
  await scripts.save({ name: "export", description: "Export the current spreadsheet.", code: "return 1;" });
  await scripts.save({ name: "scores", description: "Read scores.", tags: ["benchmark"], code: "return 2;" });

  expect((await scripts.search("spreadsheet")).map((script) => script.name)).toEqual(["export"]);
  expect((await scripts.search("benchmark")).map((script) => script.name)).toEqual(["scores"]);
  expect(await scripts.search("spreadsheet")).toEqual([expect.not.objectContaining({ code: expect.anything() })]);
});

it("keeps catalogs separate when apps share an underlying storage", async () => {
  const storage = createStorage();
  const reports = createScriptLibrary({ storage: prefixStorage(storage, "reports") });
  const notes = createScriptLibrary({ storage: prefixStorage(storage, "notes") });
  await reports.save({ name: "read", description: "Read reports.", code: "return 'report';" });
  await notes.save({ name: "read", description: "Read notes.", code: "return 'note';" });

  expect((await reports.get("read"))?.code).toBe("return 'report';");
  expect((await notes.get("read"))?.code).toBe("return 'note';");
  expect(await reports.list()).toHaveLength(1);
  await reports.remove("read");
  expect(await reports.get("read")).toBeNull();
  expect(await reports.list()).toEqual([]);
  expect(await notes.list()).toHaveLength(1);
  await expect(reports.get("../notes/read")).rejects.toThrow();
});

it("reads saved scripts from a newly opened filesystem storage", async () => {
  const base = await mkdtemp(join(tmpdir(), "exterior-scripts-"));
  const storage = createStorage({ driver: fsLite({ base }) });
  try {
    const original = createScriptLibrary({ storage });
    await original.save({ name: "report", description: "Read persisted code.", code: "return 123;" });
    await storage.dispose();
    const reopened = createStorage({ driver: fsLite({ base }) });
    try {
      const scripts = createScriptLibrary({ storage: reopened });
      expect((await scripts.get("report"))?.code).toBe("return 123;");
      expect((await scripts.list()).map((script) => script.name)).toEqual(["report"]);
    } finally {
      await reopened.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

it("keeps case-distinct and long Unicode names distinct on filesystem storage", async () => {
  const base = await mkdtemp(join(tmpdir(), "exterior-script-names-"));
  const storage = createStorage({ driver: fsLite({ base }) });
  try {
    const scripts = createScriptLibrary({ storage });
    await scripts.save({ name: "Report", description: "First report.", code: "return 1;" });
    await scripts.save({ name: "report", description: "Second report.", code: "return 2;" });
    const name = "é".repeat(64);
    await scripts.save({ name, description: "A Unicode name.", code: "return 3;" });
    expect((await scripts.get("Report"))?.code).toBe("return 1;");
    expect((await scripts.get("report"))?.code).toBe("return 2;");
    expect((await scripts.get(name))?.code).toBe("return 3;");
    expect(await scripts.list()).toHaveLength(3);
  } finally {
    await storage.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

it("rejects malformed stored records", async () => {
  const storage = createStorage();
  const scripts = createScriptLibrary({ storage });
  await scripts.save({ name: "report", description: "Read a report.", code: "return input;" });
  const [key] = await storage.getKeys();
  await storage.setItem(key, { name: "report", code: 123 });
  await expect(scripts.get("report")).rejects.toThrow();
});
