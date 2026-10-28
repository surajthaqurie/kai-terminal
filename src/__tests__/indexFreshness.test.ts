import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { handleMcpMessage } from "../core/mcp";
import {
  registerProject,
  loadProjectIndex,
  getProjectIndexPath,
  checkPersistenceConsistency,
} from "../core/registry";
import {
  indexProject,
  detectStaleIndexEntries,
  isSensitiveContent,
  skipRecordMatches,
} from "../core/indexer";
import { getGraphFreshness } from "../core/codeModeWorkflow";

let tmpHome = "";
let tmpRoot = "";
const prevHome = process.env.KAI_HOME;

// Assembled at runtime so this file does not itself look like a credential.
const FAKE_AWS_KEY = "AKIA" + "A".repeat(16);

function write(rel: string, content: string | Buffer): void {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function indexFileDigest(projectId: string): { mtimeMs: number; sha: string } {
  const p = getProjectIndexPath(projectId);
  return {
    mtimeMs: fs.statSync(p).mtimeMs,
    sha: crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
  };
}

async function search(id: number, query: string) {
  const res = await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "kai_search_code", arguments: { query } },
    },
    tmpRoot
  );
  const content = (res?.result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0].text);
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-fresh-home-"));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kai-fresh-proj-"));
  process.env.KAI_HOME = tmpHome;
  write("src/a.ts", "export function alpha() { return 1; }\n");
  write("src/b.ts", "export function beta() { return 2; }\n");
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.KAI_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("content-rejected files are skipped, not perpetually 'new'", () => {
  it("records a sensitive-content file as skipped with stat-only metadata", async () => {
    write("src/fixture.ts", `export const KEY = "${FAKE_AWS_KEY}";\n`);
    const index = await indexProject(registerProject(tmpRoot));

    expect(index.files["src/fixture.ts"]).toBeUndefined();
    const rec = index.skipped?.["src/fixture.ts"];
    expect(rec?.reason).toBe("sensitive_content");
    // Stat-only memo: no content, no hash, and nothing derived from the secret.
    expect(Object.keys(rec ?? {}).sort()).toEqual(
      ["ctimeMs", "mtimeMs", "reason", "sizeBytes"].filter((k) => k in (rec ?? {})).sort()
    );
    expect(JSON.stringify(index)).not.toContain(FAKE_AWS_KEY);
    expect(index.changes?.skippedCount).toBe(1);
    expect(index.scan?.skippedByReason).toEqual({ sensitive_content: 1 });
    expect(index.scan?.complete).toBe(true);
  });

  it("does not report a skipped file as stale/new, so the graph stays fresh", async () => {
    write("src/fixture.ts", `export const KEY = "${FAKE_AWS_KEY}";\n`);
    const index = await indexProject(registerProject(tmpRoot));
    const drift = detectStaleIndexEntries(index);
    expect(drift.newFiles).toEqual([]);
    expect(drift.isStale).toBe(false);
    expect(getGraphFreshness(index)).toBe("fresh");
  });

  it("repeated kai_search_code calls neither refresh nor rewrite index.json", async () => {
    write("src/fixture.ts", `export const KEY = "${FAKE_AWS_KEY}";\n`);
    write("src/blob.ts", Buffer.from([0x61, 0x00, 0x62, 0x00, 0x63, 0x00]));
    const first = await search(1, "alpha"); // registers + auto-indexes
    expect(first.matchesCount).toBeGreaterThan(0);

    const meta = registerProject(tmpRoot);
    const before = indexFileDigest(meta.id);
    for (let i = 2; i <= 5; i++) {
      const r = await search(i, "alpha");
      expect(r.freshness).toBe("fresh");
      expect(r.refreshOutcome).toBe("not-required");
    }
    expect(indexFileDigest(meta.id)).toEqual(before);
  });

  it("records binary-looking and unreadable files with their own reasons", async () => {
    write("src/blob.ts", Buffer.from([0x61, 0x00, 0x62, 0x00]));
    write("src/locked.ts", "export const LOCKED = 1;\n");
    const realRead = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (typeof p === "string" && p.endsWith("locked.ts")) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync);

    const index = await indexProject(registerProject(tmpRoot));
    expect(index.skipped?.["src/blob.ts"]?.reason).toBe("binary_content");
    expect(index.skipped?.["src/locked.ts"]?.reason).toBe("unreadable");
    expect(detectStaleIndexEntries(index).newFiles).toEqual([]);
  });

  it("reconsiders a skipped file as soon as its content changes", async () => {
    write("src/fixture.ts", `export const KEY = "${FAKE_AWS_KEY}";\n`);
    await search(1, "alpha");
    const meta = registerProject(tmpRoot);
    expect(loadProjectIndex(meta.id)?.skipped?.["src/fixture.ts"]).toBeDefined();

    // The file becomes eligible: it must be re-read, indexed and un-skipped.
    write(
      "src/fixture.ts",
      "export const KEY = 'redacted-value-now-safe';\nexport function nowSafe() {}\n"
    );
    const r = await search(2, "nowSafe");
    expect(r.refreshOutcome).toBe("refreshed");
    const after = loadProjectIndex(meta.id);
    expect(after?.files["src/fixture.ts"]).toBeDefined();
    expect(after?.skipped?.["src/fixture.ts"]).toBeUndefined();
    expect(Object.keys(after?.symbolIndex ?? {})).toContain("nowSafe");
  });

  it("re-records a still-sensitive file once after an edit, then settles", async () => {
    write("src/fixture.ts", `export const KEY = "${FAKE_AWS_KEY}";\n`);
    await search(1, "alpha");
    write("src/fixture.ts", `export const KEY = "${FAKE_AWS_KEY}"; // edited\n`);
    const r2 = await search(2, "alpha");
    expect(r2.refreshOutcome).toBe("refreshed");
    const r3 = await search(3, "alpha");
    expect(r3.refreshOutcome).toBe("not-required");
  });

  it("skip records never match a changed size, mtime or ctime", () => {
    const rec = { reason: "sensitive_content" as const, sizeBytes: 10, mtimeMs: 5, ctimeMs: 6 };
    expect(skipRecordMatches(rec, { size: 10, mtimeMs: 5, ctimeMs: 6 })).toBe(true);
    expect(skipRecordMatches(rec, { size: 11, mtimeMs: 5, ctimeMs: 6 })).toBe(false);
    expect(skipRecordMatches(rec, { size: 10, mtimeMs: 7, ctimeMs: 6 })).toBe(false);
    expect(skipRecordMatches(rec, { size: 10, mtimeMs: 5, ctimeMs: 9 })).toBe(false);
    expect(skipRecordMatches(undefined, { size: 10, mtimeMs: 5 })).toBe(false);
  });

  it("an unreadable record expires so a transient lock is retried", () => {
    const stat = { size: 10, mtimeMs: 5, ctimeMs: 6 };
    const rec = { reason: "unreadable" as const, sizeBytes: 10, mtimeMs: 5, ctimeMs: 6 };
    expect(skipRecordMatches({ ...rec, recordedAtMs: 1_000 }, stat, 1_000 + 59_000)).toBe(true);
    expect(skipRecordMatches({ ...rec, recordedAtMs: 1_000 }, stat, 1_000 + 61_000)).toBe(false);
    expect(skipRecordMatches(rec, stat, 1_000)).toBe(false);
  });

  it("a forced rebuild forgets skip records and re-evaluates every file", async () => {
    write("src/fixture.ts", `export const KEY = "${FAKE_AWS_KEY}";\n`);
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const rebuilt = await indexProject(meta, { forceRebuild: true });
    expect(rebuilt.skipped?.["src/fixture.ts"]?.reason).toBe("sensitive_content");
  });

  it("keeps the dual-copy snapshot consistent when skip records are present", async () => {
    write("src/fixture.ts", `export const KEY = "${FAKE_AWS_KEY}";\n`);
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(true);
  });
});

describe("incomplete scans are never reported as complete", () => {
  it("flags the file-count cap and does not loop on files beyond it", async () => {
    for (let i = 0; i < 10; i++) write(`src/f${i}.ts`, `export function f${i}() {}\n`);
    const meta = registerProject(tmpRoot);
    const index = await indexProject(meta, { maxTotalFiles: 5 });

    expect(index.scan?.complete).toBe(false);
    expect(index.scan?.fileLimitReached).toBe(true);
    expect(index.scan?.fileLimit).toBe(5);
    expect(Object.keys(index.files).length).toBeLessThan(12);

    const drift = detectStaleIndexEntries(index);
    expect(drift.scanIncomplete).toBe(true);
    // Files past the cap are unindexed by design: not "new" forever.
    expect(drift.newFiles).toEqual([]);
    expect(drift.isStale).toBe(false);
  });

  it("still detects edits to indexed files when the scan was capped", async () => {
    for (let i = 0; i < 10; i++) write(`src/f${i}.ts`, `export function f${i}() {}\n`);
    const meta = registerProject(tmpRoot);
    const index = await indexProject(meta, { maxTotalFiles: 5 });
    const indexed = Object.keys(index.files)[0];
    write(indexed, "export function changedAfterIndex() { return 'longer body'; }\n");
    expect(detectStaleIndexEntries(index).staleFiles).toContain(indexed);
  });

  it("marks a normal scan complete", async () => {
    const index = await indexProject(registerProject(tmpRoot));
    expect(index.scan).toMatchObject({
      complete: true,
      fileLimitReached: false,
      depthLimitReached: false,
      unreadableDirs: 0,
    });
  });
});

describe("legacy indexes without skip/scan fields", () => {
  it("still load and settle to fresh after one refresh", async () => {
    write("src/fixture.ts", `export const KEY = "${FAKE_AWS_KEY}";\n`);
    const meta = registerProject(tmpRoot);
    const built = await indexProject(meta);
    // Simulate an index written by an older build.
    const legacy = JSON.parse(JSON.stringify(built));
    delete legacy.skipped;
    delete legacy.scan;
    delete legacy.extractorVersion;
    fs.writeFileSync(getProjectIndexPath(meta.id), JSON.stringify(legacy));

    expect(loadProjectIndex(meta.id)).not.toBeNull();
    const r1 = await search(1, "alpha");
    expect(r1.matchesCount).toBeGreaterThan(0);
    const r2 = await search(2, "alpha");
    expect(r2.refreshOutcome).toBe("not-required");
  });
});

describe("secret-content detection precision", () => {
  it("does not flag long kebab-case words that merely end in 'sk'", () => {
    expect(isSensitiveContent("see task-management-and-scheduling-service-configuration")).toBe(
      false
    );
    expect(isSensitiveContent("risk-assessment-and-mitigation-planning-for-release-0123")).toBe(
      false
    );
  });

  it("still flags real-looking provider keys in common positions", () => {
    const body = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    expect(isSensitiveContent(`const k = "sk-${body}";`)).toBe(true);
    expect(isSensitiveContent(`OPENAI_API_KEY=sk-${body}`)).toBe(true);
    expect(isSensitiveContent(`Authorization: Bearer sk-proj-${body}`)).toBe(true);
    expect(isSensitiveContent(`sk-${body}`)).toBe(true);
  });
});

describe("drift detection: cheaper scan, same guarantees", () => {
  it("still reports edits, deletions, new files and case-only renames", async () => {
    write("src/c.ts", "export function gamma() { return 3; }\n");
    const meta = registerProject(tmpRoot);
    const index = await indexProject(meta);
    expect(detectStaleIndexEntries(index).isStale).toBe(false);

    write("src/a.ts", "export function alpha() { return 'edited and longer'; }\n");
    fs.rmSync(path.join(tmpRoot, "src/b.ts"));
    write("src/brand-new.ts", "export const NEW = 1;\n");
    fs.renameSync(path.join(tmpRoot, "src/c.ts"), path.join(tmpRoot, "src/C.ts"));

    const drift = detectStaleIndexEntries(index);
    expect(drift.staleFiles).toContain("src/a.ts");
    expect(drift.deletedFiles).toContain("src/b.ts");
    expect(drift.newFiles).toContain("src/brand-new.ts");
    // On a case-insensitive filesystem the old key still stats, so it must be
    // caught by spelling; on a case-sensitive one it simply no longer exists.
    expect(drift.staleFiles.concat(drift.deletedFiles)).toContain("src/c.ts");
    expect(drift.isStale).toBe(true);
  });

  it("does not spend a realpath per tracked file or stat tracked files twice", async () => {
    for (let i = 0; i < 60; i++) write(`src/many/m${i}.ts`, `export const M${i} = ${i};\n`);
    const meta = registerProject(tmpRoot);
    const index = await indexProject(meta);
    const files = Object.keys(index.files).length;
    const realpath = vi.spyOn(fs, "realpathSync");
    const stat = vi.spyOn(fs, "statSync");
    const drift = detectStaleIndexEntries(index);
    expect(drift.isStale).toBe(false);
    // Constant overhead only (root and ignore-file resolution), not one per file.
    expect(realpath.mock.calls.length).toBeLessThan(files / 4);
    // One stat per tracked file; the untracked walk does not stat tracked files again.
    expect(stat.mock.calls.length).toBeLessThanOrEqual(files + 8);
  });

  it("never reports a link that leaves the project as new (no perpetual refresh)", async (ctx) => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-fresh-outside-"));
    try {
      fs.writeFileSync(path.join(outsideDir, "leak.ts"), "export const LEAK = 1;\n");
      try {
        fs.symlinkSync(outsideDir, path.join(tmpRoot, "src", "escape"), "junction");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return ctx.skip();
        throw err;
      }
      const index = await indexProject(registerProject(tmpRoot));
      expect(Object.keys(index.files).some((p) => p.includes("leak.ts"))).toBe(false);
      const drift = detectStaleIndexEntries(index);
      expect(drift.newFiles).toEqual([]);
      expect(drift.isStale).toBe(false);
      expect(getGraphFreshness(index)).toBe("fresh");
    } finally {
      fs.rmSync(path.join(tmpRoot, "src", "escape"), { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("settles to fresh when a directory link points at another directory inside the project", async (ctx) => {
    write("src/real/inner.ts", "export const INNER = 1;\n");
    try {
      fs.symlinkSync(
        path.join(tmpRoot, "src", "real"),
        path.join(tmpRoot, "src", "zz-alias"),
        "junction"
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return ctx.skip();
      throw err;
    }
    try {
      const meta = registerProject(tmpRoot);
      const first = await indexProject(meta);
      const drift = detectStaleIndexEntries(first);
      expect(drift.newFiles).toEqual([]);
      expect(drift.isStale).toBe(false);
    } finally {
      fs.rmSync(path.join(tmpRoot, "src", "zz-alias"), { recursive: true, force: true });
    }
  });
});
