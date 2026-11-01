import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { TerminalTab } from "../types/terminal";

/**
 * Applies `update` to the tabs state AND to the live ref in one step.
 *
 * Long-lived callbacks (pty-exit listeners, Tauri events) decide from
 * `tabsRef`, which otherwise only catches up when React re-renders. Two events
 * handled before that render both saw the old list: the second `setTabs` then
 * overwrote the first, leaving a tab or pane whose shell had already exited
 * (dead, unclosable, ignoring input). Updating the ref immediately lets each
 * event build on the previous one.
 *
 * `update` must be pure: it runs once on the ref now and once more on React's
 * own latest state.
 */
export function applyTabsUpdate(
  tabsRef: MutableRefObject<TerminalTab[]>,
  setTabs: Dispatch<SetStateAction<TerminalTab[]>>,
  update: (tabs: TerminalTab[]) => TerminalTab[]
): void {
  tabsRef.current = update(tabsRef.current);
  setTabs(update);
}
