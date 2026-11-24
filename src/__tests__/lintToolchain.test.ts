import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * CI-08: ESLint runs from tools/lint with its own TypeScript, because typescript-eslint cannot run
 * on the TypeScript 7.0 the app uses. That only works while the toolchain stays isolated and on
 * a TypeScript typescript-eslint supports.
 */
const root = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const lintPkg = JSON.parse(read("tools/lint/package.json"));
const deps: Record<string, string> = lintPkg.devDependencies;

describe("the isolated lint toolchain", () => {
  it("pins exact versions, with its own lockfile", () => {
    for (const [name, version] of Object.entries(deps)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(fs.existsSync(path.join(root, "tools/lint/package-lock.json"))).toBe(true);
  });

  it("uses a TypeScript that typescript-eslint supports (below 6.1), not the app's", () => {
    const [major, minor] = deps.typescript.split(".").map(Number);
    expect(major * 100 + minor).toBeLessThan(601);
    const app = JSON.parse(read("package.json"));
    // The app itself stays on its own TypeScript and never depends on the linter's.
    expect(app.devDependencies.typescript).not.toBe(deps.typescript);
    expect(Object.keys(app.devDependencies)).not.toContain("typescript-eslint");
  });

  it("CI installs it and runs ESLint with no warnings allowed", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("npm run lint:install");
    expect(ci).toContain("npm run lint:eslint");
    expect(JSON.parse(read("package.json")).scripts["lint:eslint"]).toContain("--max-warnings 0");
  });
});
