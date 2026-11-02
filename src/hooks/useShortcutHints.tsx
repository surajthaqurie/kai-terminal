import { createContext, useContext, type ReactNode } from "react";
import {
  SHORTCUT_ACTION_LABELS,
  platformLabel,
  withKeys,
  type ShortcutActionId,
} from "../services/shortcuts";
import type { KeybindingsConfig } from "../types/terminal";

/** Display text (Cmd / Option on macOS) of every remappable shortcut, by action. */
export type ShortcutHints = Partial<Record<ShortcutActionId, string>>;

const ShortcutHintsContext = createContext<ShortcutHints>({});

/** Builds the hint text for every action from the user's CURRENT bindings. */
export function buildShortcutHints(bindings: KeybindingsConfig, isMac: boolean): ShortcutHints {
  const out: ShortcutHints = {};
  for (const id of Object.keys(SHORTCUT_ACTION_LABELS) as ShortcutActionId[]) {
    const binding = bindings[id];
    if (typeof binding === "string" && binding.trim()) out[id] = platformLabel(binding, isMac);
  }
  return out;
}

/**
 * Supplies the current shortcuts to every button that has one, so a tooltip says
 * "New tab (Ctrl+Shift+T)" and follows a remap in Settings without each
 * component being handed the bindings.
 */
export function ShortcutHintsProvider({
  hints,
  children,
}: {
  hints: ShortcutHints;
  children: ReactNode;
}) {
  return <ShortcutHintsContext.Provider value={hints}>{children}</ShortcutHintsContext.Provider>;
}

/**
 * Tooltip text for a button: `title` plus the current key for `action`
 * (and any `extra` fixed keys). Without a provider it is just the title.
 */
export function useShortcutTitle(): (
  title: string,
  action?: ShortcutActionId,
  ...extra: string[]
) => string {
  const hints = useContext(ShortcutHintsContext);
  return (title, action, ...extra) => withKeys(title, action ? hints[action] : undefined, ...extra);
}
