// @vitest-environment jsdom
import { act, createElement, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GIT_BADGE_MIN_INTERVAL_MS,
  createCwdSettler,
  lineMayChangeGitState,
} from "../services/cwdCommand";
import type { TerminalTab } from "../types/terminal";

/**
 * FUNC-04: after `git checkout -b x` / `git commit` in the folder the footer kept the old
 * branch. Every report of the (unchanged) folder was swallowed by the settler, and a refresh that
 * only asked the 30 s cache could never see the change.
 */
const probes = { calls: 0, invalidations: 0 };
vi.mock("../services/projectService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/projectService")>();
  return {
    ...actual,
    getGitInfoCached: vi.fn(async () => {
      probes.calls += 1;
      return { branch: "main", dirty: false };
    }),
    invalidateGitCache: vi.fn(() => {
      probes.invalidations += 1;
    }),
    recordRecentProject: vi.fn(),
  };
});

import { usePaneCwd } from "../hooks/usePaneCwd";

const DIR = "/work/repo";
const tab = (): TerminalTab =>
  ({
    id: "t1",
    title: "Terminal",
    status: "connected",
    cwd: DIR,
    activePaneId: "p1",
    splitDirection: "horizontal",
    panes: [{ id: "p1", cwd: DIR }],
  }) as unknown as TerminalTab;

let report: (tabId: string, paneId: string, cwd: string) => void;
let root: Root;
let host: HTMLElement;

function Harness() {
  const tabsRef = { current: [tab()] } as RefObject<TerminalTab[]>;
  const activeTabIdRef = { current: "t1" } as RefObject<string>;
  report = usePaneCwd({ tabsRef, activeTabIdRef, setTabs: vi.fn(), applyGitInfo: vi.fn() });
  return null;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  probes.calls = 0;
  probes.invalidations = 0;
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

describe("a report of the unchanged folder refreshes the git badge", () => {
  it("re-reads git (not the cache) when the shell reports in again", async () => {
    await act(async () => report("t1", "p1", DIR));
    expect(probes.invalidations).toBe(1);
    expect(probes.calls).toBe(1);
  });

  it("at most once per interval, however many reports arrive", async () => {
    for (let i = 0; i < 20; i++) await act(async () => report("t1", "p1", DIR));
    expect(probes.invalidations).toBe(1);

    vi.setSystemTime(1_000_000 + GIT_BADGE_MIN_INTERVAL_MS + 1);
    await act(async () => report("t1", "p1", DIR));
    expect(probes.invalidations).toBe(2);
  });
});

describe("the settler tells the app about unchanged reports", () => {
  it("calls onUnchanged for the folder already shown, not for the first report or a change", () => {
    const unchanged: string[] = [];
    const delivered: string[] = [];
    const s = createCwdSettler((p) => delivered.push(p), {
      onUnchanged: (p) => unchanged.push(p),
      settleMs: 10,
    });
    s.push("/a");
    expect(unchanged).toEqual([]); // first report is a delivery
    s.push("/a");
    s.push("/a/");
    expect(unchanged).toHaveLength(2);
    expect(delivered).toEqual(["/a"]);
    s.dispose();
  });
});

describe("lineMayChangeGitState", () => {
  it("is true for git (and friends) at the start of any command in the line", () => {
    for (const line of [
      "git checkout -b x",
      "  git commit -m 'm'",
      "cd src && git pull",
      "npm test; git switch main",
      "GIT status",
      "git.exe stash",
      "lazygit",
    ]) {
      expect(lineMayChangeGitState(line), line).toBe(true);
    }
  });

  it("is false for other commands, including ones that merely mention git", () => {
    for (const line of ["", "ls -la", "echo git", "cd git", "npm run gitlog", "digit 1"]) {
      expect(lineMayChangeGitState(line), line).toBe(false);
    }
  });
});
