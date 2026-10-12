// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  parseBinding,
  eventMatchesBinding,
  findConflicts,
  validateBinding,
  isTypingTarget,
  isCopyKeyEvent,
  isPasteKeyEvent,
  platformLabel,
} from "../services/shortcuts";
import { DEFAULT_KEYBINDINGS } from "../services/settingsService";

function keyEvent(code: string, opts: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { code, bubbles: true, ...opts });
}

describe("shortcut registry", () => {
  it("preserves existing defaults", () => {
    expect(DEFAULT_KEYBINDINGS.newTab).toBe("Ctrl+Shift+T");
    expect(DEFAULT_KEYBINDINGS.closeTab).toBe("Ctrl+Shift+W");
    expect(DEFAULT_KEYBINDINGS.splitHorizontal).toBe("Ctrl+Alt+S");
    expect(DEFAULT_KEYBINDINGS.splitVertical).toBe("Ctrl+Alt+V");
    expect(DEFAULT_KEYBINDINGS.closePane).toBe("Ctrl+Alt+W");
    for (const v of Object.values(DEFAULT_KEYBINDINGS)) {
      expect(parseBinding(v)).not.toBeNull();
    }
  });

  it("matches platform-modified events and Cmd as Ctrl", () => {
    expect(
      eventMatchesBinding(keyEvent("KeyT", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+T")
    ).toBe(true);
    expect(
      eventMatchesBinding(keyEvent("KeyT", { metaKey: true, shiftKey: true }), "Ctrl+Shift+T")
    ).toBe(true);
    expect(eventMatchesBinding(keyEvent("KeyT", { ctrlKey: true }), "Ctrl+Shift+T")).toBe(false);
    expect(
      eventMatchesBinding(keyEvent("Comma", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+,")
    ).toBe(true);
  });

  it("supports extended universal bindings (F-keys, Alt-only, arrows)", () => {
    expect(parseBinding("Alt+T")).not.toBeNull();
    expect(parseBinding("Ctrl+F5")).not.toBeNull();
    expect(parseBinding("Ctrl+Up")).not.toBeNull();
    expect(eventMatchesBinding(keyEvent("KeyT", { altKey: true }), "Alt+T")).toBe(true);
    expect(validateBinding("Ctrl+F5")).toBeNull();
  });

  it("detects conflicting bindings", () => {
    const conflicts = findConflicts({
      ...DEFAULT_KEYBINDINGS,
      search: "Ctrl+Shift+T",
    });
    expect(conflicts.length).toBeGreaterThan(0);
    const actions = conflicts.flatMap((c) => c.actions);
    expect(actions).toContain("newTab");
    expect(actions).toContain("search");
    expect(findConflicts({ ...DEFAULT_KEYBINDINGS })).toHaveLength(0);
  });

  it("rejects invalid bindings", () => {
    expect(validateBinding("")).not.toBeNull();
    expect(validateBinding("T")).not.toBeNull();
    expect(validateBinding("Ctrl+T")).toBeNull();
    expect(validateBinding("Ctrl+Alt+W")).toBeNull();
    expect(validateBinding("Shift+Bogus")).not.toBeNull();
  });

  it("does not capture keystrokes typed in settings fields", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(isTypingTarget(input)).toBe(true);
    const ta = document.createElement("textarea");
    expect(isTypingTarget(ta)).toBe(true);
    const div = document.createElement("div");
    expect(isTypingTarget(div)).toBe(false);
    input.remove();
  });

  it("renders platform labels", () => {
    expect(platformLabel("Ctrl+Shift+T", true)).toBe("Cmd+Shift+T");
    expect(platformLabel("Ctrl+Shift+T", false)).toBe("Ctrl+Shift+T");
  });

  it("detects terminal paste combos (single-writer guard against double paste)", () => {
    // Ctrl+Shift+V (Win/Linux)
    expect(isPasteKeyEvent(keyEvent("KeyV", { ctrlKey: true, shiftKey: true }))).toBe(true);
    // Cmd+V (macOS)
    expect(isPasteKeyEvent(keyEvent("KeyV", { metaKey: true }))).toBe(true);
    // Cmd+Shift+V also pastes (matches first clause via metaKey)
    expect(isPasteKeyEvent(keyEvent("KeyV", { metaKey: true, shiftKey: true }))).toBe(true);
    // Shift+Insert
    expect(isPasteKeyEvent(keyEvent("Insert", { shiftKey: true }))).toBe(true);
    // Plain Ctrl+V must NOT paste — it reaches the shell untouched
    expect(isPasteKeyEvent(keyEvent("KeyV", { ctrlKey: true }))).toBe(false);
    // Copy combos must NOT paste
    expect(isPasteKeyEvent(keyEvent("KeyC", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPasteKeyEvent(keyEvent("KeyC", { metaKey: true }))).toBe(false);
    // Plain keys never paste
    expect(isPasteKeyEvent(keyEvent("KeyV", {}))).toBe(false);
    expect(isPasteKeyEvent(keyEvent("Insert", {}))).toBe(false);
  });

  it("detects terminal copy combos per OS, keeping Ctrl+C as SIGINT", () => {
    // Windows / Linux: Ctrl+Shift+C with a selection
    expect(isCopyKeyEvent(keyEvent("KeyC", { ctrlKey: true, shiftKey: true }), true)).toBe(true);
    // macOS: Cmd+C and Cmd+Shift+C with a selection
    expect(isCopyKeyEvent(keyEvent("KeyC", { metaKey: true }), true)).toBe(true);
    expect(isCopyKeyEvent(keyEvent("KeyC", { metaKey: true, shiftKey: true }), true)).toBe(true);
    // Windows / Linux standard: Ctrl+Insert with a selection
    expect(isCopyKeyEvent(keyEvent("Insert", { ctrlKey: true }), true)).toBe(true);
    // No selection → never copy (plain Ctrl+C keeps working as interrupt)
    expect(isCopyKeyEvent(keyEvent("KeyC", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isCopyKeyEvent(keyEvent("KeyC", { metaKey: true }), false)).toBe(false);
    // Plain Ctrl+C is SIGINT, never copy — even with a selection
    expect(isCopyKeyEvent(keyEvent("KeyC", { ctrlKey: true }), true)).toBe(false);
    // Shift+Insert is paste on every OS, never copy — even with a selection
    expect(isCopyKeyEvent(keyEvent("Insert", { shiftKey: true }), true)).toBe(false);
    expect(isPasteKeyEvent(keyEvent("Insert", { shiftKey: true }))).toBe(true);
    // Copy and paste sets are disjoint across all combos
    const combos: Array<[string, Partial<KeyboardEventInit>, boolean]> = [
      ["KeyC", { ctrlKey: true, shiftKey: true }, true],
      ["KeyC", { metaKey: true }, true],
      ["Insert", { ctrlKey: true }, true],
      ["KeyV", { ctrlKey: true, shiftKey: true }, true],
      ["KeyV", { metaKey: true }, true],
      ["Insert", { shiftKey: true }, true],
    ];
    for (const [code, opts, sel] of combos) {
      const e = keyEvent(code, opts);
      expect(isCopyKeyEvent(e, sel) && isPasteKeyEvent(e)).toBe(false);
    }
  });
});
