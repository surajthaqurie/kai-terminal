import { createRequire } from "module";
import path from "path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { psQuote, buildPathUpdateScript, runPowerShell, PATH_DIR_ENV } =
  require("../../scripts/setup-cli.cjs") as {
    psQuote: (value: string) => string;
    buildPathUpdateScript: (scope?: string) => string;
    runPowerShell: (
      script: string,
      timeoutMs?: number,
      env?: Record<string, string>
    ) => string | null;
    PATH_DIR_ENV: string;
  };

describe("setup-cli PowerShell quoting", () => {
  it("doubles an apostrophe so a path like C:\\Users\\O'Brien stays one string", () => {
    expect(psQuote("C:\\Users\\O'Brien\\.kai\\bin")).toBe("'C:\\Users\\O''Brien\\.kai\\bin'");
    expect(psQuote("plain")).toBe("'plain'");
    expect(psQuote("''")).toBe("''''''");
  });

  it("never interpolates the directory into the script text", () => {
    const script = buildPathUpdateScript();
    expect(script).toContain(`$env:${PATH_DIR_ENV}`);
    expect(script).not.toMatch(/Users|O'Brien/);
    // Targets the persistent per-user PATH.
    expect(script).toContain("'User'");
  });
});

// Process scope only: the real script targets the User registry PATH, which a test must not touch.
describe.runIf(process.platform === "win32")("PATH update script run in PowerShell", () => {
  const run = (dir: string): string | null =>
    runPowerShell(buildPathUpdateScript("Process"), 30000, { [PATH_DIR_ENV]: dir });

  it.each([
    ["an apostrophe", "C:\\Users\\O'Brien\\.kai\\bin"],
    ["cmd metacharacters", "C:\\Users\\Tom & Jerry\\100%\\(x86)\\.kai\\bin"],
    ["a dollar sign and a space", "C:\\Users\\$Some User\\.kai\\bin"],
  ])("handles a profile path with %s", (_label, dir) => {
    expect(run(dir)?.trim()).toBe("CHANGED");
  });

  it("reports a directory already on PATH as present", () => {
    expect(run(path.dirname(process.execPath))?.trim()).toBe("PRESENT");
  });
});
