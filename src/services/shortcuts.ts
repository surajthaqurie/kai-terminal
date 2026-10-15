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
  nextTab: "Next tab",
  prevTab: "Previous tab",
  nextPane: "Next active pane",
  toggleMusic: "Toggle music player",
  musicPlayPause: "Music play / pause",
  musicNext: "Music next track",
  musicMute: "Music mute / unmute",
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
  if (/^F([1-9]|1[0-2])$/.test(upper)) {
    code = upper;
  } else if (/^[A-Z0-9]$/.test(upper)) {
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
  } else if (upper === "TAB") {
    code = "Tab";
  } else if (upper === "ENTER" || upper === "RETURN") {
    code = "Enter";
  } else if (upper === "ESC" || upper === "ESCAPE") {
    code = "Escape";
  } else if (upper === "SPACE") {
    code = "Space";
  } else if (upper === "BACKSPACE") {
    code = "Backspace";
  } else if (upper === "DELETE" || upper === "DEL") {
    code = "Delete";
  } else if (upper === "UP" || upper === "ARROWUP") {
    code = "ArrowUp";
  } else if (upper === "DOWN" || upper === "ARROWDOWN") {
    code = "ArrowDown";
  } else if (upper === "LEFT" || upper === "ARROWLEFT") {
    code = "ArrowLeft";
  } else if (upper === "RIGHT" || upper === "ARROWRIGHT") {
    code = "ArrowRight";
  } else if (upper === "-" || upper === "MINUS") {
    code = "Minus";
  } else if (upper === "=" || upper === "EQUAL" || upper === "+") {
    code = "Equal";
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

/** Helper to convert keyboard events to shortcut string (e.g. "Ctrl+Shift+T" or "Cmd+Alt+W"). */
export function eventToBindingString(
  e:
    | KeyboardEvent
    | {
        key: string;
        code: string;
        ctrlKey: boolean;
        metaKey: boolean;
        altKey: boolean;
        shiftKey: boolean;
      },
  isMac: boolean = false
): string | null {
  const ctrlOrCmd = isMac ? e.metaKey : e.ctrlKey;
  const alt = e.altKey;
  const shift = e.shiftKey;

  const k = e.key;
  if (["Control", "Shift", "Alt", "Meta", "OS"].includes(k)) {
    return null;
  }

  // Must include a modifier
  if (!ctrlOrCmd && !alt) return null;

  const parts: string[] = [];
  if (ctrlOrCmd) parts.push(isMac ? "Cmd" : "Ctrl");
  if (alt) parts.push("Alt");
  if (shift) parts.push("Shift");

  if (k.length === 1 && /^[a-zA-Z0-9]$/.test(k)) {
    parts.push(k.toUpperCase());
  } else if (/^F([1-9]|1[0-2])$/i.test(k) || /^F([1-9]|1[0-2])$/.test(e.code)) {
    const f = (/^F([1-9]|1[0-2])$/i.exec(k) ?? /^F([1-9]|1[0-2])$/.exec(e.code))?.[0].toUpperCase();
    if (!f) return null;
    parts.push(f);
  } else if (k === "," || k === "." || k === "/" || k === "[" || k === "]") {
    parts.push(k);
  } else if (e.code.startsWith("Key")) {
    parts.push(e.code.replace("Key", ""));
  } else if (e.code.startsWith("Digit")) {
    parts.push(e.code.replace("Digit", ""));
  } else if (e.code === "Comma") {
    parts.push(",");
  } else if (e.code === "Period") {
    parts.push(".");
  } else if (e.code === "Slash") {
    parts.push("/");
  } else if (e.code === "BracketLeft") {
    parts.push("[");
  } else if (e.code === "BracketRight") {
    parts.push("]");
  } else {
    return null;
  }

  return parts.join("+");
}

/** True when a keyboard event matches a binding string. */
export function eventMatchesBinding(e: KeyboardEvent, binding: string): boolean {
  const parsed = parseBinding(binding);
  if (!parsed) return false;
  // Cross-OS: Ctrl (Win/Linux) and Cmd (macOS) are interchangeable so one
  // binding works everywhere without per-OS configuration.
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  if (parsed.ctrlOrCmd !== ctrlOrCmd) return false;
  if (parsed.alt !== e.altKey) return false;
  if (parsed.shift !== e.shiftKey) return false;
  if (parsed.code.startsWith("F") && /^F([1-9]|1[0-2])$/.test(parsed.code)) {
    return e.code === parsed.code || e.key === parsed.code;
  }
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
    return "Use Ctrl/Cmd and/or Alt plus a letter, digit, F1–F12, arrow, Tab, Enter, Esc, or , . / [ ] - = (e.g. Ctrl+Shift+T).";
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

/**
 * True when a keyboard event is a terminal copy combo AND there is a
 * selection to copy: Ctrl+Shift+C (Win/Linux), Cmd+C / Cmd+Shift+C (macOS),
 * or Ctrl+Insert (Win/Linux standard). Plain Ctrl+C is NOT copy — it must
 * keep reaching the shell as SIGINT. Shift+Insert is NOT copy either — it
 * is paste on every OS (see isPasteKeyEvent); the two sets are disjoint so
 * Shift+Insert pastes even while text is selected.
 */
export function isCopyKeyEvent(
  e: {
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    code: string;
  },
  hasSelection: boolean
): boolean {
  if (!hasSelection) return false;
  const mod = e.ctrlKey || e.metaKey;
  return (
    (mod && e.code === "KeyC" && (e.shiftKey || e.metaKey)) ||
    (e.ctrlKey && !e.metaKey && e.code === "Insert")
  );
}

/**
 * True when a keyboard event is a terminal paste combo: Ctrl+Shift+V
 * (Win/Linux), Cmd+V (macOS), or Shift+Insert (all OSes). Plain Ctrl+V is
 * NOT a paste combo — it must keep reaching the shell untouched.
 */
export function isPasteKeyEvent(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  code: string;
}): boolean {
  const mod = e.ctrlKey || e.metaKey;
  return (
    (mod && e.shiftKey && e.code === "KeyV") ||
    (e.metaKey && !e.ctrlKey && e.code === "KeyV") ||
    (e.shiftKey && e.code === "Insert")
  );
}
