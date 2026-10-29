import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  lineLikelyChangesCwd,
  CD_PROBE_DELAYS_MS,
  CWD_SETTLE_MS,
  createCwdSettler,
} from "../services/cwdCommand";

describe("lineLikelyChangesCwd", () => {
  it("returns false for plain commands and bare Enter", () => {
    expect(lineLikelyChangesCwd("")).toBe(false);
    expect(lineLikelyChangesCwd("   ")).toBe(false);
    expect(lineLikelyChangesCwd("ls -la")).toBe(false);
    expect(lineLikelyChangesCwd("git status")).toBe(false);
    expect(lineLikelyChangesCwd("echo cd")).toBe(false);
    expect(lineLikelyChangesCwd("npm run build")).toBe(false);
    expect(lineLikelyChangesCwd("my-cd-tool")).toBe(false);
    expect(lineLikelyChangesCwd("cdrom")).toBe(false);
    // sudo cannot change our shell's cwd: no probe.
    expect(lineLikelyChangesCwd("sudo cd /root")).toBe(false);
  });

  it("detects posix directory changes", () => {
    expect(lineLikelyChangesCwd("cd /tmp")).toBe(true);
    expect(lineLikelyChangesCwd("  cd")).toBe(true);
    expect(lineLikelyChangesCwd("pushd /x")).toBe(true);
    expect(lineLikelyChangesCwd("popd")).toBe(true);
    expect(lineLikelyChangesCwd("z proj")).toBe(true);
    expect(lineLikelyChangesCwd("j foo")).toBe(true);
    expect(lineLikelyChangesCwd("..")).toBe(true);
    expect(lineLikelyChangesCwd("make && cd out")).toBe(true);
    expect(lineLikelyChangesCwd("npm test; cd ..")).toBe(true);
  });

  it("detects cmd.exe and PowerShell directory changes", () => {
    expect(lineLikelyChangesCwd("cd..")).toBe(true);
    expect(lineLikelyChangesCwd("cd\\")).toBe(true);
    expect(lineLikelyChangesCwd("CD /d C:\\work")).toBe(true);
    expect(lineLikelyChangesCwd("chdir D:\\repo")).toBe(true);
    expect(lineLikelyChangesCwd("sl C:\\x")).toBe(true);
    expect(lineLikelyChangesCwd("Set-Location ~")).toBe(true);
    expect(lineLikelyChangesCwd("c:")).toBe(true);
  });
});

describe("CD_PROBE_DELAYS_MS", () => {
  it("spaces probes outside the backend 2s throttle window", () => {
    // Load-bearing: the backend answers at most one live-OS cwd probe per
    // 2 s per session — probes inside the same window return the cached
    // (pre-cd) directory and the footer looks stuck until the next action.
    expect(CD_PROBE_DELAYS_MS.length).toBeGreaterThanOrEqual(2);
    const sorted = [...CD_PROBE_DELAYS_MS].sort((a, b) => a - b);
    expect([...CD_PROBE_DELAYS_MS]).toEqual(sorted);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThan(2000);
    }
  });

  it("starts promptly and finishes within a few seconds", () => {
    const sorted = [...CD_PROBE_DELAYS_MS].sort((a, b) => a - b);
    expect(sorted[0]).toBeLessThanOrEqual(500);
    expect(sorted[sorted.length - 1]).toBeLessThanOrEqual(6000);
  });
});

describe("createCwdSettler (footer path only updates once cd settles)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("delivers the first directory immediately", () => {
    const seen: string[] = [];
    const s = createCwdSettler((p) => seen.push(p));
    s.push("C:\\proj");
    expect(seen).toEqual(["C:\\proj"]);
  });

  it("holds a changed directory until the settle window passes", () => {
    const seen: string[] = [];
    const s = createCwdSettler((p) => seen.push(p));
    s.push("/a");
    s.push("/a/b/c");
    vi.advanceTimersByTime(CWD_SETTLE_MS - 1);
    expect(seen).toEqual(["/a"]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["/a", "/a/b/c"]);
  });

  it("shows only the final directory after fast hopping", () => {
    const seen: string[] = [];
    const s = createCwdSettler((p) => seen.push(p));
    s.push("/a");
    s.push("/a/b");
    vi.advanceTimersByTime(CWD_SETTLE_MS / 2);
    s.push("/a/b/c");
    vi.advanceTimersByTime(CWD_SETTLE_MS);
    expect(seen).toEqual(["/a", "/a/b/c"]);
  });

  it("does not restart the timer when another source repeats the same candidate", () => {
    const seen: string[] = [];
    const s = createCwdSettler((p) => seen.push(p));
    s.push("/a");
    s.push("/b");
    vi.advanceTimersByTime(CWD_SETTLE_MS - 100);
    s.push("/b/"); // same dir, different source/textual form
    vi.advanceTimersByTime(100);
    expect(seen).toEqual(["/a", "/b"]);
  });

  it("cancels a held change when the directory returns to the shown one", () => {
    const seen: string[] = [];
    const s = createCwdSettler((p) => seen.push(p));
    s.push("C:\\x");
    s.push("C:\\x\\y");
    s.push("c:/x/"); // textual twin of the shown dir
    vi.advanceTimersByTime(CWD_SETTLE_MS * 3);
    expect(seen).toEqual(["C:\\x"]);
  });

  it("keeps holding while the user is typing", () => {
    const seen: string[] = [];
    let typing = true;
    const s = createCwdSettler((p) => seen.push(p), { isTyping: () => typing });
    s.push("/a");
    s.push("/b");
    vi.advanceTimersByTime(CWD_SETTLE_MS * 3);
    expect(seen).toEqual(["/a"]);
    typing = false;
    vi.advanceTimersByTime(CWD_SETTLE_MS);
    expect(seen).toEqual(["/a", "/b"]);
  });

  it("ignores empty paths and reset() makes the next push immediate", () => {
    const seen: string[] = [];
    const s = createCwdSettler((p) => seen.push(p));
    s.push("");
    s.push("   ");
    expect(seen).toEqual([]);
    s.push("/a");
    s.reset();
    s.push("/z");
    expect(seen).toEqual(["/a", "/z"]);
  });

  it("dispose drops the held change", () => {
    const seen: string[] = [];
    const s = createCwdSettler((p) => seen.push(p));
    s.push("/a");
    s.push("/b");
    s.dispose();
    vi.advanceTimersByTime(CWD_SETTLE_MS * 2);
    expect(seen).toEqual(["/a"]);
  });
});
