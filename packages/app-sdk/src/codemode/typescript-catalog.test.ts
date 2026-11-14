import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTypeScriptCatalog } from "./typescript-catalog.js";

describe("TypeScript capability catalog", () => {
  it("reads SDK signatures and derives bindings for returned public capabilities", () => {
    const directory = mkdtempSync(join(tmpdir(), "exterior-catalog-"));
    try {
      const source = join(directory, "reports.ts");
      writeFileSync(source, `
        export interface Row { score: number }
        export type ReportTarget = string | { id: string }
        export class Report {
          #key = "local";
          private token = "";
          protected internals() { return this.#key + this.token }
          /** Read this report's rows. */
          rows(): Row[] { return [] }
          remove(): void {}
        }
        export const reports = {
          current: () => new Report(),
          list: async (): Promise<readonly Report[]> => [],
          internal: () => "private",
        };
      `);
      const catalog = buildTypeScriptCatalog({
        extraTypes: [{ source, symbol: "ReportTarget" }],
        namespaces: [
          { source, symbol: "reports", namespace: "reports", members: ["current", "list"] },
          { source, symbol: "Report", namespace: "Report", returned: true, unavailable: { remove: "Read-only" } },
        ],
      });
      expect(catalog.entries.map(({ path }) => path)).toEqual([
        "reports.current", "reports.list", "Report.rows", "Report.remove",
      ]);
      expect(catalog.entries.find(({ path }) => path === "reports.current")?.returns).toEqual({ namespace: "Report" });
      expect(catalog.entries.find(({ path }) => path === "reports.list")?.returns)
        .toEqual({ namespace: "Report", collection: true });
      expect(catalog.entries.find(({ path }) => path === "Report.rows")).toMatchObject({
        description: "Read this report's rows.", signature: "Report.rows(): Array<Row>",
      });
      expect(catalog.entries.find(({ path }) => path === "Report.remove")?.unavailable).toBe("Read-only");
      expect(catalog.types.Report.definition).not.toMatch(/key|token|internals|remove/);
      expect(catalog.types.Row.definition).toContain("score: number");
      expect(catalog.types.ReportTarget.definition).toContain("string");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
