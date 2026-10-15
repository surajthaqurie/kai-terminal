// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  WORKSPACES_KEY,
  LEGACY_WORKSPACES_KEY,
  LEGACY_LAYOUT_KEY,
  createWorkspace,
  loadWorkspaces,
  loadOrMigrateWorkspaces,
  migrateLegacyLayout,
  sanitizeLayout,
  sanitizeTab,
  sanitizeWorkspace,
  sanitizeWorkspaceForRestore,
  saveWorkspaces,
  validateWorkspaceDir,
} from "../services/workspaces";
import { resolveTabLayout, MAX_PANES_PER_TAB } from "../services/paneLayout";
import { SettingsService, DEFAULT_SETTINGS } from "../services/settingsService";
import {
  findConflicts,
  parseBinding,
  platformLabel,
  eventMatchesBinding,
} from "../services/shortcuts";

beforeEach(() => {
  localStorage.clear();
});

describe("workspace restore hardening regressions", () => {
  it("recovers from corrupted new-key storage (not just legacy keys)", () => {
    localStorage.setItem(WORKSPACES_KEY, "{not json");
    expect(loadWorkspaces()).toEqual([]);
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify({ version: 2, workspaces: "nope" }));
    expect(loadWorkspaces()).toEqual([]);
    localStorage.setItem(LEGACY_WORKSPACES_KEY, "{not json");
    expect(loadWorkspaces()).toEqual([]);
  });

  it("preserves the legacy v1 layout migration", () => {
    const legacy = [
      { title: "API", shellPath: "/bin/bash", cwd: "/tmp" },
      { title: "Web", cwd: "/tmp" },
    ];
    const ws = migrateLegacyLayout(legacy);
    expect(ws).not.toBeNull();
    expect(ws!.tabs).toHaveLength(2);
    localStorage.setItem(LEGACY_LAYOUT_KEY, JSON.stringify(legacy));
    const loaded = loadOrMigrateWorkspaces();
    expect(loaded.length).toBeGreaterThanOrEqual(1);
    expect(loaded[0].tabs).toHaveLength(2);
  });

  it("never persists scrollback, history, credentials, or env secrets", () => {
    const ws = createWorkspace("P", [{ title: "T", cwd: "/tmp" }]);
    saveWorkspaces([ws]);
    const raw = localStorage.getItem(WORKSPACES_KEY) || "";
    for (const needle of [
      "scrollback",
      "history",
      "password",
      "secret",
      "token",
      "api_key",
      "env",
      "credential",
    ]) {
      expect(raw.toLowerCase()).not.toContain(needle);
    }
    // A hostile doc smuggling secrets is sanitized away on load.
    const hostile = {
      id: "x",
      name: "N",
      tabs: [
        { title: "T", cwd: "/tmp", scrollback: ["rm -rf"], history: ["secret"], env: { K: "v" } },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const clean = sanitizeWorkspace(hostile);
    expect(JSON.stringify(clean)).not.toContain("scrollback");
    expect(JSON.stringify(clean)).not.toContain("secret");
  });

  it("validates project paths at restore time (drops bad cwd, keeps tab)", () => {
    expect(validateWorkspaceDir("")).not.toBeNull();
    expect(validateWorkspaceDir("bad\0dir")).not.toBeNull();
    const ws = sanitizeWorkspace({
      id: "w",
      name: "W",
      tabs: [
        { title: "Good", cwd: "/tmp" },
        { title: "Bad", cwd: "bad\0dir" },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })!;
    const safe = sanitizeWorkspaceForRestore(ws);
    expect(safe.tabs).toHaveLength(2);
    expect(safe.tabs[0].cwd).toBe("/tmp");
    expect(safe.tabs[1].cwd).toBeUndefined();
  });

  it("rejects duplicate pane refs so one pane never renders twice", () => {
    // Persisted tree referencing pane 0 twice over a 2-pane tab.
    const dup = sanitizeLayout(
      {
        kind: "split",
        direction: "vertical",
        ratio: 0.5,
        first: { kind: "pane", paneIndex: 0 },
        second: { kind: "pane", paneIndex: 0 },
      },
      2
    );
    expect(dup).toBeDefined();
    const repaired = resolveTabLayout(["a", "b"], dup as never, "vertical");
    // Must fall back to an even tiling covering both live panes exactly once.
    const ids = repaired
      ? (function collect(n: never): string[] {
          const node = n as unknown as {
            kind: string;
            paneId?: string;
            first?: never;
            second?: never;
          };
          if (node.kind === "pane") return [node.paneId ?? ""];
          return [...collect(node.first as never), ...collect(node.second as never)];
        })(repaired as never)
      : [];
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("sanitizeTab keeps colors valid and drops malformed layouts", () => {
    expect(sanitizeTab({ title: "T", color: "#89b4fa" })?.color).toBe("#89b4fa");
    expect(sanitizeTab({ title: "T", layout: { kind: "bogus" } })?.layout).toBeUndefined();
  });
});

describe("settings + shortcuts preservation regressions", () => {
  it("recovers from corrupted settings and drops unknown/obsolete keys", () => {
    localStorage.setItem("kai_user_settings", "{not json");
    expect(SettingsService.loadSettings()).toEqual(DEFAULT_SETTINGS);
    const normalized = SettingsService.normalize({
      theme: "nope" as never,
      fontSize: 999,
      opacity: 99,
      keybindings: { newTab: "T", bogusAction: "Ctrl+X" } as never,
    });
    expect(normalized.theme).toBe("kali");
    expect(normalized.fontSize).toBeLessThanOrEqual(36);
    expect(normalized.opacity).toBe(1.0);
    expect(
      (normalized.keybindings as unknown as Record<string, unknown>).bogusAction
    ).toBeUndefined();
    expect(parseBinding(normalized.keybindings.newTab)).not.toBeNull();
  });

  it("persists up to the pane ceiling and truncates anything beyond it", () => {
    const mk = (n: number) => ({
      title: "Wide",
      panes: Array.from({ length: n }, (_, i) => ({ cwd: `/work/${i}` })),
    });
    expect(sanitizeTab(mk(MAX_PANES_PER_TAB))?.panes).toHaveLength(MAX_PANES_PER_TAB);
    // A tampered/corrupt payload with too many panes is clipped, not trusted.
    const clipped = sanitizeTab(mk(MAX_PANES_PER_TAB + 4));
    expect(clipped?.panes).toHaveLength(MAX_PANES_PER_TAB);
    expect(clipped?.panes?.[MAX_PANES_PER_TAB - 1].cwd).toBe(`/work/${MAX_PANES_PER_TAB - 1}`);
  });

  it("keeps conflict detection and platform modifier behavior", () => {
    expect(findConflicts({ ...DEFAULT_SETTINGS.keybindings })).toHaveLength(0);
    const conflicts = findConflicts({ ...DEFAULT_SETTINGS.keybindings, search: "Ctrl+Shift+T" });
    expect(conflicts.length).toBeGreaterThan(0);
    // Ctrl and Cmd are interchangeable so one binding works on every OS.
    const ctrlT = new KeyboardEvent("keydown", { code: "KeyT", ctrlKey: true, shiftKey: true });
    const cmdT = new KeyboardEvent("keydown", { code: "KeyT", metaKey: true, shiftKey: true });
    expect(eventMatchesBinding(ctrlT, "Ctrl+Shift+T")).toBe(true);
    expect(eventMatchesBinding(cmdT, "Ctrl+Shift+T")).toBe(true);
    expect(platformLabel("Ctrl+Shift+T", true)).toBe("Cmd+Shift+T");
    expect(platformLabel("Cmd+Shift+T", false)).toBe("Ctrl+Shift+T");
  });
});
