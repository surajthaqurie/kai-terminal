import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { registerProject } from "../core/registry";
import {
  indexProject,
  detectStaleIndexEntries,
  resolveMaxTotalFiles,
  DEFAULT_MAX_TOTAL_FILES,
  MIN_ENV_MAX_TOTAL_FILES,
  HARD_MAX_TOTAL_FILES,
} from "../core/indexer";

let tmpHome = "";
let tmpRoot = "";
const prevHome = process.env.KAI_HOME;
const prevCap = process.env.KAI_MAX_INDEX_FILES;

function writeFiles(count: number): void {
  fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(tmpRoot, "src", `f${i}.ts`), `export const v${i} = ${i};\n`);
  }
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cap-home-"));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cap-proj-"));
  process.env.KAI_HOME = tmpHome;
  delete process.env.KAI_MAX_INDEX_FILES;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = prevHome;
  if (prevCap === undefined) delete process.env.KAI_MAX_INDEX_FILES;
  else process.env.KAI_MAX_INDEX_FILES = prevCap;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveMaxTotalFiles (KAI_MAX_INDEX_FILES)", () => {
  it("defaults to 10,000 when unset, empty or not a plain whole number", () => {
    expect(DEFAULT_MAX_TOTAL_FILES).toBe(10000);
    for (const raw of [undefined, "", "   ", "abc", "-5", "1e4", "12.5", "0x20", "1,000"]) {
      expect(resolveMaxTotalFiles(raw)).toBe(DEFAULT_MAX_TOTAL_FILES);
    }
  });

  it("uses a whole number as given, ignoring surrounding whitespace", () => {
    expect(resolveMaxTotalFiles("250")).toBe(250);
    expect(resolveMaxTotalFiles(" 30000 ")).toBe(30000);
  });

  it("clamps to the floor and the hard ceiling instead of rejecting", () => {
    expect(resolveMaxTotalFiles("0")).toBe(MIN_ENV_MAX_TOTAL_FILES);
    expect(resolveMaxTotalFiles("5")).toBe(MIN_ENV_MAX_TOTAL_FILES);
    expect(resolveMaxTotalFiles("999999999")).toBe(HARD_MAX_TOTAL_FILES);
    expect(resolveMaxTotalFiles("99999999999999")).toBe(DEFAULT_MAX_TOTAL_FILES);
  });

  it("reads the process environment by default", () => {
    process.env.KAI_MAX_INDEX_FILES = "400";
    expect(resolveMaxTotalFiles()).toBe(400);
  });
});

describe("the scan honours the configured file cap", () => {
  it("stops at KAI_MAX_INDEX_FILES and reports it as the limit", async () => {
    writeFiles(130);
    process.env.KAI_MAX_INDEX_FILES = "100";
    const index = await indexProject(registerProject(tmpRoot));
    expect(index.scan).toMatchObject({ complete: false, fileLimitReached: true, fileLimit: 100 });
    expect(Object.keys(index.files).length).toBeLessThanOrEqual(100);
  });

  it("indexes everything under the default cap and reports it", async () => {
    writeFiles(130);
    const index = await indexProject(registerProject(tmpRoot));
    expect(index.scan).toMatchObject({
      complete: true,
      fileLimitReached: false,
      fileLimit: DEFAULT_MAX_TOTAL_FILES,
    });
    expect(Object.keys(index.files)).toHaveLength(130);
  });

  it("lets an explicit option override the environment, up to the hard ceiling", async () => {
    writeFiles(130);
    process.env.KAI_MAX_INDEX_FILES = "100";
    const roomy = await indexProject(registerProject(tmpRoot), {
      maxTotalFiles: 5 * HARD_MAX_TOTAL_FILES,
    });
    expect(roomy.scan?.fileLimit).toBe(HARD_MAX_TOTAL_FILES);
    expect(roomy.scan?.complete).toBe(true);
    const tight = await indexProject(registerProject(tmpRoot), {
      maxTotalFiles: 20,
      forceRebuild: true,
    });
    expect(tight.scan?.fileLimit).toBe(20);
  });

  it("falls back to the configured cap for a non-finite option instead of scanning unbounded", async () => {
    writeFiles(130);
    process.env.KAI_MAX_INDEX_FILES = "100";
    const index = await indexProject(registerProject(tmpRoot), { maxTotalFiles: Number.NaN });
    expect(index.scan?.fileLimit).toBe(100);
    expect(index.scan?.fileLimitReached).toBe(true);
  });

  it("rebuilds a capped snapshot once after the cap is raised, then settles", async () => {
    writeFiles(130);
    const meta = registerProject(tmpRoot);
    process.env.KAI_MAX_INDEX_FILES = "100";
    const capped = await indexProject(meta);
    expect(capped.scan?.fileLimitReached).toBe(true);
    // Same cap: the snapshot is not stale just for being capped (no refresh loop).
    expect(detectStaleIndexEntries(capped).isStale).toBe(false);

    process.env.KAI_MAX_INDEX_FILES = "200";
    expect(detectStaleIndexEntries(capped).isStale).toBe(true);

    const raised = await indexProject(meta);
    expect(raised.scan).toMatchObject({ complete: true, fileLimit: 200 });
    expect(Object.keys(raised.files)).toHaveLength(130);
    expect(detectStaleIndexEntries(raised).isStale).toBe(false);
  });

  it("does not treat a snapshot capped by a caller's option as stale without the env setting", async () => {
    writeFiles(30);
    const capped = await indexProject(registerProject(tmpRoot), { maxTotalFiles: 5 });
    expect(capped.scan?.fileLimitReached).toBe(true);
    expect(detectStaleIndexEntries(capped).isStale).toBe(false);
  });
});
