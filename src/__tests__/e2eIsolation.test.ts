import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * CI-04: the end-to-end suite launches the real app. It must never share a profile or the
 * single-instance lock with a Kai a developer is running: the app under test is built with
 * tauri.e2e.conf.json, whose identifier differs, and the driver runs with a throwaway home.
 */
const root = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

describe("end-to-end isolation", () => {
  it("the app under test has its own identifier", () => {
    const main = JSON.parse(read("src-tauri/tauri.conf.json")).identifier;
    const e2e = JSON.parse(read("src-tauri/tauri.e2e.conf.json")).identifier;
    expect(typeof e2e).toBe("string");
    expect(e2e).not.toBe(main);
    expect(e2e.startsWith(`${main}.`)).toBe(true); // recognisably a variant of the real app
  });

  it("CI builds the app under test with that config", () => {
    expect(read(".github/workflows/ci.yml")).toContain(
      "npx tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json"
    );
  });

  it("the driver runs with a throwaway home folder", () => {
    const setup = read("e2e/globalSetup.ts");
    expect(setup).toMatch(/mkdtempSync\(/);
    expect(setup).toMatch(/HOME:\s*home,\s*USERPROFILE:\s*home/);
  });

  it("the unit suite never collects the end-to-end specs", () => {
    const specs = fs.readdirSync(path.join(root, "e2e")).filter((f) => f.endsWith(".e2e.ts"));
    expect(specs.length).toBeGreaterThan(0);
    for (const f of specs) expect(f).not.toMatch(/\.(test|spec)\.[cm]?[jt]sx?$/);
  });
});
