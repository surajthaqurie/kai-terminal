import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { synchronizeGraphAfterChanges } from "../core/codeModeWorkflow";
import { indexProject } from "../core/indexer";
import {
  atomicWriteJson,
  getProjectIndexPath,
  getProjectLockPath,
  getProjectMeta,
  getProjectMetaPath,
  getProjectStorageDir,
  isProjectLockHeld,
  loadProjectIndex,
  markProjectGraphStatus,
  ProjectLock,
  registerProject,
} from "../core/registry";

let kaiHome: string;
let project: string;
let savedKaiHome: string | undefined;

beforeEach(() => {
  savedKaiHome = process.env.KAI_HOME;
  kaiHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-lock-home-"));
  project = fs.mkdtempSync(path.join(os.tmpdir(), "kai-lock-proj-"));
  fs.writeFileSync(path.join(project, "a.ts"), "export function alpha() { return 1; }\n");
  process.env.KAI_HOME = kaiHome;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (savedKaiHome === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = savedKaiHome;
  fs.rmSync(kaiHome, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

/** Another holder's lock file: `pid` alive or dead, last refreshed `ageMs` ago. */
function writeForeignLock(id: string, body: string, ageMs = 0): string {
  const lockPath = getProjectLockPath(id);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, body);
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, when, when);
  return lockPath;
}

const liveHolder = (token = "someone-else") => JSON.stringify({ pid: process.pid, token, time: 0 });

/** A pid that certainly belongs to no running process. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid;
}

describe("ProjectLock acquisition", () => {
  it("treats an empty or half-written lock as a holder mid-write, not a corpse", () => {
    const meta = registerProject(project);
    for (const partial of ["", '{"pid":', "not json"]) {
      const lockPath = writeForeignLock(meta.id, partial);
      const second = new ProjectLock(meta.id);

      expect(second.acquire(300), JSON.stringify(partial)).toBe(false);
      // Not deleted out from under the process that is about to finish writing it.
      expect(fs.readFileSync(lockPath, "utf-8")).toBe(partial);
      fs.rmSync(lockPath);
    }
  });

  it("reclaims an unreadable lock once it is clearly abandoned", () => {
    const meta = registerProject(project);
    writeForeignLock(meta.id, "", 10_000);
    const lock = new ProjectLock(meta.id);

    expect(lock.acquire(1000)).toBe(true);
    lock.release();
  });

  it("writes pid and token before anyone can see the lock", () => {
    const meta = registerProject(project);
    const lock = new ProjectLock(meta.id);
    expect(lock.acquire(1000)).toBe(true);

    const content = JSON.parse(fs.readFileSync(getProjectLockPath(meta.id), "utf-8"));
    expect(content.pid).toBe(process.pid);
    expect(typeof content.token).toBe("string");
    expect(content.token.length).toBeGreaterThan(8);
    lock.release();
    expect(fs.existsSync(getProjectLockPath(meta.id))).toBe(false);
  });

  it("keeps the lock of a live holder, however old, until it goes quiet for minutes", () => {
    const meta = registerProject(project);
    const lockPath = writeForeignLock(meta.id, liveHolder(), 60_000);

    // A live process that refreshed it a minute ago is a slow build, not a corpse.
    expect(new ProjectLock(meta.id).acquire(200)).toBe(false);
    expect(isProjectLockHeld(meta.id)).toBe(true);

    // Silent for far longer than any heartbeat gap: hung, or its pid was recycled.
    fs.utimesSync(lockPath, new Date(Date.now() - 300_000), new Date(Date.now() - 300_000));
    expect(isProjectLockHeld(meta.id)).toBe(false);
    const lock = new ProjectLock(meta.id);
    expect(lock.acquire(1000)).toBe(true);
    lock.release();
  });

  it("reclaims the lock of a dead process at once, even a fresh one", () => {
    const meta = registerProject(project);
    writeForeignLock(meta.id, JSON.stringify({ pid: deadPid(), token: "gone", time: Date.now() }));
    expect(isProjectLockHeld(meta.id)).toBe(false);

    const lock = new ProjectLock(meta.id);
    expect(lock.acquire(1000)).toBe(true);
    lock.release();
  });
});

describe("ProjectLock ownership", () => {
  it("release leaves a lock alone once another holder owns it", () => {
    const meta = registerProject(project);
    const first = new ProjectLock(meta.id);
    expect(first.acquire(1000)).toBe(true);

    // The lock was reclaimed (e.g. judged hung) and a second holder took over.
    const successor = liveHolder("successor");
    const lockPath = writeForeignLock(meta.id, successor);

    expect(first.isHeld()).toBe(false);
    first.release();
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(successor);
  });

  it("release is idempotent and never deletes a lock it did not take", () => {
    const meta = registerProject(project);
    const never = new ProjectLock(meta.id);
    const lockPath = writeForeignLock(meta.id, liveHolder());
    never.release();
    expect(fs.existsSync(lockPath)).toBe(true);

    fs.rmSync(lockPath);
    const lock = new ProjectLock(meta.id);
    expect(lock.acquire(1000)).toBe(true);
    lock.release();
    lock.release();
  });

  it("touch refreshes a long holder's lock and reports when it was lost", () => {
    const meta = registerProject(project);
    const lock = new ProjectLock(meta.id);
    expect(lock.acquire(1000)).toBe(true);
    const lockPath = getProjectLockPath(meta.id);
    const old = new Date(Date.now() - 100_000);
    fs.utimesSync(lockPath, old, old);
    const before = fs.statSync(lockPath).mtimeMs;

    // touch is rate limited; jump the clock past its interval.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10_000);
    expect(lock.touch()).toBe(true);
    const after = fs.statSync(lockPath).mtimeMs;
    expect(after).toBeGreaterThan(before + 50_000);
    vi.useRealTimers();

    // Taken over by someone else: touch must say so and must not refresh theirs.
    writeForeignLock(meta.id, liveHolder("successor"), 20_000);
    const theirs = fs.statSync(lockPath).mtimeMs;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 20_000);
    expect(lock.touch()).toBe(false);
    vi.useRealTimers();
    expect(fs.statSync(lockPath).mtimeMs).toBe(theirs);
  });
});

describe("markProjectGraphStatus takes the project lock", () => {
  async function indexed() {
    const meta = registerProject(project);
    await indexProject(meta);
    return meta;
  }

  it("does not rewrite index.json while another live process holds the lock", async () => {
    const meta = await indexed();
    const indexPath = getProjectIndexPath(meta.id);
    const before = fs.readFileSync(indexPath, "utf-8");
    writeForeignLock(meta.id, liveHolder());

    expect(markProjectGraphStatus(meta.id, "stale", "changed")).toBe(false);

    expect(fs.readFileSync(indexPath, "utf-8")).toBe(before);
    expect(getProjectMeta(project)?.status).toBe("ready");
  });

  it("marks both metadata copies once the lock is free, and releases it again", async () => {
    const meta = await indexed();

    expect(markProjectGraphStatus(meta.id, "stale", "changed")).toBe(true);

    expect(getProjectMeta(project)?.status).toBe("stale");
    expect(loadProjectIndex(meta.id)?.meta.status).toBe("stale");
    expect(fs.existsSync(getProjectLockPath(meta.id))).toBe(false);
  });

  it("does not re-lock for a caller that already holds the lock", async () => {
    const meta = await indexed();
    const mine = new ProjectLock(meta.id);
    expect(mine.acquire(1000)).toBe(true);
    try {
      expect(markProjectGraphStatus(meta.id, "failed", "boom", { lockHeld: true })).toBe(true);
      expect(loadProjectIndex(meta.id)?.meta.status).toBe("failed");
      // And still held by the caller afterwards.
      expect(mine.isHeld()).toBe(true);
    } finally {
      mine.release();
    }
  });

  it("does not resurrect the storage directory of a deleted project", async () => {
    const meta = await indexed();
    fs.rmSync(getProjectStorageDir(meta.id), { recursive: true, force: true });

    expect(markProjectGraphStatus(meta.id, "stale")).toBe(false);

    expect(fs.existsSync(getProjectStorageDir(meta.id))).toBe(false);
  });
});

describe("registerProject while another process is indexing", () => {
  function markIndexing(id: string): void {
    const meta = JSON.parse(fs.readFileSync(getProjectMetaPath(id), "utf-8"));
    atomicWriteJson(getProjectMetaPath(id), { ...meta, status: "indexing" });
  }

  it("leaves 'indexing' alone while a live process holds the lock", () => {
    const first = registerProject(project);
    markIndexing(first.id);
    const lockPath = writeForeignLock(first.id, liveHolder());

    expect(registerProject(project).status).toBe("indexing");
    expect(getProjectMeta(project)?.status).toBe("indexing");

    // The holder finishes without publishing (or dies): the next look recovers.
    fs.rmSync(lockPath);
    expect(registerProject(project).status).toBe("unindexed");
  });

  it("resets 'indexing' when the lock belongs to a dead process", () => {
    const first = registerProject(project);
    markIndexing(first.id);
    writeForeignLock(first.id, JSON.stringify({ pid: deadPid(), token: "gone", time: Date.now() }));

    expect(registerProject(project).status).toBe("unindexed");
  });

  it("resets 'indexing' to ready when an index exists and nobody holds the lock", async () => {
    const meta = registerProject(project);
    await indexProject(meta);
    markIndexing(meta.id);

    expect(registerProject(project).status).toBe("ready");
  });
});

describe("indexProject lock hygiene", () => {
  it("releases the lock after a build", async () => {
    const meta = registerProject(project);
    await indexProject(meta);
    expect(fs.existsSync(getProjectLockPath(meta.id))).toBe(false);
  });

  it("refuses to publish when its lock was lost mid-build", async () => {
    const meta = registerProject(project);
    vi.spyOn(ProjectLock.prototype, "isHeld").mockReturnValue(false);

    await expect(indexProject(meta)).rejects.toThrow(/lock .* was lost/);

    expect(loadProjectIndex(meta.id)).toBeNull();
    expect(getProjectMeta(project)?.status).toBe("failed");
    expect(fs.existsSync(getProjectLockPath(meta.id))).toBe(false);
  });
});

describe("graph sync publishes under the project lock", () => {
  it("does not overwrite the index when the lock cannot be taken for the publish step", async () => {
    const meta = registerProject(project);
    await indexProject(meta);
    const indexPath = getProjectIndexPath(meta.id);
    const before = fs.readFileSync(indexPath, "utf-8");
    fs.writeFileSync(path.join(project, "b.ts"), "export const b = 2;\n");

    // The dry-run build (first acquire) gets the lock; by the time the result is
    // published (second acquire) another process holds it.
    const real = ProjectLock.prototype.acquire;
    let calls = 0;
    vi.spyOn(ProjectLock.prototype, "acquire").mockImplementation(function (
      this: ProjectLock,
      timeoutMs?: number
    ) {
      calls++;
      return calls === 1 ? real.call(this, timeoutMs) : false;
    });

    const report = await synchronizeGraphAfterChanges(meta, ["b.ts"], {
      ran: true,
      passed: true,
      detail: "vitest",
    });

    expect(report.graphResult).toBe("failed");
    expect(report.message).toContain("Could not acquire index lock");
    expect(fs.readFileSync(indexPath, "utf-8")).toBe(before);
  });

  it("publishes and releases the lock when it is free", async () => {
    const meta = registerProject(project);
    await indexProject(meta);
    fs.writeFileSync(path.join(project, "b.ts"), "export const b = 2;\n");

    const report = await synchronizeGraphAfterChanges(meta, ["b.ts"], {
      ran: true,
      passed: true,
      detail: "vitest",
    });

    expect(report.graphResult).toBe("synced");
    expect(Object.keys(loadProjectIndex(meta.id)!.files)).toContain("b.ts");
    expect(fs.existsSync(getProjectLockPath(meta.id))).toBe(false);
  });
});
