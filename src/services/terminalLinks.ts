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
