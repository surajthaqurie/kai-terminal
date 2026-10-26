import { isTauriAvailable } from "./ptyService";

/**
 * Text on the system clipboard, read by the backend through the OS so the
 * WebView never asks for clipboard permission ("Allow Kai to see text and
 * images copied to the clipboard?" on Windows, a Paste bubble on macOS).
 * Falls back to the WebView API when the backend cannot read it (browser dev
 * mode, or no clipboard tool installed on Linux).
 */
export async function readClipboardText(): Promise<string> {
  if (isTauriAvailable()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string>("read_clipboard_text_cmd");
    } catch {
      // fall through to the WebView API
    }
  }
  return navigator.clipboard.readText();
}
