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

  it("CI builds the app under test with that config, into its own folder", () => {
    expect(read(".github/workflows/ci.yml")).toContain(
      'CARGO_TARGET_DIR="$PWD/src-tauri/target/e2e" npx tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json'
    );
  });

  it("the setup's build hint is the command CI runs", () => {
    const setup = read("e2e/globalSetup.ts");
    const ci = read(".github/workflows/ci.yml");
    const hint = /BUILD_COMMAND =\s*'([^']+)'/.exec(setup)?.[1];
    expect(hint).toBeDefined();
    expect(ci).toContain(hint!);
  });

  it("the setup refuses a binary that does not carry the e2e identifier", () => {
    const setup = read("e2e/globalSetup.ts");
    const e2e = JSON.parse(read("src-tauri/tauri.e2e.conf.json")).identifier;
    expect(setup).toContain(`E2E_IDENTIFIER = "${e2e}"`);
    expect(setup).toMatch(/readFileSync\(app\)\.includes\(Buffer\.from\(E2E_IDENTIFIER\)\)/);
    expect(setup).toContain('join("src-tauri", "target", "e2e", "debug", exe)');
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
