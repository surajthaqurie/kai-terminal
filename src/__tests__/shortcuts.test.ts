// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  parseBinding,
  eventMatchesBinding,
  findConflicts,
  validateBinding,
  isTypingTarget,
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
});
