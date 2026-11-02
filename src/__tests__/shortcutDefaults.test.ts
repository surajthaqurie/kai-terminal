// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_SETTINGS,
  LEGACY_DEFAULT_KEYBINDINGS,
  SettingsService,
  migrateLegacyKeybindings,
} from "../services/settingsService";
import {
  DEFAULT_FIXED_SHORTCUTS,
  eventMatchesBinding,
  eventToBindingString,
  findConflicts,
  findReservedConflicts,
  type ShortcutActionId,
} from "../services/shortcuts";

const STORAGE_KEY = "kai_user_settings";

function stored(keybindings: Record<string, string>, extra: Record<string, unknown> = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ keybindings, version: 1, ...extra }));
}

describe("Windows Terminal-style defaults", () => {
  it("have no conflicts with each other, the terminal keys or the reserved combos", () => {
    expect(findConflicts(DEFAULT_KEYBINDINGS, DEFAULT_FIXED_SHORTCUTS)).toEqual([]);
    expect(findReservedConflicts(DEFAULT_KEYBINDINGS)).toEqual([]);
  });

  it("never need Ctrl+Alt, which is AltGr on Windows", () => {
    for (const [action, binding] of Object.entries(DEFAULT_KEYBINDINGS)) {
      expect(/Ctrl\+Alt/.test(binding), action).toBe(false);
    }
  });

  it("use the Windows Terminal pane and tab keys", () => {
    expect(DEFAULT_KEYBINDINGS).toMatchObject({
      splitHorizontal: "Alt+Shift+-",
      splitVertical: "Alt+Shift+=",
      closePane: "Alt+Shift+W",
      nextTab: "Ctrl+Tab",
      prevTab: "Ctrl+Shift+Tab",
      settings: "Ctrl+,",
    });
  });

  it("round-trip through the recorder: recording a default yields the same binding", () => {
    const chords: Array<
      [ShortcutActionId, Partial<KeyboardEvent> & { key: string; code: string }]
    > = [
      ["splitHorizontal", { key: "_", code: "Minus", altKey: true, shiftKey: true }],
      ["splitVertical", { key: "+", code: "Equal", altKey: true, shiftKey: true }],
      ["closePane", { key: "W", code: "KeyW", altKey: true, shiftKey: true }],
      ["nextPane", { key: "}", code: "BracketRight", altKey: true, shiftKey: true }],
      ["prevPane", { key: "{", code: "BracketLeft", altKey: true, shiftKey: true }],
      ["nextTab", { key: "Tab", code: "Tab", ctrlKey: true }],
      ["prevTab", { key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true }],
      ["settings", { key: ",", code: "Comma", ctrlKey: true }],
      ["toggleMusic", { key: "M", code: "KeyM", ctrlKey: true, shiftKey: true }],
      ["musicPlayPause", { key: " ", code: "Space", ctrlKey: true, shiftKey: true }],
      ["musicNext", { key: ">", code: "Period", ctrlKey: true, shiftKey: true }],
      ["musicMute", { key: "<", code: "Comma", ctrlKey: true, shiftKey: true }],
    ];
    for (const [action, e] of chords) {
      const full = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...e };
      expect(eventToBindingString(full), action).toBe(DEFAULT_KEYBINDINGS[action]);
      expect(eventMatchesBinding(full, DEFAULT_KEYBINDINGS[action]), action).toBe(true);
    }
  });

  it("the recorder captures arrows, Tab, Enter and Space but never a bare key", () => {
    const base = { metaKey: false, altKey: false, shiftKey: false };
    expect(
      eventToBindingString({ ...base, key: "ArrowLeft", code: "ArrowLeft", ctrlKey: true })
    ).toBe("Ctrl+ArrowLeft");
    expect(eventToBindingString({ ...base, key: "Enter", code: "Enter", ctrlKey: true })).toBe(
      "Ctrl+Enter"
    );
    expect(eventToBindingString({ ...base, key: "Tab", code: "Tab", ctrlKey: false })).toBeNull();
    expect(eventToBindingString({ ...base, key: " ", code: "Space", ctrlKey: false })).toBeNull();
  });
});

describe("migrating saved shortcuts", () => {
  beforeEach(() => localStorage.clear());

  it("moves every untouched legacy default to the new default", () => {
    stored({ ...LEGACY_DEFAULT_KEYBINDINGS } as Record<string, string>);
    expect(SettingsService.loadSettings().keybindings).toEqual(DEFAULT_KEYBINDINGS);
  });

  it("keeps a binding the user customised and moves the rest", () => {
    stored({ ...LEGACY_DEFAULT_KEYBINDINGS, splitVertical: "Ctrl+Alt+D" } as Record<
      string,
      string
    >);
    const kb = SettingsService.loadSettings().keybindings;
    expect(kb.splitVertical).toBe("Ctrl+Alt+D");
    expect(kb.splitHorizontal).toBe(DEFAULT_KEYBINDINGS.splitHorizontal);
    expect(kb.nextTab).toBe("Ctrl+Tab");
  });

  it("treats Cmd and Ctrl spellings of a legacy default as untouched", () => {
    stored({ splitHorizontal: "Cmd+Alt+S" });
    expect(SettingsService.loadSettings().keybindings.splitHorizontal).toBe("Alt+Shift+-");
  });

  it("keeps the old key when the new default would collide with a custom binding", () => {
    // The user put "Search" on Ctrl+, ; the old Settings default (Ctrl+Shift+,)
    // must not move onto it and silently shadow it.
    stored({ ...LEGACY_DEFAULT_KEYBINDINGS, search: "Ctrl+," } as Record<string, string>);
    const kb = SettingsService.loadSettings().keybindings;
    expect(kb.search).toBe("Ctrl+,");
    expect(kb.settings).toBe(LEGACY_DEFAULT_KEYBINDINGS.settings);
    expect(findConflicts(kb, DEFAULT_FIXED_SHORTCUTS)).toEqual([]);
  });

  it("runs once: a legacy combo chosen after the migration is kept", () => {
    SettingsService.saveSettings({
      ...DEFAULT_SETTINGS,
      keybindings: { ...DEFAULT_KEYBINDINGS, splitHorizontal: "Ctrl+Alt+S" },
    });
    expect(SettingsService.loadSettings().keybindings.splitHorizontal).toBe("Ctrl+Alt+S");
  });

  it("an install that never saved shortcuts just gets the new defaults", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 16, version: 1 }));
    expect(SettingsService.loadSettings().keybindings).toEqual(DEFAULT_KEYBINDINGS);
  });

  it("copes with a missing, null or corrupt keybindings value", () => {
    for (const bad of [undefined, null, "oops", 7, []]) {
      expect(() => migrateLegacyKeybindings(bad)).not.toThrow();
    }
    expect(migrateLegacyKeybindings(null)).toEqual({});
  });
});
