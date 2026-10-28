// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  DEFAULT_FIXED_SHORTCUTS,
  eventToBindingString,
  findConflicts,
  isCopyKeyEvent,
  isPasteKeyEvent,
  matchBuiltinShortcut,
  matchTerminalAction,
  parseBinding,
  resolveFixedBindings,
  validateFixedBinding,
} from "../services/shortcuts";
import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_SETTINGS,
  SettingsService,
} from "../services/settingsService";
import type { FixedShortcutsConfig } from "../types/terminal";

function keyEvent(code: string, opts: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { code, bubbles: true, ...opts });
}

const withFixed = (patch: Partial<FixedShortcutsConfig>): FixedShortcutsConfig => ({
  ...DEFAULT_FIXED_SHORTCUTS,
  ...patch,
});

describe("remappable terminal shortcuts: defaults are unchanged", () => {
  it("every default parses and the defaults match the old fixed keys", () => {
    for (const v of Object.values(DEFAULT_FIXED_SHORTCUTS)) expect(parseBinding(v)).not.toBeNull();
    const d = DEFAULT_FIXED_SHORTCUTS;
    expect([d.zoomIn, d.zoomOut, d.zoomReset]).toEqual(["Ctrl+=", "Ctrl+-", "Ctrl+0"]);
    expect([d.copy, d.paste]).toEqual(["Ctrl+Shift+C", "Ctrl+Shift+V"]);
    expect([d.selectAll, d.clearTerminal]).toEqual(["Ctrl+Shift+A", "Ctrl+Shift+K"]);
    expect([d.scrollTop, d.scrollBottom]).toEqual(["Ctrl+Shift+Home", "Ctrl+Shift+End"]);
    expect(d.tabJump).toBe("Ctrl+1");
  });

  it("explicit defaults behave exactly like no config (numpad, Cmd, Shift+Ctrl+=)", () => {
    const explicit = { ...DEFAULT_FIXED_SHORTCUTS };
    const cases: Array<[string, Partial<KeyboardEventInit>]> = [
      ["Equal", { ctrlKey: true }],
      ["Equal", { ctrlKey: true, shiftKey: true }],
      ["NumpadAdd", { metaKey: true }],
      ["Minus", { ctrlKey: true }],
      ["NumpadSubtract", { ctrlKey: true }],
      ["Digit0", { ctrlKey: true }],
      ["Digit0", { ctrlKey: true, shiftKey: true }],
      ["Digit3", { ctrlKey: true }],
      ["Numpad9", { metaKey: true }],
      ["Digit3", { ctrlKey: true, altKey: true }],
      ["KeyA", { ctrlKey: true, shiftKey: true }],
      ["End", { metaKey: true, shiftKey: true }],
    ];
    for (const [code, opts] of cases) {
      const e = keyEvent(code, opts);
      expect(matchBuiltinShortcut(e, explicit)).toEqual(matchBuiltinShortcut(e));
      expect(matchTerminalAction(e, explicit)).toEqual(matchTerminalAction(e));
    }
    expect(isCopyKeyEvent(keyEvent("KeyC", { metaKey: true }), true, explicit)).toBe(true);
    expect(isPasteKeyEvent(keyEvent("KeyV", { metaKey: true }), explicit)).toBe(true);
    expect(isCopyKeyEvent(keyEvent("KeyC", { ctrlKey: true }), true, explicit)).toBe(false);
  });
});

describe("remapping frees the old combo and claims the new one", () => {
  it("lets Ctrl+- be rebound so the readline undo byte reaches the shell", () => {
    const fixed = withFixed({ zoomOut: "Ctrl+Alt+-" });
    // Old combo no longer zooms (it now reaches the shell as Ctrl+_ / undo).
    expect(matchBuiltinShortcut(keyEvent("Minus", { ctrlKey: true }), fixed)).toBeNull();
    expect(matchBuiltinShortcut(keyEvent("Minus", { ctrlKey: true, altKey: true }), fixed)).toEqual(
      { type: "zoom", delta: -1 }
    );
    // The other zoom keys are untouched.
    expect(matchBuiltinShortcut(keyEvent("Equal", { ctrlKey: true }), fixed)).toEqual({
      type: "zoom",
      delta: 1,
    });
  });

  it("remaps zoom in / reset", () => {
    const fixed = withFixed({ zoomIn: "Ctrl+Shift+Up", zoomReset: "Alt+0" });
    expect(
      matchBuiltinShortcut(keyEvent("ArrowUp", { ctrlKey: true, shiftKey: true }), fixed)
    ).toEqual({ type: "zoom", delta: 1 });
    expect(matchBuiltinShortcut(keyEvent("Digit0", { altKey: true }), fixed)).toEqual({
      type: "zoom",
      delta: 0,
    });
    expect(matchBuiltinShortcut(keyEvent("Digit0", { ctrlKey: true }), fixed)).toBeNull();
  });

  it("remaps tab jump: modifiers are configurable, digits 1-9 follow", () => {
    const fixed = withFixed({ tabJump: "Alt+1" });
    expect(matchBuiltinShortcut(keyEvent("Digit1", { altKey: true }), fixed)).toEqual({
      type: "gotoTab",
      index: 0,
    });
    expect(matchBuiltinShortcut(keyEvent("Digit8", { altKey: true }), fixed)).toEqual({
      type: "gotoTab",
      index: 7,
    });
    expect(matchBuiltinShortcut(keyEvent("Digit9", { altKey: true }), fixed)).toEqual({
      type: "gotoTab",
      index: "last",
    });
    expect(matchBuiltinShortcut(keyEvent("Digit1", { ctrlKey: true }), fixed)).toBeNull();
    expect(
      matchBuiltinShortcut(keyEvent("Digit1", { altKey: true, shiftKey: true }), fixed)
    ).toBeNull();
  });

  it("remaps copy and paste, keeping Ctrl+Insert / Shift+Insert and the selection gate", () => {
    const fixed = withFixed({ copy: "Ctrl+Alt+C", paste: "Ctrl+Alt+V" });
    expect(isCopyKeyEvent(keyEvent("KeyC", { ctrlKey: true, altKey: true }), true, fixed)).toBe(
      true
    );
    expect(isCopyKeyEvent(keyEvent("KeyC", { ctrlKey: true, altKey: true }), false, fixed)).toBe(
      false
    );
    expect(isCopyKeyEvent(keyEvent("KeyC", { ctrlKey: true, shiftKey: true }), true, fixed)).toBe(
      false
    );
    expect(isCopyKeyEvent(keyEvent("Insert", { ctrlKey: true }), true, fixed)).toBe(true);
    expect(isPasteKeyEvent(keyEvent("KeyV", { ctrlKey: true, altKey: true }), fixed)).toBe(true);
    expect(isPasteKeyEvent(keyEvent("KeyV", { ctrlKey: true, shiftKey: true }), fixed)).toBe(false);
    expect(isPasteKeyEvent(keyEvent("Insert", { shiftKey: true }), fixed)).toBe(true);
    // Plain Ctrl+C / Ctrl+V still reach the shell.
    expect(isCopyKeyEvent(keyEvent("KeyC", { ctrlKey: true }), true, fixed)).toBe(false);
    expect(isPasteKeyEvent(keyEvent("KeyV", { ctrlKey: true }), fixed)).toBe(false);
  });

  it("remaps the terminal-local keys, including Home / End", () => {
    const fixed = withFixed({
      selectAll: "Ctrl+Alt+A",
      clearTerminal: "Ctrl+Alt+L",
      scrollTop: "Ctrl+Alt+Home",
      scrollBottom: "Ctrl+Alt+End",
    });
    expect(matchTerminalAction(keyEvent("KeyA", { ctrlKey: true, altKey: true }), fixed)).toBe(
      "selectAll"
    );
    expect(matchTerminalAction(keyEvent("KeyL", { ctrlKey: true, altKey: true }), fixed)).toBe(
      "clear"
    );
    expect(matchTerminalAction(keyEvent("Home", { ctrlKey: true, altKey: true }), fixed)).toBe(
      "scrollTop"
    );
    expect(matchTerminalAction(keyEvent("End", { ctrlKey: true, altKey: true }), fixed)).toBe(
      "scrollBottom"
    );
    expect(
      matchTerminalAction(keyEvent("KeyA", { ctrlKey: true, shiftKey: true }), fixed)
    ).toBeNull();
    expect(
      matchTerminalAction(keyEvent("End", { ctrlKey: true, shiftKey: true }), fixed)
    ).toBeNull();
  });
});

describe("validation, conflicts and recording", () => {
  it("parses and records Home / End / Insert / PageUp / PageDown / - / =", () => {
    expect(parseBinding("Ctrl+Shift+Home")?.code).toBe("Home");
    expect(parseBinding("Ctrl+PageDown")?.code).toBe("PageDown");
    expect(parseBinding("Ctrl+-")?.code).toBe("Minus");
    expect(parseBinding("Ctrl+=")?.code).toBe("Equal");
    const e = (code: string, key: string) => ({
      code,
      key,
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    });
    expect(eventToBindingString(e("Home", "Home"))).toBe("Ctrl+Shift+Home");
    expect(eventToBindingString(e("PageUp", "PageUp"))).toBe("Ctrl+Shift+PageUp");
    expect(eventToBindingString(e("Minus", "_"))).toBe("Ctrl+Shift+-");
    expect(eventToBindingString(e("Equal", "+"))).toBe("Ctrl+Shift+=");
  });

  it("tab jump needs a digit 1-9", () => {
    expect(validateFixedBinding("tabJump", "Ctrl+1")).toBeNull();
    expect(validateFixedBinding("tabJump", "Alt+7")).toBeNull();
    expect(validateFixedBinding("tabJump", "Ctrl+0")).not.toBeNull();
    expect(validateFixedBinding("tabJump", "Ctrl+T")).not.toBeNull();
    expect(validateFixedBinding("zoomOut", "Ctrl+Alt+-")).toBeNull();
    expect(validateFixedBinding("zoomOut", "")).not.toBeNull();
    expect(validateFixedBinding("zoomOut", "-")).not.toBeNull();
  });

  it("defaults do not collide with each other or with the default actions", () => {
    expect(findConflicts(DEFAULT_KEYBINDINGS, DEFAULT_FIXED_SHORTCUTS)).toEqual([]);
  });

  it("flags a user action that shadows a terminal key, including any tab-jump digit", () => {
    const clash = findConflicts(
      { ...DEFAULT_KEYBINDINGS, search: "Ctrl+Shift+K", nextTab: "Ctrl+5" },
      DEFAULT_FIXED_SHORTCUTS
    );
    expect(clash.map((c) => c.actions.slice().sort())).toEqual([
      ["clearTerminal", "search"],
      ["nextTab", "tabJump"],
    ]);
    // Without the fixed config the old behaviour (actions only) is unchanged.
    expect(findConflicts({ ...DEFAULT_KEYBINDINGS, search: "Ctrl+Shift+K" })).toEqual([]);
  });

  it("flags two terminal keys on one combo and clears once remapped", () => {
    expect(
      findConflicts(DEFAULT_KEYBINDINGS, withFixed({ zoomIn: "Ctrl+-" })).map((c) =>
        c.actions.slice().sort()
      )
    ).toEqual([["zoomIn", "zoomOut"]]);
    expect(
      findConflicts(DEFAULT_KEYBINDINGS, withFixed({ zoomIn: "Ctrl+-", zoomOut: "Ctrl+Alt+-" }))
    ).toEqual([]);
  });
});

describe("settings persistence", () => {
  it("fills defaults and recovers corrupted entries", () => {
    expect(DEFAULT_SETTINGS.fixedKeybindings).toEqual(DEFAULT_FIXED_SHORTCUTS);
    const normalized = SettingsService.normalize({
      fixedKeybindings: {
        ...DEFAULT_FIXED_SHORTCUTS,
        zoomOut: "Ctrl+Alt+-",
        paste: "nonsense",
        tabJump: "Ctrl+T",
        bogus: "Ctrl+B",
      } as unknown as FixedShortcutsConfig,
    });
    expect(normalized.fixedKeybindings?.zoomOut).toBe("Ctrl+Alt+-");
    expect(normalized.fixedKeybindings?.paste).toBe(DEFAULT_FIXED_SHORTCUTS.paste);
    expect(normalized.fixedKeybindings?.tabJump).toBe(DEFAULT_FIXED_SHORTCUTS.tabJump);
    expect(normalized.fixedKeybindings).not.toHaveProperty("bogus");
    expect(SettingsService.normalize({}).fixedKeybindings).toEqual(DEFAULT_FIXED_SHORTCUTS);
  });

  it("survives a save / load round trip", () => {
    localStorage.clear();
    const custom = withFixed({ zoomOut: "Ctrl+Alt+-", scrollTop: "Ctrl+Alt+Home" });
    SettingsService.saveSettings({ ...DEFAULT_SETTINGS, fixedKeybindings: custom });
    expect(SettingsService.loadSettings().fixedKeybindings).toEqual(custom);
    localStorage.clear();
  });

  it("resolveFixedBindings ignores null and partial input", () => {
    expect(resolveFixedBindings(null)).toEqual(DEFAULT_FIXED_SHORTCUTS);
    expect(resolveFixedBindings({ copy: "Ctrl+Alt+C" }).copy).toBe("Ctrl+Alt+C");
    expect(resolveFixedBindings({ copy: "Ctrl+Alt+C" }).paste).toBe("Ctrl+Shift+V");
  });
});
