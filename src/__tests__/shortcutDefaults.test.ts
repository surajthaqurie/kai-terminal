// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { buildShortcutHints } from "../hooks/useShortcutHints";
import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_SETTINGS,
  LEGACY_DEFAULT_KEYBINDINGS,
  SettingsService,
  migrateLegacyKeybindings,
  migrateMusicKeybindings,
} from "../services/settingsService";
import {
  DEFAULT_FIXED_SHORTCUTS,
  eventMatchesBinding,
  eventToBindingString,
  findConflicts,
  findReservedConflicts,
  matchShortcut,
  musicShortcutHints,
  platformLabel,
  withKeys,
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
      ["musicPrevious", { key: "<", code: "Comma", ctrlKey: true, shiftKey: true }],
      ["musicNext", { key: ">", code: "Period", ctrlKey: true, shiftKey: true }],
      ["musicMute", { key: ")", code: "Digit0", ctrlKey: true, shiftKey: true }],
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
    // The old Settings key (Ctrl+Shift+,) is also Previous song's default. The user's
    // own key keeps working (it is earlier in the registry) and Settings names the clash.
    const conflicts = findConflicts(kb, DEFAULT_FIXED_SHORTCUTS);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].actions.sort()).toEqual(["musicPrevious", "settings"]);
    expect(
      matchShortcut(
        new KeyboardEvent("keydown", { code: "Comma", ctrlKey: true, shiftKey: true }),
        kb
      )
    ).toBe("settings");
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

describe("music shortcuts", () => {
  it("Previous and Next sit on the < and > keys, and Mute is no longer on <", () => {
    expect(DEFAULT_KEYBINDINGS.musicPrevious).toBe("Ctrl+Shift+,");
    expect(DEFAULT_KEYBINDINGS.musicNext).toBe("Ctrl+Shift+.");
    expect(DEFAULT_KEYBINDINGS.musicMute).toBe("Ctrl+Shift+0");
    expect(findConflicts(DEFAULT_KEYBINDINGS, DEFAULT_FIXED_SHORTCUTS)).toEqual([]);
    expect(findReservedConflicts(DEFAULT_KEYBINDINGS)).toEqual([]);
  });

  it("Ctrl+Shift+0 is Mute, not zoom reset", () => {
    const e = new KeyboardEvent("keydown", { code: "Digit0", ctrlKey: true, shiftKey: true });
    expect(matchShortcut(e, DEFAULT_KEYBINDINGS)).toBe("musicMute");
  });

  describe("Mute moves off Ctrl+Shift+, once", () => {
    it("an install that saved after the last update gets Previous on < without a clash", () => {
      // Saved by the previous version: Mute on <, and no Previous action yet.
      const saved = { ...DEFAULT_KEYBINDINGS, musicMute: "Ctrl+Shift+," } as Record<string, string>;
      delete saved.musicPrevious;
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ keybindings: saved, version: 1, _keybindingsMigrated: true })
      );
      const kb = SettingsService.loadSettings().keybindings;
      expect(kb.musicMute).toBe("Ctrl+Shift+0");
      expect(kb.musicPrevious).toBe("Ctrl+Shift+,");
      expect(findConflicts(kb, DEFAULT_FIXED_SHORTCUTS)).toEqual([]);
    });

    it("a Mute key the user chose is kept", () => {
      expect(migrateMusicKeybindings({ musicMute: "Ctrl+Shift+U" })).toEqual({
        musicMute: "Ctrl+Shift+U",
      });
    });

    it("spelling of the old key does not matter (Cmd, spacing)", () => {
      expect(migrateMusicKeybindings({ musicMute: "Cmd+Shift+," }).musicMute).toBe("Ctrl+Shift+0");
    });

    it("keeps the old key when the new one is already bound to something else", () => {
      const out = migrateMusicKeybindings({ musicMute: "Ctrl+Shift+,", search: "Ctrl+Shift+0" });
      expect(out.musicMute).toBe("Ctrl+Shift+,");
      expect(out.search).toBe("Ctrl+Shift+0");
    });

    it("runs once: Ctrl+Shift+, chosen for Mute after the migration is kept", () => {
      SettingsService.saveSettings({
        ...DEFAULT_SETTINGS,
        keybindings: {
          ...DEFAULT_KEYBINDINGS,
          musicMute: "Ctrl+Shift+,",
          musicPrevious: "Ctrl+Shift+P",
        },
      });
      expect(SettingsService.loadSettings().keybindings.musicMute).toBe("Ctrl+Shift+,");
    });

    it("copes with missing or corrupt input", () => {
      expect(migrateMusicKeybindings(null)).toEqual({});
      expect(migrateMusicKeybindings("nope")).toEqual({});
      expect(migrateMusicKeybindings({ musicMute: 42 })).toEqual({ musicMute: 42 });
    });
  });

  describe("tooltip hints", () => {
    it("follow the current bindings and the platform", () => {
      const kb = { ...DEFAULT_KEYBINDINGS, musicNext: "Ctrl+Alt+N" };
      expect(musicShortcutHints(kb, false)).toEqual({
        toggle: "Ctrl+Shift+M",
        playPause: "Ctrl+Shift+Space",
        previous: "Ctrl+Shift+,",
        next: "Ctrl+Alt+N",
        mute: "Ctrl+Shift+0",
      });
      expect(musicShortcutHints(DEFAULT_KEYBINDINGS, true).next).toBe("Cmd+Shift+.");
    });

    it("withKeys lists every key and drops empty ones", () => {
      expect(withKeys("Next song", "N", "Ctrl+Shift+.")).toBe("Next song (N or Ctrl+Shift+.)");
      expect(withKeys("Next song", undefined, "")).toBe("Next song");
      expect(withKeys("Mute", "M")).toBe("Mute (M)");
    });
  });
});

describe("shortcut labels per platform", () => {
  it("macOS shows Cmd and Option; Windows and Linux show Ctrl and Alt", () => {
    expect(platformLabel("Ctrl+Shift+T", true)).toBe("Cmd+Shift+T");
    expect(platformLabel("Alt+Shift+W", true)).toBe("Option+Shift+W");
    expect(platformLabel("Ctrl+Alt+N", true)).toBe("Cmd+Option+N");
    expect(platformLabel("Cmd+Shift+T", false)).toBe("Ctrl+Shift+T");
    expect(platformLabel("Alt+Shift+W", false)).toBe("Alt+Shift+W");
    // Keys that merely contain "alt" are untouched.
    expect(platformLabel("Ctrl+Shift+Space", true)).toBe("Cmd+Shift+Space");
  });

  it("is display text only: the stored binding still parses as written", () => {
    expect(
      eventMatchesBinding(
        { ctrlKey: false, metaKey: false, altKey: true, shiftKey: true, code: "KeyW" },
        "Alt+Shift+W"
      )
    ).toBe(true);
  });

  it("builds a hint for every remappable action from the current bindings", () => {
    const hints = buildShortcutHints({ ...DEFAULT_KEYBINDINGS, closeTab: "Ctrl+Alt+X" }, true);
    expect(hints.newTab).toBe("Cmd+Shift+T");
    expect(hints.closePane).toBe("Option+Shift+W");
    expect(hints.closeTab).toBe("Cmd+Option+X");
    expect(Object.keys(hints).sort()).toEqual(Object.keys(DEFAULT_KEYBINDINGS).sort());
  });
});
