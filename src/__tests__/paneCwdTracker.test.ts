import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaneCwdTracker } from "../services/paneCwdTracker";
import { CD_PROBE_DELAYS_MS, CWD_SETTLE_MS, GIT_PROBE_DELAYS_MS } from "../services/cwdCommand";

const flush = () => vi.advanceTimersByTimeAsync(0);

function setup(opts: { ptyId?: string | null; backend?: string | null } = {}) {
  let ptyId: string | null = opts.ptyId === undefined ? "pty-1" : opts.ptyId;
  let backend: string | null = opts.backend === undefined ? "/repo" : opts.backend;
  const readCwd = vi.fn(async (_id: string) => backend);
  const deliver = vi.fn<(p: string) => void>();
  const tracker = createPaneCwdTracker({ ptyId: () => ptyId, readCwd, deliver });
  return {
    tracker,
    readCwd,
    deliver,
    delivered: () => deliver.mock.calls.map(([p]) => p),
    setPty: (id: string | null) => (ptyId = id),
    setBackend: (p: string | null) => (backend = p),
  };
}

describe("paneCwdTracker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows the folder a new shell started in at once, replacing what was shown", async () => {
    const h = setup();
    h.tracker.sessionStarted("/a");
    h.tracker.report("/b");
    await vi.advanceTimersByTimeAsync(CWD_SETTLE_MS + 10);
    h.tracker.sessionStarted("/c");
    expect(h.delivered()).toEqual(["/a", "/b", "/c"]);
  });

  it("ignores a spawn reply without a folder", () => {
    const h = setup();
    h.tracker.sessionStarted(undefined);
    h.tracker.sessionStarted("");
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("check reads the backend for the current session and delivers its folder", async () => {
    const h = setup();
    h.tracker.check();
    await flush();
    expect(h.readCwd).toHaveBeenCalledWith("pty-1");
    expect(h.delivered()).toEqual(["/repo"]);
  });

  it("check can name another session (an adopted shell)", async () => {
    const h = setup();
    h.tracker.check("pty-moved");
    await flush();
    expect(h.readCwd).toHaveBeenCalledWith("pty-moved");
  });

  it("does nothing without a session, and survives a failed read", async () => {
    const h = setup({ ptyId: null });
    h.tracker.check();
    h.tracker.poll();
    expect(h.readCwd).not.toHaveBeenCalled();
    h.setPty("pty-1");
    h.readCwd.mockRejectedValueOnce(new Error("session gone"));
    h.tracker.check();
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("a shell re-reporting the same folder is delivered again (git badge refresh)", async () => {
    const h = setup();
    h.tracker.sessionStarted("/repo");
    h.tracker.check();
    await flush();
    expect(h.delivered()).toEqual(["/repo", "/repo"]);
  });

  it("the poll is quiet: an unchanged folder is not delivered again", async () => {
    const h = setup();
    h.tracker.sessionStarted("/repo");
    h.tracker.poll();
    await flush();
    expect(h.delivered()).toEqual(["/repo"]);
    // A real change found by the poll is still delivered.
    h.setBackend("/elsewhere");
    h.tracker.poll();
    await vi.advanceTimersByTimeAsync(CWD_SETTLE_MS + 10);
    expect(h.delivered()).toEqual(["/repo", "/elsewhere"]);
  });

  it("holds a changed folder back while typing; Enter does not count as typing", async () => {
    const h = setup();
    h.tracker.sessionStarted("/a");
    h.tracker.report("/b");
    for (let i = 0; i < 5; i++) {
      h.tracker.keyTyped("x");
      await vi.advanceTimersByTimeAsync(CWD_SETTLE_MS / 2);
    }
    expect(h.delivered()).toEqual(["/a"]);
    h.tracker.keyTyped("\r");
    await vi.advanceTimersByTimeAsync(CWD_SETTLE_MS * 2);
    expect(h.delivered()).toEqual(["/a", "/b"]);
  });

  it("probes at CD_PROBE_DELAYS_MS after a directory-changing line", async () => {
    const h = setup();
    h.tracker.lineSubmitted("cd src\r");
    let elapsed = 0;
    for (const [i, delay] of CD_PROBE_DELAYS_MS.entries()) {
      await vi.advanceTimersByTimeAsync(delay - elapsed - 1);
      expect(h.readCwd).toHaveBeenCalledTimes(i);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.readCwd).toHaveBeenCalledTimes(i + 1);
      elapsed = delay;
    }
  });

  it("probes at GIT_PROBE_DELAYS_MS after a branch-changing line", async () => {
    const h = setup();
    h.tracker.lineSubmitted("git checkout main\r");
    await vi.advanceTimersByTimeAsync(Math.max(...GIT_PROBE_DELAYS_MS));
    expect(h.readCwd).toHaveBeenCalledTimes(GIT_PROBE_DELAYS_MS.length);
  });

  it("probes nothing for other lines or a bare Enter", async () => {
    const h = setup();
    h.tracker.lineSubmitted("ls -la\r");
    h.tracker.lineSubmitted("\r");
    h.tracker.lineSubmitted("");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.readCwd).not.toHaveBeenCalled();
  });

  it("a probe reads the session current when it fires", async () => {
    const h = setup();
    h.tracker.lineSubmitted("cd ..\r");
    h.setPty("pty-2");
    await vi.advanceTimersByTimeAsync(CD_PROBE_DELAYS_MS[0]);
    expect(h.readCwd).toHaveBeenCalledWith("pty-2");
  });

  it("dispose cancels pending probes and a held folder, and the tracker stays usable", async () => {
    const h = setup();
    h.tracker.sessionStarted("/a");
    h.tracker.report("/b"); // held for the settle delay
    h.tracker.lineSubmitted("cd src\r");
    h.tracker.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.readCwd).not.toHaveBeenCalled();
    expect(h.delivered()).toEqual(["/a"]);
    // Remount (StrictMode / session switch) with the same tracker.
    h.tracker.sessionStarted("/c");
    expect(h.delivered()).toEqual(["/a", "/c"]);
  });
});
