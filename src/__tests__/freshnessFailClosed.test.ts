import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Every freshness check must follow one rule: a persistence-consistency check
// that cannot complete counts as a mismatch, so a `fresh` index is never
// reported as fresh on an unverified snapshot.
const consistency = vi.hoisted(() => ({ throws: false }));

vi.mock("../core/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/registry")>();
  return {
    ...actual,
    checkPersistenceConsistency: (projectId: string) => {
      if (consistency.throws) throw new Error("simulated consistency-check failure");
      return actual.checkPersistenceConsistency(projectId);
    },
  };
});

import { registerProject, loadProjectIndex } from "../core/registry";
import { indexProject } from "../core/indexer";
import {
  ensureFreshIndex,
  getGraphFreshness,
  getValidatedFreshness,
  isPersistenceMismatched,
} from "../core/codeModeWorkflow";

let tmpHome = "";
let tmpRoot = "";
const prevHome = process.env.KAI_HOME;

beforeEach(() => {
  consistency.throws = false;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-home-"));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kai-proj-"));
  process.env.KAI_HOME = tmpHome;
  fs.writeFileSync(path.join(tmpRoot, "a.ts"), "export function alpha() { return 1; }\n");
});

afterEach(() => {
  consistency.throws = false;
  process.env.KAI_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("persistence consistency fails closed", () => {
  it("reports a consistent snapshot as matched", async () => {
    const meta = registerProject(tmpRoot);
    const index = await indexProject(meta);
    expect(isPersistenceMismatched(meta.id)).toBe(false);
    expect(getValidatedFreshness(meta.id, index)).toBe("fresh");
  });

  it("counts a check that throws as a mismatch", async () => {
    const meta = registerProject(tmpRoot);
    const index = await indexProject(meta);
    expect(getGraphFreshness(index)).toBe("fresh");

    consistency.throws = true;
    expect(isPersistenceMismatched(meta.id)).toBe(true);
    expect(getValidatedFreshness(meta.id, index)).toBe("stale");
  });

  it("ensureFreshIndex does not skip the refresh when the check throws", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const index = loadProjectIndex(meta.id);

    consistency.throws = true;
    const result = await ensureFreshIndex(meta, index);
    expect(result.refreshOutcome).not.toBe("not-required");
  });
});
