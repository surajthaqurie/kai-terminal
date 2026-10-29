import { describe, expect, it, vi } from "vitest";
import { buildCommandActions, type CommandActionContext } from "../components/commandActions";
import { DEFAULT_KEYBINDINGS } from "../services/settingsService";
import {
  FIXED_SHORTCUT_HELP,
  REVIEW_CHANGES_BINDING,
  RESERVED_SHORTCUTS,
  findReservedConflicts,
  matchShortcut,
} from "../services/shortcuts";

describe("reserved shortcuts", () => {
  it("the defaults use no reserved combo for the wrong action", () => {
    expect(findReservedConflicts(DEFAULT_KEYBINDINGS)).toEqual([]);
  });

  it("rejects a binding on the review-changes combo, which the app handles first", () => {
    const found = findReservedConflicts({ ...DEFAULT_KEYBINDINGS, search: "Ctrl+Shift+G" });
    expect(found).toEqual([
      { action: "search", binding: "Ctrl+Shift+G", reservedFor: "Review git changes" },
    ]);
  });

  it("treats Cmd and Ctrl alike, like the matcher does", () => {
    expect(
      findReservedConflicts({ ...DEFAULT_KEYBINDINGS, settings: "Cmd+Shift+G" }).map(
        (c) => c.action
      )
    ).toEqual(["settings"]);
  });

  it("rejects Ctrl+T for anything but New tab, since the universal new-tab accelerator wins", () => {
    expect(
      findReservedConflicts({ ...DEFAULT_KEYBINDINGS, toggleMusic: "Ctrl+T" }).map((c) => c.action)
    ).toEqual(["toggleMusic"]);
    // New tab itself may keep either spelling.
    expect(findReservedConflicts({ ...DEFAULT_KEYBINDINGS, newTab: "Ctrl+T" })).toEqual([]);
    expect(findReservedConflicts({ ...DEFAULT_KEYBINDINGS, newTab: "Ctrl+Shift+T" })).toEqual([]);
  });

  it("does not flag near misses", () => {
    expect(findReservedConflicts({ ...DEFAULT_KEYBINDINGS, search: "Ctrl+Alt+G" })).toEqual([]);
    expect(findReservedConflicts({ ...DEFAULT_KEYBINDINGS, search: "Ctrl+G" })).toEqual([]);
  });

  it("lists every reserved combo among the fixed shortcuts shown in Settings", () => {
    const keys = FIXED_SHORTCUT_HELP.map((r) => r.keys).join(" | ");
    expect(keys).toContain(REVIEW_CHANGES_BINDING);
    expect(keys).toContain("Ctrl+T");
    expect(RESERVED_SHORTCUTS.length).toBeGreaterThan(0);
  });

  it("matchShortcut still resolves the first matching action", () => {
    const e = {
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
      code: "KeyP",
    } as KeyboardEvent;
    expect(matchShortcut(e, DEFAULT_KEYBINDINGS)).toBe("commandPalette");
  });
});

describe("command palette", () => {
  const noop = vi.fn();
  const ctx = (isMac: boolean): CommandActionContext => ({
    keybindings: DEFAULT_KEYBINDINGS,
    isMac,
    newTab: noop,
    cycleTab: noop,
    focusNextPane: noop,
    openWorkspaces: noop,
    splitPane: noop,
    closeActivePane: noop,
    toggleMusic: noop,
    renameActiveTab: noop,
    openEditor: noop,
    showGitStatus: noop,
    reviewChanges: noop,
    checkUpdates: noop,
    closeActiveTab: noop,
    toggleSearch: noop,
    clearTerminal: noop,
    openAiCli: noop,
    openDiagnostics: noop,
    openSettings: noop,
  });

  it("no longer offers the manual ghost-typing reset", () => {
    const labels = buildCommandActions(ctx(false)).map((a) => `${a.id} ${a.label}`.toLowerCase());
    expect(labels.some((l) => l.includes("ghost") || l.includes("reset-terminal-modes"))).toBe(
      false
    );
  });

  it("has unique ids", () => {
    const ids = buildCommandActions(ctx(false)).map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows the review-changes shortcut with the platform's modifier", () => {
    const find = (isMac: boolean) =>
      buildCommandActions(ctx(isMac)).find((a) => a.id === "review-changes")!.shortcut;
    expect(find(false)).toBe("Ctrl+Shift+G");
    expect(find(true)).toBe("Cmd+Shift+G");
  });
});
