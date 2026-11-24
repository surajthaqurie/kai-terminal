import path from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";

/** A full test run that silently drops a test file must fail (see scripts/check-test-run.mjs). */
type Report = { testResults?: Array<{ name: string }> };
const load = async () =>
  (await import(
    pathToFileURL(path.resolve(__dirname, "../../scripts/check-test-run.mjs")).href
  )) as {
    normalizePath(file: string, platform?: string): string;
    missingFiles(listed: string[], report: Report, platform?: string): string[];
  };

describe("check-test-run", () => {
  it("names the test files the report has no results for", async () => {
    const { missingFiles } = await load();
    const listed = ["/repo/a.test.ts", "/repo/appShell.test.tsx", "/repo/c.test.ts"];
    const report = { testResults: [{ name: "/repo/a.test.ts" }, { name: "/repo/c.test.ts" }] };
    expect(missingFiles(listed, report, "linux")).toEqual(["/repo/appShell.test.tsx"]);
  });

  it("passes a complete run", async () => {
    const { missingFiles } = await load();
    const listed = ["/repo/a.test.ts"];
    expect(missingFiles(listed, { testResults: [{ name: "/repo/a.test.ts" }] }, "linux")).toEqual(
      []
    );
  });

  it("treats a report with no results as every file missing", async () => {
    const { missingFiles } = await load();
    expect(missingFiles(["/repo/a.test.ts"], {}, "linux")).toEqual(["/repo/a.test.ts"]);
  });

  it("matches Windows paths whatever their slashes or drive-letter case", async () => {
    const { missingFiles, normalizePath } = await load();
    expect(normalizePath("C:\\Repo\\A.test.ts", "win32")).toBe("c:/repo/a.test.ts");
    const report = { testResults: [{ name: "c:\\repo\\src\\a.test.ts" }] };
    expect(missingFiles(["C:/Repo/src/a.test.ts"], report, "win32")).toEqual([]);
  });

  it("keeps case on case-sensitive systems", async () => {
    const { missingFiles } = await load();
    const report = { testResults: [{ name: "/repo/A.test.ts" }] };
    expect(missingFiles(["/repo/a.test.ts"], report, "linux")).toEqual(["/repo/a.test.ts"]);
  });
});
