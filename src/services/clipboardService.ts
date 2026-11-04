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

/**
 * Paths of files copied in a file manager, or of a PNG the backend saved from
 * a copied image (a screenshot, "Copy image" in a browser). Empty when the
 * clipboard holds neither, outside the desktop app, or when it cannot be read.
 */
export async function readClipboardAttachments(): Promise<string[]> {
  if (!isTauriAvailable()) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const paths = await invoke<string[]>("read_clipboard_attachments_cmd");
    return Array.isArray(paths) ? paths.filter((p) => typeof p === "string" && p !== "") : [];
  } catch {
    return [];
  }
}

/** True on a Windows host (macOS reports "Darwin", which must not match). */
export function isWindowsHost(): boolean {
  try {
    return /^win/i.test(navigator.platform ?? "") || /Windows/i.test(navigator.userAgent ?? "");
  } catch {
    return false;
  }
}

/**
 * One path as a single shell word. Plain paths stay as they are; anything with
 * spaces or shell-special characters is quoted: double quotes on Windows (a
 * path cannot contain `"` there; works in cmd and PowerShell), single quotes
 * elsewhere with embedded `'` escaped, so nothing in a file name can run.
 */
export function quotePathForShell(path: string, windows: boolean): string {
  if (windows) {
    return /^[A-Za-z0-9_\-.:\\/]+$/.test(path) ? path : `"${path}"`;
  }
  if (/^[A-Za-z0-9_\-.,:/@%+=~]+$/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Pasted paths as text for the prompt: quoted, space-separated, with a
 * trailing space so the user can keep typing. Never ends in a newline, so a
 * paste cannot run anything.
 */
export function formatPastedPaths(paths: readonly string[], windows: boolean): string {
  if (paths.length === 0) return "";
  return paths.map((p) => quotePathForShell(p, windows)).join(" ") + " ";
}

/** Clipboard attachments as paste text ("" when there are none). */
export async function readAttachmentPasteText(): Promise<string> {
  return formatPastedPaths(await readClipboardAttachments(), isWindowsHost());
}

/**
 * Everything a paste should insert: the clipboard text, or, when the clipboard
 * holds no text, the paths of the copied files / the saved copied image.
 */
export async function readPasteContent(): Promise<string> {
  let text = "";
  try {
    text = await readClipboardText();
  } catch {
    // no text available: fall through to files and images
  }
  return text || readAttachmentPasteText();
}
