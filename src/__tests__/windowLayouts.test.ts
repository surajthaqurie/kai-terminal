// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  EXTRA_WINDOWS_KEY,
  MAX_SAVED_WINDOWS,
  clearPreviousWindows,
  forgetWindowLayout,
  isRestoreSeed,
  isTerminalWindowLabel,
  previousWindows,
  restoreSeedOf,
  saveWindowLayout,
} from "../services/windowLayouts";
import { createDefaultTab } from "../services/tabFactory";

/** FUNC-07: the layouts of terminal windows other than `main`. */
const tab = (title: string, cwd?: string) => createDefaultTab(title, undefined, cwd);
const stored = () => JSON.parse(localStorage.getItem(EXTRA_WINDOWS_KEY) ?? "null");

beforeEach(() => localStorage.clear());

describe("windowLayouts", () => {
  it("knows the terminal window labels (as the backend does)", () => {
    expect(isTerminalWindowLabel("main")).toBe(true);
    expect(isTerminalWindowLabel("term-12")).toBe(true);
    expect(isTerminalWindowLabel("term-")).toBe(false);
    expect(isTerminalWindowLabel("music-pip")).toBe(false);
  });

  it("saves a window's tabs under its label, with the tab in front", () => {
    const tabs = [tab("api", "/work/api"), tab("web")];
    saveWindowLayout("term-2", tabs, tabs[1].id, localStorage, 1000);
    const entry = stored()["term-2"];
    expect(entry.tabs.map((t: { title: string }) => t.title)).toEqual(["api", "web"]);
    expect(entry.tabs[0].cwd).toBe("/work/api");
    expect(entry.activeIndex).toBe(1);
    expect(entry.savedAt).toBe(1000);
  });

  it("never saves the main window here (it has its own key) or a non-terminal window", () => {
    saveWindowLayout("main", [tab("a")], undefined, localStorage);
    saveWindowLayout("music-pip", [tab("a")], undefined, localStorage);
    expect(stored()).toBeNull();
  });

  it("forgets a window that was closed on purpose, and removes the key when none is left", () => {
    saveWindowLayout("term-2", [tab("a")], undefined, localStorage);
    saveWindowLayout("term-3", [tab("b")], undefined, localStorage);
    forgetWindowLayout("term-2", localStorage);
    expect(Object.keys(stored())).toEqual(["term-3"]);
    forgetWindowLayout("term-3", localStorage);
    expect(localStorage.getItem(EXTRA_WINDOWS_KEY)).toBeNull();
  });

  it("previous windows are the saved ones no live window has, newest first", () => {
    saveWindowLayout("term-2", [tab("old")], undefined, localStorage, 100);
    saveWindowLayout("term-3", [tab("new")], undefined, localStorage, 300);
    saveWindowLayout("term-4", [tab("live")], undefined, localStorage, 200);
    const prev = previousWindows(["main", "term-4"], localStorage);
    expect(prev.map((w) => w.label)).toEqual(["term-3", "term-2"]);
  });

  it(`offers at most ${MAX_SAVED_WINDOWS} windows`, () => {
    for (let i = 2; i < MAX_SAVED_WINDOWS + 6; i++)
      saveWindowLayout(`term-${i}`, [tab(`t${i}`)], undefined, localStorage, i);
    expect(previousWindows(["main"], localStorage)).toHaveLength(MAX_SAVED_WINDOWS);
  });

  it("clears only entries saved before the launch (a reused label of this run survives)", () => {
    saveWindowLayout("term-2", [tab("previous")], undefined, localStorage, 100);
    saveWindowLayout("term-3", [tab("this run")], undefined, localStorage, 900);
    clearPreviousWindows(["term-2", "term-3"], 500, localStorage);
    expect(Object.keys(stored())).toEqual(["term-3"]);
  });

  it("drops malformed entries instead of failing", () => {
    localStorage.setItem(
      EXTRA_WINDOWS_KEY,
      JSON.stringify({
        "term-2": { tabs: [{ title: "ok" }], activeIndex: 7, savedAt: "x" },
        "term-3": { tabs: "nope" },
        "not-a-window": { tabs: [{ title: "x" }] },
        main: { tabs: [{ title: "x" }] },
      })
    );
    const prev = previousWindows(["main"], localStorage);
    expect(prev).toHaveLength(1);
    expect(prev[0]).toMatchObject({ label: "term-2", activeIndex: null, savedAt: 0 });
    localStorage.setItem(EXTRA_WINDOWS_KEY, "{not json");
    expect(previousWindows(["main"], localStorage)).toEqual([]);
  });

  it("a restore seed carries the tabs and the tab in front, and is told apart from a tab seed", () => {
    saveWindowLayout("term-2", [tab("a"), tab("b")], undefined, localStorage, 1);
    const [w] = previousWindows(["main"], localStorage);
    const seed = restoreSeedOf(w);
    expect(isRestoreSeed(seed)).toBe(true);
    expect(seed.restore.tabs.map((t) => t.title)).toEqual(["a", "b"]);
    expect(isRestoreSeed({ title: "moved tab", panes: [] })).toBe(false);
    expect(isRestoreSeed(null)).toBe(false);
  });
});
