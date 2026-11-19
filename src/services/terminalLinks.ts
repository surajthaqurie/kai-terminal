import { isTauriAvailable } from "./ptyService";

/**
 * Links in terminal output open on Ctrl+click (Cmd+click on macOS), like
 * VS Code and Windows Terminal. A plain click is left alone so selecting text
 * and clicking inside a mouse-aware TUI keep working.
 */
export function isOpenLinkClick(event: Pick<MouseEvent, "ctrlKey" | "metaKey">): boolean {
  return event.ctrlKey || event.metaKey;
}

/**
 * Keeps a Ctrl/Cmd+click on a recognised link away from the running program.
 *
 * Why: when a TUI turns on mouse tracking (Claude Code, `kai teams`, vim...),
 * xterm forwards EVERY mousedown to the pty — Ctrl does not stop it, only
 * Shift does. Programs that open links themselves then open the same URL a
 * second time, so one click produced two browser tabs.
 *
 * How: listen on xterm's screen element, which is where its Linkifier records
 * the pressed link. Our listener is added after the Linkifier's, so it runs
 * second on that element and can stop the event before it bubbles up to the
 * terminal element, where xterm sends the mouse report to the pty. Link
 * activation itself (on mouseup) is untouched, so the link opens exactly once.
 */
export function guardLinkClicks(
  screenElement: HTMLElement,
  isOverLink: () => boolean,
  focus: () => void
): () => void {
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || !isOpenLinkClick(event) || !isOverLink()) return;
    event.stopPropagation();
    // What xterm's own (now skipped) handler would have done.
    event.preventDefault();
    focus();
  };
  screenElement.addEventListener("mousedown", onMouseDown);
  return () => screenElement.removeEventListener("mousedown", onMouseDown);
}

/**
 * Open a link from terminal output in the OS browser. The desktop app hands
 * it to the backend, which re-validates it (http/https only, a real host, no
 * shell involved); browser dev mode uses window.open.
 */
export async function openTerminalLink(url: string): Promise<void> {
  if (isTauriAvailable()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_terminal_link_cmd", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
