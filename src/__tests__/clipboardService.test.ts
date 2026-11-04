import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
let tauri = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => tauri }));

import {
  formatPastedPaths,
  quotePathForShell,
  readClipboardAttachments,
  readClipboardText,
  readPasteContent,
} from "../services/clipboardService";

describe("readClipboardText", () => {
  const readText = vi.fn();

  beforeEach(() => {
    invoke.mockReset();
    readText.mockReset();
    tauri = true;
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { readText } },
      configurable: true,
    });
  });

  it("reads through the backend so the WebView never prompts for permission", async () => {
    invoke.mockResolvedValue("from os");
    await expect(readClipboardText()).resolves.toBe("from os");
    expect(invoke).toHaveBeenCalledWith("read_clipboard_text_cmd");
    expect(readText).not.toHaveBeenCalled();
  });

  it("falls back to the WebView API when the backend cannot read it", async () => {
    invoke.mockRejectedValue("Install wl-clipboard, xclip or xsel to paste");
    readText.mockResolvedValue("from webview");
    await expect(readClipboardText()).resolves.toBe("from webview");
  });

  it("uses the WebView API outside Tauri (browser dev mode)", async () => {
    tauri = false;
    readText.mockResolvedValue("dev");
    await expect(readClipboardText()).resolves.toBe("dev");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("pasting files and images", () => {
  const readText = vi.fn();

  beforeEach(() => {
    invoke.mockReset();
    readText.mockReset();
    tauri = true;
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { readText }, platform: "Win32", userAgent: "Windows" },
      configurable: true,
    });
  });

  it("asks the backend for the paths of copied files or a saved image", async () => {
    const shot = String.raw`C:\Users\me\shot.png`;
    invoke.mockResolvedValue([shot, ""]);
    await expect(readClipboardAttachments()).resolves.toEqual([shot]);
    expect(invoke).toHaveBeenCalledWith("read_clipboard_attachments_cmd");
  });

  it("gives no paths outside the desktop app or when the backend fails", async () => {
    tauri = false;
    await expect(readClipboardAttachments()).resolves.toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
    tauri = true;
    invoke.mockRejectedValue("boom");
    await expect(readClipboardAttachments()).resolves.toEqual([]);
  });

  it("pastes text when there is text, never the file paths", async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "read_clipboard_text_cmd" ? "hello" : [String.raw`C:\a.png`])
    );
    await expect(readPasteContent()).resolves.toBe("hello");
    expect(invoke).not.toHaveBeenCalledWith("read_clipboard_attachments_cmd");
  });

  it("pastes the paths when the clipboard has no text (a copied image or file)", async () => {
    const png = String.raw`C:\Temp\kai paste\p.png`;
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "read_clipboard_text_cmd" ? "" : [png])
    );
    await expect(readPasteContent()).resolves.toBe(`"${png}" `);
  });

  it("pastes nothing when the clipboard is empty", async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "read_clipboard_text_cmd" ? "" : [])
    );
    await expect(readPasteContent()).resolves.toBe("");
  });
});

describe("quotePathForShell / formatPastedPaths", () => {
  it("leaves plain paths alone and quotes the rest on Windows", () => {
    const plain = String.raw`C:\Users\me\a.png`;
    const spaced = String.raw`C:\My Files\a b.png`;
    const amp = String.raw`C:\a&b.png`;
    expect(quotePathForShell(plain, true)).toBe(plain);
    expect(quotePathForShell(spaced, true)).toBe(`"${spaced}"`);
    expect(quotePathForShell(amp, true)).toBe(`"${amp}"`);
  });

  it("single-quotes on macOS and Linux and escapes embedded quotes", () => {
    expect(quotePathForShell("/home/me/a.png", false)).toBe("/home/me/a.png");
    expect(quotePathForShell("/home/me/My Shot.png", false)).toBe("'/home/me/My Shot.png'");
    expect(quotePathForShell("/tmp/it's;rm -rf.png", false)).toBe(
      String.raw`'/tmp/it'\''s;rm -rf.png'`
    );
    expect(quotePathForShell("/tmp/$(whoami).png", false)).toBe("'/tmp/$(whoami).png'");
  });

  it("joins several paths with a trailing space and never a newline", () => {
    expect(formatPastedPaths(["/a/b.png", "/a/c d.txt"], false)).toBe("/a/b.png '/a/c d.txt' ");
    expect(formatPastedPaths([], false)).toBe("");
    expect(formatPastedPaths(["/a/b\n.png"], false)).not.toMatch(/\n$/);
  });
});
