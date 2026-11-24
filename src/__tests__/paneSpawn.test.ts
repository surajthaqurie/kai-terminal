import { describe, expect, it, vi } from "vitest";
import {
  replayHandoff,
  requestedFolder,
  spawnPaneShell,
  type PaneSpawnRequest,
} from "../services/paneSpawn";
import type { PtySessionInfo } from "../types/terminal";
import type { HandoffRelease } from "../services/terminalWindows";

const FOLDER_GONE = "Invalid working directory: Working directory '/gone' does not exist";
const info = (id: string, cwd = "/"): PtySessionInfo => ({
  id,
  shell_path: "sh",
  cwd,
  cols: 80,
  rows: 24,
});

function spawnSetup(create: (req: PaneSpawnRequest) => Promise<PtySessionInfo>) {
  let current = true;
  const createPty = vi.fn(create);
  const closePty = vi.fn(async () => {});
  const notice = vi.fn<(text: string) => void>();
  const run = (extra: { cwd?: string | null } = {}) =>
    spawnPaneShell({
      createPty,
      closePty,
      shellPath: "/bin/zsh",
      args: ["-l"],
      cols: 100,
      rows: 30,
      isCurrent: () => current,
      notice,
      ...extra,
    });
  return { createPty, closePty, notice, run, overtake: () => (current = false) };
}

describe("requestedFolder", () => {
  it("trims, and treats blank as the default folder", () => {
    expect(requestedFolder("  /work  ")).toBe("/work");
    expect(requestedFolder("   ")).toBeUndefined();
    expect(requestedFolder(null)).toBeUndefined();
    expect(requestedFolder(undefined)).toBeUndefined();
  });
});

describe("spawnPaneShell", () => {
  it("starts the shell with the pane's shell, folder and grid", async () => {
    const h = spawnSetup(async () => info("pty-1", "/work"));
    expect(await h.run({ cwd: " /work " })).toEqual(info("pty-1", "/work"));
    expect(h.createPty).toHaveBeenCalledWith({
      shell_path: "/bin/zsh",
      args: ["-l"],
      cwd: "/work",
      cols: 100,
      rows: 30,
    });
    expect(h.notice).not.toHaveBeenCalled();
  });

  it("opens in the default folder when the saved one is gone, and says so", async () => {
    const h = spawnSetup(async (req) => {
      if (req.cwd) throw new Error(FOLDER_GONE);
      return info("pty-home", "/home/me");
    });
    expect((await h.run({ cwd: "/gone" }))?.id).toBe("pty-home");
    expect(h.createPty.mock.calls.map(([r]) => r.cwd)).toEqual(["/gone", undefined]);
    expect(h.notice).toHaveBeenCalledTimes(1);
    expect(h.notice.mock.calls[0][0]).toContain("/gone");
  });

  it("throws other failures for the error overlay, without a second attempt", async () => {
    const h = spawnSetup(async () => {
      throw new Error("shell not found");
    });
    await expect(h.run({ cwd: "/work" })).rejects.toThrow("shell not found");
    expect(h.createPty).toHaveBeenCalledTimes(1);
  });

  it("throws a folder failure when no folder was asked for (nothing to fall back from)", async () => {
    const h = spawnSetup(async () => {
      throw new Error(FOLDER_GONE);
    });
    await expect(h.run()).rejects.toThrow(FOLDER_GONE);
    expect(h.createPty).toHaveBeenCalledTimes(1);
  });

  it("throws when the default folder fails too", async () => {
    const h = spawnSetup(async (req) => {
      throw new Error(req.cwd ? FOLDER_GONE : "no home");
    });
    await expect(h.run({ cwd: "/gone" })).rejects.toThrow("no home");
    expect(h.createPty).toHaveBeenCalledTimes(2);
  });

  it("does not fall back once overtaken (a newer launch owns the pane)", async () => {
    const h = spawnSetup(async () => {
      h.overtake();
      throw new Error(FOLDER_GONE);
    });
    await expect(h.run({ cwd: "/gone" })).rejects.toThrow(FOLDER_GONE);
    expect(h.createPty).toHaveBeenCalledTimes(1);
  });

  it("says so when the backend opened the shell in the parent of a missing folder (FUNC-12)", async () => {
    const h = spawnSetup(async () => info("pty-1", "/work/app"));
    await h.run({ cwd: "/work/app/gone" });
    expect(h.notice).toHaveBeenCalledTimes(1);
    expect(h.notice.mock.calls[0][0]).toContain("/work/app/gone");
  });

  it("closes the shell of a spawn that was overtaken while it started, and returns null", async () => {
    const h = spawnSetup(async () => {
      h.overtake();
      return info("pty-orphan");
    });
    expect(await h.run()).toBeNull();
    expect(h.closePty).toHaveBeenCalledWith("pty-orphan");
  });

  it("returns null even if closing the overtaken shell fails", async () => {
    const h = spawnSetup(async () => {
      h.overtake();
      return info("pty-orphan");
    });
    h.closePty.mockRejectedValueOnce(new Error("already gone"));
    expect(await h.run()).toBeNull();
  });
});

describe("replayHandoff", () => {
  const adoption = { ptyId: "pty-moved", snapshot: "SCREEN", cols: 120, rows: 40 };

  function replaySetup(released: HandoffRelease) {
    const events: string[] = [];
    let current = true;
    const term = {
      resize: vi.fn((c: number, r: number) => events.push(`resize ${c}x${r}`)),
      write: vi.fn((data: string, cb?: () => void) => {
        events.push(`write ${JSON.stringify(data)}`);
        if (cb) queueMicrotask(cb);
      }),
    };
    const finish = vi.fn(async (id: string) => {
      events.push(`finish ${id}`);
      return released;
    });
    const run = () => replayHandoff({ term, adoption, finish, isCurrent: () => current });
    return { events, term, finish, run, overtake: () => (current = false) };
  }

  it("redraws at the snapshot grid, takes the session, then writes what was held", async () => {
    const released = { data: ["held-1", "held-2"], exited: false, exit_code: null };
    const h = replaySetup(released);
    expect(await h.run()).toBe(released);
    expect(h.events).toEqual([
      "resize 120x40",
      'write "SCREEN"',
      "finish pty-moved",
      'write "held-1"',
      'write "held-2"',
      'write ""', // waits until xterm has parsed the held output
    ]);
  });

  it("keeps going when the grid cannot be resized", async () => {
    const h = replaySetup({ data: [], exited: false, exit_code: null });
    h.term.resize.mockImplementation(() => {
      throw new Error("disposed");
    });
    expect(await h.run()).not.toBeNull();
  });

  it("returns null when overtaken during the take-over, without writing held output", async () => {
    const h = replaySetup({ data: ["held"], exited: false, exit_code: null });
    h.finish.mockImplementation(async () => {
      h.overtake();
      return { data: ["held"], exited: false, exit_code: null };
    });
    expect(await h.run()).toBeNull();
    expect(h.events).not.toContain('write "held"');
  });

  it("passes a failed take-over on to the caller", async () => {
    const h = replaySetup({ data: [], exited: false, exit_code: null });
    h.finish.mockRejectedValue(new Error("window gone"));
    await expect(h.run()).rejects.toThrow("window gone");
  });
});
