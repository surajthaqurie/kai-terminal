import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";

/**
 * RES-03: the Node.js runtime shipped in the installers was hard-coded in a script
 * (22.12.0, from late 2024, with no way to notice newer security releases). It is now pinned in
 * one file, and a weekly job proposes newer releases of the same LTS line.
 */
const scripts = path.resolve(__dirname, "../../scripts");

type Updater = {
  parseVersion(v: string): number[] | null;
  compareVersions(a: string, b: string): number;
  pickLatestLts(index: unknown[], major: number): string | null;
  readPinnedVersion(file?: string): string;
};
// A dynamic import by URL: the script is plain ESM (it also runs under `node` in CI).
const load = async (): Promise<Updater> =>
  (await import(pathToFileURL(path.join(scripts, "update-bundled-node.mjs")).href)) as Updater;

const INDEX = [
  { version: "v26.1.0", lts: false },
  { version: "v24.22.3", lts: "Krypton" },
  { version: "v24.22.10", lts: "Krypton" },
  { version: "v24.9.0", lts: "Krypton" },
  { version: "v24.23.0-rc.1", lts: "Krypton" },
  { version: "v24.30.0", lts: false }, // not (yet) marked LTS
  { version: "v22.23.5", lts: "Jod" },
];

describe("bundled Node.js version", () => {
  it("is pinned in one file as a plain, current-enough release", async () => {
    const { readPinnedVersion, parseVersion } = await load();
    const pinned = readPinnedVersion();
    expect(parseVersion(pinned)).not.toBeNull();
    expect(parseVersion(pinned)![0]).toBeGreaterThanOrEqual(22); // no end-of-life lines
  });

  it("is what fetch-node.mjs downloads (no second, hard-coded default)", () => {
    const source = fs.readFileSync(path.join(scripts, "fetch-node.mjs"), "utf8");
    expect(source).toContain("bundled-node-version.txt");
    expect(source).not.toMatch(/\|\|\s*"\d+\.\d+\.\d+"/);
  });

  it("compares versions numerically, not as text", async () => {
    const { compareVersions } = await load();
    expect(compareVersions("24.10.0", "24.9.0")).toBeGreaterThan(0); // "10" < "9" as text
    expect(compareVersions("v24.22.3", "24.22.3")).toBe(0);
    expect(compareVersions("22.99.99", "24.0.0")).toBeLessThan(0);
  });

  it("picks the newest LTS release of the pinned line only", async () => {
    const { pickLatestLts } = await load();
    expect(pickLatestLts(INDEX, 24)).toBe("24.22.10"); // not 24.9.0, the rc, or the non-LTS 24.30
    expect(pickLatestLts(INDEX, 22)).toBe("22.23.5");
    expect(pickLatestLts(INDEX, 26)).toBeNull(); // 26 is not LTS here: never jump lines
    expect(pickLatestLts([], 24)).toBeNull();
  });

  it("rejects a malformed pin instead of downloading something odd", async () => {
    const { readPinnedVersion } = await load();
    const file = path.join(scripts, "..", "node_modules", `.pin-${process.pid}.txt`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, "24.x\n");
      expect(() => readPinnedVersion(file)).toThrow(/must hold a version/);
      fs.writeFileSync(file, "v24.22.3\n");
      expect(readPinnedVersion(file)).toBe("24.22.3");
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
