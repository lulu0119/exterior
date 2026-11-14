import { describe, expect, it } from "vitest";
import { catalogBindings, createApiHelp, type ApiCatalog, type ApiEntry } from "./catalog.js";

function entry(path: string, fields: Partial<ApiEntry> = {}): ApiEntry {
  return { description: "", examples: [], path, relatedTypes: [], signature: path, ...fields };
}

describe("Code Mode catalog", () => {
  it("ranks paths, pages namespaces, and keeps unavailable methods out of discovery", () => {
    const api = createApiHelp({
      entries: [
        entry("report.find"),
        entry("report.notes", { description: "Find related material" }),
        entry("report.findStream", { unavailable: "Streaming results are unavailable." }),
        entry("reporting.find"),
      ],
      types: {},
    }, { starter: ["report.find", "report.findStream"], rules: ["Use the selected report."] });

    expect(api.search({ namespace: "report", query: "find", limit: 1 })).toEqual({
      items: [{ description: "", path: "report.find", signature: "report.find" }],
      next: { offset: 1 },
      remaining: 1,
      total: 2,
    });
    expect(api.search({ namespace: "report", query: "find", offset: 1 }).items.map(({ path }) => path))
      .toEqual(["report.notes"]);
    expect(api.describe({ path: "report.findStream" })).toMatchObject({ found: true, unavailable: "Streaming results are unavailable." });
    expect(api.help()).toMatchObject({
      namespaces: ["report", "reporting"],
      rules: ["Use the selected report."],
      starter: [{ path: "report.find" }],
    });
  });

  it("keeps related definitions within the expansion budget and lets callers look up omitted types", () => {
    const small = { definition: "type Row = { id: string }", description: "", relatedTypes: [] };
    const large = { definition: "x".repeat(1_000), description: "", relatedTypes: [] };
    const api = createApiHelp({
      entries: [entry("report.rows", { relatedTypes: ["Row", "Report"] })],
      types: { Row: small, Report: large },
    }, { maxDescribeCharacters: 400 });

    expect(api.describe({ path: "report.rows" })).toMatchObject({
      found: true,
      omittedTypes: ["Report"],
      types: { Row: small },
    });
    expect(api.describe({ path: "Report" })).toMatchObject({ definition: large.definition, found: true });
    expect(api.describe({ path: "__proto__" })).toMatchObject({ found: false });
  });
});

describe("Code Mode bindings", () => {
  it("exposes only declared app methods and projects their synchronous and asynchronous returned capabilities", async () => {
    const catalog: ApiCatalog = {
      entries: [
        entry("report.get", { returns: { namespace: "Row" } }),
        entry("report.list", { returns: { namespace: "Row", collection: true } }),
        entry("report.stream", { unavailable: "Streaming is unavailable." }),
        entry("report.State"),
        entry("Row.id"),
        entry("Row.label"),
        entry("Row.delete", { unavailable: "Read-only report." }),
      ],
      types: {},
    };
    const row = {
      id: 99n,
      label() { return `Row ${this.id}`; },
      delete() { throw new Error("should never be called"); },
      undocumented() { throw new Error("should never be called"); },
    };
    const bindings = catalogBindings(catalog, "report", {
      privateRow: row,
      get() { return this.privateRow; },
      async list() { return [this.privateRow]; },
      stream() { throw new Error("should never be called"); },
      State: { 1: "READY", READY: 1 },
    });

    expect(Object.keys(bindings).sort()).toEqual(["State", "get", "list"]);
    expect(bindings.State[1]).toBe("READY");
    expect(Object.keys(bindings.get()).sort()).toEqual(["id", "label"]);
    expect(bindings.get().label()).toBe("Row 99");
    const [listed] = await bindings.list();
    expect(listed.id).toBe(99n);
    expect(listed.label()).toBe("Row 99");
    expect(listed).not.toHaveProperty("delete");
    expect(listed).not.toHaveProperty("undocumented");
  });

  it("clones data and prevents a data result from introducing a new callable binding", async () => {
    const catalog: ApiCatalog = {
      entries: [entry("report.snapshot"), entry("report.get")],
      types: {},
    };
    const snapshot = { version: 1n, flags: [true] };
    const bindings = catalogBindings(catalog, "report", {
      snapshot,
      get: async () => ({ nested: { callback: () => 1 } }),
    });

    bindings.snapshot.flags[0] = false;
    expect(snapshot.flags).toEqual([true]);
    expect(bindings.snapshot.version).toBe(1n);
    await expect(bindings.get()).rejects.toMatchObject({ name: "DataCloneError" });
  });

  it("reads declared class members without evaluating undeclared accessors", () => {
    class Report {
      #id = "benchmark";
      get id() { return this.#id; }
      get internal() { throw new Error("should never be read"); }
      title() { return this.#id.toUpperCase(); }
    }
    const report = new Report();
    const catalog = { entries: [entry("report.id"), entry("report.title"), entry("report.toString")], types: {} };
    const bindings = catalogBindings(catalog, "report", report);
    expect(Object.keys(bindings)).toEqual(["id", "title"]);
    expect(bindings.id).toBe("benchmark");
    expect(bindings.title()).toBe("BENCHMARK");
    expect(() => catalogBindings({ ...catalog, entries: [entry("report.constructor")] }, "report", report))
      .toThrow("Invalid script binding path");
  });

  it("rejects duplicate paths so help and execution cannot disagree about availability", () => {
    const catalog = { entries: [entry("report.get"), entry("report.get", { unavailable: "Unavailable." })], types: {} };
    expect(() => createApiHelp(catalog)).toThrow("Duplicate script binding path");
    expect(() => catalogBindings(catalog, "report", {})).toThrow("Duplicate script binding path");
  });
});
