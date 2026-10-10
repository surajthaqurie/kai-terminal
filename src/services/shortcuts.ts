import { KeybindingsConfig } from "../types/terminal";
import { DEFAULT_KEYBINDINGS } from "./settingsService";

export type ShortcutActionId = keyof KeybindingsConfig;

export const SHORTCUT_ACTION_LABELS: Record<ShortcutActionId, string> = {
  newTab: "New tab",
  closeTab: "Close tab or pane",
  splitHorizontal: "Split terminal (horizontal)",
  splitVertical: "Split terminal (vertical)",
  closePane: "Close active pane",
  search: "Find in terminal",
  commandPalette: "Toggle command palette",
  settings: "Open settings",
  restart: "Restart session",
  nextTab: "Next tab",
  prevTab: "Previous tab",
  nextPane: "Next active pane",
};

export interface ParsedBinding {
  ctrlOrCmd: boolean;
  alt: boolean;
  shift: boolean;
  code: string;
  key: string;
}

/** Parse "Ctrl+Shift+T" / "Cmd+Alt+V" / "Ctrl+," into parts. Returns null when invalid. */
export function parseBinding(binding: string): ParsedBinding | null {
  const trimmed = binding.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("+").map((p) => p.trim());
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  if (!last) return null;
  let ctrlOrCmd = false;
  let alt = false;
  let shift = false;
  for (const mod of parts.slice(0, -1)) {
    const m = mod.toLowerCase();
    if (m === "ctrl" || m === "cmd" || m === "meta" || m === "control") {
      ctrlOrCmd = true;
    } else if (m === "alt" || m === "option") {
      alt = true;
    } else if (m === "shift") {
      shift = true;
    } else {
      return null;
    }
  }
  if (!ctrlOrCmd && !alt) return null;
  const upper = last.toUpperCase();
  let code: string;
  let key = last;
  if (/^[A-Z0-9]$/.test(upper)) {
    code = upper.match(/^[0-9]$/) ? `Digit${upper}` : `Key${upper}`;
  } else if (upper === ",") {
    code = "Comma";
  } else if (upper === "." || upper === "PERIOD") {
    code = "Period";
  } else if (upper === "/" || upper === "SLASH") {
    code = "Slash";
  } else if (upper === "[" || upper === "BRACKETLEFT") {
    code = "BracketLeft";
  } else if (upper === "]" || upper === "BRACKETRIGHT") {
    code = "BracketRight";
  } else {
    return null;
  }
  return { ctrlOrCmd, alt, shift, code, key };
}

/** Normalize to canonical "Ctrl+Shift+T" (macOS label uses Cmd). */
export function normalizeBinding(binding: string, isMac = false): string | null {
  const parsed = parseBinding(binding);
  if (!parsed) return null;
  const mod = parsed.ctrlOrCmd ? (isMac ? "Cmd" : "Ctrl") : null;
  const segs: string[] = [];
  if (mod) segs.push(mod);
  if (parsed.alt) segs.push("Alt");
  if (parsed.shift) segs.push("Shift");
  segs.push(parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  return segs.join("+");
}

/** True when a keyboard event matches a binding string. */
export function eventMatchesBinding(e: KeyboardEvent, binding: string): boolean {
  const parsed = parseBinding(binding);
  if (!parsed) return false;
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  if (parsed.ctrlOrCmd !== ctrlOrCmd) return false;
  if (parsed.alt !== e.altKey) return false;
  if (parsed.shift !== e.shiftKey) return false;
  return e.code === parsed.code;
}

/** Find the first action whose binding matches the event. */
export function matchShortcut(
  e: KeyboardEvent,
  bindings: KeybindingsConfig
): ShortcutActionId | null {
  (Object.keys(bindings) as ShortcutActionId[]).forEach(() => {});
  for (const action of Object.keys(bindings) as ShortcutActionId[]) {
    const binding = bindings[action];
    if (typeof binding === "string" && eventMatchesBinding(e, binding)) {
      return action;
    }
  }
  return null;
}

/** Detect conflicting bindings (two actions sharing one normalized combo). */
export function findConflicts(bindings: KeybindingsConfig): Array<{
  binding: string;
  actions: ShortcutActionId[];
}> {
  const byCombo = new Map<string, ShortcutActionId[]>();
  for (const action of Object.keys(bindings) as ShortcutActionId[]) {
    const raw = bindings[action];
    if (typeof raw !== "string") continue;
    const parsed = parseBinding(raw);
    if (!parsed) continue;
    const key = `${parsed.ctrlOrCmd ? "C" : ""}${parsed.alt ? "A" : ""}${parsed.shift ? "S" : ""}:${parsed.code}`;
    const list = byCombo.get(key) ?? [];
    list.push(action);
    byCombo.set(key, list);
  }
  const out: Array<{ binding: string; actions: ShortcutActionId[] }> = [];
  for (const [, actions] of byCombo) {
    if (actions.length > 1) {
      out.push({
        binding: actions.map((a) => bindings[a]).join(" / "),
        actions,
      });
    }
  }
  return out;
}

/** Validate one binding string; returns an error message or null when valid. */
export function validateBinding(value: string): string | null {
  if (!value.trim()) return "Binding must not be empty.";
  const parsed = parseBinding(value);
  if (!parsed) {
    return "Use modifiers Ctrl/Cmd + Alt/Shift plus a letter, digit, comma, period, or slash (e.g. Ctrl+Shift+T).";
  }
  return null;
}

/** True when the event target is a text input where shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable) return true;
  if (target.closest?.("input, textarea, select, [contenteditable='true']")) return true;
  return false;
}

export function platformDefaultBindings(isMac: boolean): KeybindingsConfig {
  if (!isMac) return { ...DEFAULT_KEYBINDINGS };
  // Same combos; labels render Cmd instead of Ctrl via platformLabel().
  return { ...DEFAULT_KEYBINDINGS };
}

/** Render a binding with the platform modifier name. */
export function platformLabel(binding: string, isMac: boolean): string {
  if (!isMac) return binding.replace(/^Cmd\b/, "Ctrl");
  return binding.replace(/^Ctrl\b/, "Cmd");
}

export function isMacPlatform(): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      (/mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent))
    );
  } catch {
    return false;
  }
}
