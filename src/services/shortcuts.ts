import { FixedShortcutsConfig, KeybindingsConfig } from "../types/terminal";

export type ShortcutActionId = keyof KeybindingsConfig;
export type FixedActionId = keyof FixedShortcutsConfig;
export type AnyShortcutId = ShortcutActionId | FixedActionId;

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
  toggleMusic: "Toggle Music Time",
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

const F_KEY = /^F([1-9]|1[0-2])$/;

/**
 * Parse "Ctrl+Shift+T" / "Cmd+Alt+V" / "Ctrl+," / "F5" / "Shift+F5" into parts.
 * Returns null when invalid. A binding needs Ctrl/Cmd or Alt, except a function
 * key, which may stand alone (or with Shift): bare letters and other typing
 * keys must stay with the terminal.
 */
export function parseBinding(binding: string): ParsedBinding | null {
  const trimmed = binding.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("+").map((p) => p.trim());
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
  const upper = last.toUpperCase();
  if (!ctrlOrCmd && !alt && !F_KEY.test(upper)) return null;
  let code: string;
  let key = last;
  if (F_KEY.test(upper)) {
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
  } else if (upper === "HOME") {
    code = "Home";
  } else if (upper === "END") {
    code = "End";
  } else if (upper === "INSERT" || upper === "INS") {
    code = "Insert";
  } else if (upper === "PAGEUP" || upper === "PGUP") {
    code = "PageUp";
  } else if (upper === "PAGEDOWN" || upper === "PGDN") {
    code = "PageDown";
  } else if (upper === "-" || upper === "MINUS") {
    code = "Minus";
  } else if (upper === "=" || upper === "EQUAL" || upper === "+") {
    code = "Equal";
  } else {
    return null;
  }
  return { ctrlOrCmd, alt, shift, code, key };
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

  const fKey = (/^F([1-9]|1[0-2])$/i.exec(k) ?? F_KEY.exec(e.code))?.[0].toUpperCase();

  // Must include Ctrl/Cmd or Alt — except a function key, which may stand alone.
  if (!ctrlOrCmd && !alt && !fKey) return null;

  const parts: string[] = [];
  if (ctrlOrCmd) parts.push(isMac ? "Cmd" : "Ctrl");
  if (alt) parts.push("Alt");
  if (shift) parts.push("Shift");

  if (k.length === 1 && /^[a-zA-Z0-9]$/.test(k)) {
    parts.push(k.toUpperCase());
  } else if (fKey) {
    parts.push(fKey);
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
  } else if (k === "-" || e.code === "Minus") {
    parts.push("-");
  } else if (k === "=" || e.code === "Equal") {
    parts.push("=");
  } else if (RECORDABLE_NAMED_KEYS.has(e.code)) {
    parts.push(e.code);
  } else {
    return null;
  }

  return parts.join("+");
}

/** Navigation keys the shortcut recorder can capture by their `code`. */
const RECORDABLE_NAMED_KEYS = new Set(["Home", "End", "Insert", "PageUp", "PageDown"]);

/** Subset of a keyboard event the matchers read; `KeyboardEvent` satisfies it. */
type KeyLike = {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
  shiftKey: boolean;
  code: string;
  key?: string;
};

/** True when a keyboard event matches a binding string. */
export function eventMatchesBinding(e: KeyLike, binding: string): boolean {
  const parsed = parseBinding(binding);
  if (!parsed) return false;
  // Cross-OS: Ctrl (Win/Linux) and Cmd (macOS) are interchangeable so one
  // binding works everywhere without per-OS configuration.
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  if (parsed.ctrlOrCmd !== ctrlOrCmd) return false;
  if (parsed.alt !== Boolean(e.altKey)) return false;
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
  for (const action of Object.keys(bindings) as ShortcutActionId[]) {
    const binding = bindings[action];
    if (typeof binding === "string" && eventMatchesBinding(e, binding)) {
      return action;
    }
  }
  return null;
}

function comboKey(parsed: ParsedBinding): string {
  return `${parsed.ctrlOrCmd ? "C" : ""}${parsed.alt ? "A" : ""}${parsed.shift ? "S" : ""}:${parsed.code}`;
}

/**
 * Detect conflicting bindings (two actions sharing one normalized combo).
 * With `fixed`, the remappable terminal shortcuts take part too, so a user
 * binding cannot silently shadow zoom / copy / paste / tab jump.
 */
export function findConflicts(
  bindings: KeybindingsConfig,
  fixed?: Partial<FixedShortcutsConfig>
): Array<{
  binding: string;
  actions: AnyShortcutId[];
}> {
  const byCombo = new Map<string, AnyShortcutId[]>();
  const labels = new Map<AnyShortcutId, string>();
  const add = (key: string, action: AnyShortcutId) => {
    const list = byCombo.get(key) ?? [];
    if (!list.includes(action)) list.push(action);
    byCombo.set(key, list);
  };
  for (const action of Object.keys(bindings) as ShortcutActionId[]) {
    const raw = bindings[action];
    if (typeof raw !== "string") continue;
    const parsed = parseBinding(raw);
    if (!parsed) continue;
    labels.set(action, raw);
    add(comboKey(parsed), action);
  }
  if (fixed) {
    for (const action of Object.keys(DEFAULT_FIXED_SHORTCUTS) as FixedActionId[]) {
      // An entry still being typed (unparsable) is skipped; its own error shows.
      const raw = fixed[action] ?? DEFAULT_FIXED_SHORTCUTS[action];
      const parsed = parseBinding(raw);
      if (!parsed) continue;
      labels.set(action, raw);
      if (action === "tabJump") {
        // The binding names the modifiers; every digit 1-9 follows them.
        for (let d = 1; d <= 9; d++) add(comboKey({ ...parsed, code: `Digit${d}` }), action);
      } else {
        add(comboKey(parsed), action);
      }
    }
  }
  const out: Array<{ binding: string; actions: AnyShortcutId[] }> = [];
  for (const [, actions] of byCombo) {
    if (actions.length > 1) {
      out.push({
        binding: actions.map((a) => labels.get(a)).join(" / "),
        actions,
      });
    }
  }
  return out;
}

/** The review-changes shortcut; handled before user bindings, so it is not remappable. */
export const REVIEW_CHANGES_BINDING = "Ctrl+Shift+G";

/**
 * Combos the app claims before it looks at user bindings (see useAppShortcuts).
 * A user binding on one of these would never fire, so Settings rejects it.
 * `ownedBy` names the one action that may use a combo (the new-tab accelerator
 * is also the default New tab binding).
 */
export const RESERVED_SHORTCUTS: ReadonlyArray<{
  binding: string;
  label: string;
  ownedBy?: ShortcutActionId;
}> = [
  { binding: REVIEW_CHANGES_BINDING, label: "Review git changes" },
  { binding: "Ctrl+T", label: "New tab", ownedBy: "newTab" },
  { binding: "Ctrl+Shift+T", label: "New tab", ownedBy: "newTab" },
];

/** Actions bound to a combo the app handles itself, with the label of what owns it. */
export function findReservedConflicts(
  bindings: KeybindingsConfig
): Array<{ action: ShortcutActionId; binding: string; reservedFor: string }> {
  const out: Array<{ action: ShortcutActionId; binding: string; reservedFor: string }> = [];
  for (const reserved of RESERVED_SHORTCUTS) {
    const parsedReserved = parseBinding(reserved.binding);
    if (!parsedReserved) continue;
    for (const action of Object.keys(bindings) as ShortcutActionId[]) {
      if (action === reserved.ownedBy) continue;
      const raw = bindings[action];
      const parsed = typeof raw === "string" ? parseBinding(raw) : null;
      if (parsed && comboKey(parsed) === comboKey(parsedReserved)) {
        out.push({ action, binding: raw, reservedFor: reserved.label });
      }
    }
  }
  return out;
}

/** Validate one binding string; returns an error message or null when valid. */
export function validateBinding(value: string): string | null {
  if (!value.trim()) return "Binding must not be empty.";
  const parsed = parseBinding(value);
  if (!parsed) {
    return "Use F1–F12 on its own, or Ctrl/Cmd and/or Alt plus a letter, digit, F1–F12, arrow, Home, End, Insert, PageUp, PageDown, Tab, Enter, Esc, or , . / [ ] - = (e.g. Ctrl+Shift+T).";
  }
  return null;
}

/** Like {@link validateBinding}, plus the tab-jump rule (modifiers + a digit 1-9). */
export function validateFixedBinding(id: FixedActionId, value: string): string | null {
  const base = validateBinding(value);
  if (base) return base;
  if (id === "tabJump") {
    const parsed = parseBinding(value);
    if (!parsed || !/^Digit[1-9]$/.test(parsed.code)) {
      return "Tab jump needs a digit 1–9 after the modifiers (e.g. Ctrl+1); digits 1–8 pick that tab, 9 the last one.";
    }
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

/** Defaults of the remappable terminal shortcuts (Ctrl and Cmd are interchangeable). */
export const DEFAULT_FIXED_SHORTCUTS: Readonly<FixedShortcutsConfig> = {
  zoomIn: "Ctrl+=",
  zoomOut: "Ctrl+-",
  zoomReset: "Ctrl+0",
  copy: "Ctrl+Shift+C",
  paste: "Ctrl+Shift+V",
  selectAll: "Ctrl+Shift+A",
  clearTerminal: "Ctrl+Shift+K",
  scrollTop: "Ctrl+Shift+Home",
  scrollBottom: "Ctrl+Shift+End",
  tabJump: "Ctrl+1",
};

export const FIXED_ACTION_LABELS: Record<FixedActionId, string> = {
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoomReset: "Reset zoom",
  copy: "Copy selection (Ctrl+C stays interrupt)",
  paste: "Paste",
  selectAll: "Select all output",
  clearTerminal: "Clear terminal",
  scrollTop: "Scroll to top",
  scrollBottom: "Scroll to bottom",
  tabJump: "Jump to tab (digits 1–8 pick a tab, 9 the last)",
};

/**
 * Full config from a possibly partial / corrupted one: any entry that is not
 * a parsable binding falls back to its default.
 */
export function resolveFixedBindings(
  input?: Partial<FixedShortcutsConfig> | null
): FixedShortcutsConfig {
  const out = { ...DEFAULT_FIXED_SHORTCUTS };
  if (!input) return out;
  for (const id of Object.keys(out) as FixedActionId[]) {
    const v = input[id];
    if (typeof v !== "string" || !parseBinding(v)) continue;
    if (id === "tabJump" && validateFixedBinding(id, v)) continue;
    out[id] = v.trim();
  }
  return out;
}

const mod = (e: KeyLike) => e.ctrlKey || e.metaKey;

/**
 * What each action did while it was fixed. A binding left at its default keeps
 * this exact behaviour (numpad aliases, Cmd+C / Cmd+V on macOS, Shift+Ctrl+=),
 * so remapping is purely additive for everyone who never opens Settings.
 */
const DEFAULT_MATCHERS: Record<FixedActionId, (e: KeyLike) => boolean> = {
  zoomIn: (e) => mod(e) && !e.altKey && (e.code === "Equal" || e.code === "NumpadAdd"),
  zoomOut: (e) => mod(e) && !e.altKey && (e.code === "Minus" || e.code === "NumpadSubtract"),
  zoomReset: (e) =>
    mod(e) && !e.altKey && !e.shiftKey && (e.code === "Digit0" || e.code === "Numpad0"),
  copy: (e) =>
    (mod(e) && e.code === "KeyC" && (e.shiftKey || e.metaKey)) ||
    (e.ctrlKey && !e.metaKey && e.code === "Insert"),
  paste: (e) =>
    (mod(e) && e.shiftKey && e.code === "KeyV") ||
    (e.metaKey && !e.ctrlKey && e.code === "KeyV") ||
    (e.shiftKey && e.code === "Insert"),
  selectAll: (e) => mod(e) && e.shiftKey && !e.altKey && e.code === "KeyA",
  clearTerminal: (e) => mod(e) && e.shiftKey && !e.altKey && e.code === "KeyK",
  scrollTop: (e) => mod(e) && e.shiftKey && !e.altKey && e.code === "Home",
  scrollBottom: (e) => mod(e) && e.shiftKey && !e.altKey && e.code === "End",
  tabJump: (e) => mod(e) && !e.altKey && !e.shiftKey && /^(?:Digit|Numpad)[1-9]$/.test(e.code),
};

/** Standard alternates that stay available when copy / paste are remapped. */
const ALTERNATE_MATCHERS: Partial<Record<FixedActionId, (e: KeyLike) => boolean>> = {
  copy: (e) => e.ctrlKey && !e.metaKey && e.code === "Insert",
  paste: (e) => e.shiftKey && e.code === "Insert",
};

function isDefaultFixed(id: FixedActionId, bindings?: Partial<FixedShortcutsConfig> | null) {
  const value = bindings?.[id];
  const custom = typeof value === "string" ? parseBinding(value) : null;
  if (!custom) return true;
  const base = parseBinding(DEFAULT_FIXED_SHORTCUTS[id]);
  return base !== null && comboKey(custom) === comboKey(base);
}

/** Matches one remappable action: the old behaviour at the default, the user's combo otherwise. */
function fixedMatches(
  e: KeyLike,
  id: FixedActionId,
  bindings?: Partial<FixedShortcutsConfig> | null
): boolean {
  if (isDefaultFixed(id, bindings)) return DEFAULT_MATCHERS[id](e);
  const binding = bindings?.[id] as string;
  if (id === "tabJump") {
    const parsed = parseBinding(binding);
    return (
      parsed !== null &&
      /^(?:Digit|Numpad)[1-9]$/.test(e.code) &&
      parsed.ctrlOrCmd === mod(e) &&
      parsed.alt === Boolean(e.altKey) &&
      parsed.shift === e.shiftKey
    );
  }
  return eventMatchesBinding(e, binding) || (ALTERNATE_MATCHERS[id]?.(e) ?? false);
}

/**
 * True when a keyboard event is a terminal copy combo AND there is a
 * selection to copy: Ctrl+Shift+C (Win/Linux), Cmd+C / Cmd+Shift+C (macOS),
 * or Ctrl+Insert (Win/Linux standard) by default, or the user's own binding
 * (Ctrl+Insert keeps working). Plain Ctrl+C is NOT copy unless the user maps
 * it — it must keep reaching the shell as SIGINT. Shift+Insert is NOT copy
 * either — it is paste on every OS (see isPasteKeyEvent); the two sets are
 * disjoint so Shift+Insert pastes even while text is selected.
 */
export function isCopyKeyEvent(
  e: KeyLike,
  hasSelection: boolean,
  bindings?: Partial<FixedShortcutsConfig> | null
): boolean {
  if (!hasSelection) return false;
  return fixedMatches(e, "copy", bindings);
}

/**
 * True when a keyboard event is a terminal paste combo: Ctrl+Shift+V
 * (Win/Linux), Cmd+V (macOS), or Shift+Insert (all OSes) by default, or the
 * user's own binding (Shift+Insert keeps working). Plain Ctrl+V is NOT a
 * paste combo unless the user maps it — it must keep reaching the shell.
 */
export function isPasteKeyEvent(e: KeyLike, bindings?: Partial<FixedShortcutsConfig> | null) {
  return fixedMatches(e, "paste", bindings);
}

/** App-level shortcuts that work like a browser / Windows Terminal. */
export type BuiltinShortcut =
  { type: "zoom"; delta: 1 | -1 | 0 } | { type: "gotoTab"; index: number | "last" };

const ZOOM_ACTIONS: ReadonlyArray<[FixedActionId, 1 | -1 | 0]> = [
  ["zoomIn", 1],
  ["zoomOut", -1],
  ["zoomReset", 0],
];

/**
 * By default Ctrl/Cmd + `=` / `-` / `0` zoom the terminal font in / out / back
 * to the saved size; Ctrl/Cmd + 1-8 jump to that tab and 9 to the last tab.
 * Plain Ctrl+digit never produces shell text, so claiming it is safe. All of
 * them can be remapped through `bindings` (the tab-jump binding names the
 * modifiers; digits 1-9 follow them).
 */
export function matchBuiltinShortcut(
  e: KeyLike,
  bindings?: Partial<FixedShortcutsConfig> | null
): BuiltinShortcut | null {
  for (const [id, delta] of ZOOM_ACTIONS) {
    if (fixedMatches(e, id, bindings)) return { type: "zoom", delta };
  }
  if (fixedMatches(e, "tabJump", bindings)) {
    const n = Number(/([1-9])$/.exec(e.code)?.[1]);
    return { type: "gotoTab", index: n === 9 ? "last" : n - 1 };
  }
  return null;
}

/** Terminal-local actions that must not reach the shell. */
export type TerminalLocalAction = "selectAll" | "clear" | "scrollTop" | "scrollBottom";

const TERMINAL_ACTIONS: ReadonlyArray<[FixedActionId, TerminalLocalAction]> = [
  ["selectAll", "selectAll"],
  ["clearTerminal", "clear"],
  ["scrollTop", "scrollTop"],
  ["scrollBottom", "scrollBottom"],
];

/**
 * By default Ctrl+Shift+A select all, Ctrl+Shift+K clear, Ctrl+Shift+Home /
 * End scroll to top / bottom of the scrollback (Cmd+Shift+... on macOS), or
 * the user's own bindings. Plain Ctrl+A / Ctrl+K are readline line-editing
 * keys and are deliberately left alone.
 */
export function matchTerminalAction(
  e: KeyLike,
  bindings?: Partial<FixedShortcutsConfig> | null
): TerminalLocalAction | null {
  for (const [id, action] of TERMINAL_ACTIONS) {
    if (fixedMatches(e, id, bindings)) return action;
  }
  return null;
}

/** Shortcuts that stay fixed, shown read-only in Settings (Cmd replaces Ctrl on macOS). */
export const FIXED_SHORTCUT_HELP: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: "Ctrl+Insert / Shift+Insert", label: "Copy / paste (alternate)" },
  { keys: "Shift+PageUp / PageDown", label: "Scroll one page" },
  { keys: REVIEW_CHANGES_BINDING, label: "Review git changes" },
  { keys: "Ctrl+T / Ctrl+Shift+T", label: "New tab (always available)" },
];

/** Next zoomed font size, clamped to the same 8-36 range settings enforce. */
export function zoomedFontSize(current: number, delta: 1 | -1 | 0, base: number): number {
  const next = delta === 0 ? base : current + delta;
  return Math.max(8, Math.min(36, Math.round(next)));
}

/** True for xterm's hidden input — it is a textarea, but it IS the terminal. */
export function isXtermInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.classList.contains("xterm-helper-textarea");
}
