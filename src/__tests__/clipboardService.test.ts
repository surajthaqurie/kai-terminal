import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
let tauri = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => tauri }));

import {
  CLIPBOARD_PIECE_BYTES,
  formatPastedPaths,
  quotePathForShell,
  readClipboardAttachments,
  readClipboardText,
  readPasteContent,
} from "../services/clipboardService";

/** A fake backend that holds `text` and returns it `pieceChars` characters at a time. */
function fakeBackend(text: string, attachments: string[] = [], pieceChars = 4) {
  // By code point, as the backend cuts only at a char (Unicode scalar) boundary.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const chars = [...text];
  const enc = new TextEncoder();
  const byteOffsets: number[] = [0];
  for (const c of chars)
    byteOffsets.push(byteOffsets[byteOffsets.length - 1] + enc.encode(c).length);
  const state = { ended: [] as number[], maxAsked: [] as number[] };
  invoke.mockImplementation((cmd: string, args?: Record<string, number>) => {
    if (cmd === "clipboard_text_begin_cmd")
      return Promise.resolve({ id: 7, len: byteOffsets[chars.length] });
    if (cmd === "clipboard_text_chunk_cmd") {
      state.maxAsked.push(args!.max);
      const from = byteOffsets.indexOf(args!.offset);
      const to = Math.min(from + pieceChars, chars.length);
      return Promise.resolve({ text: chars.slice(from, to).join(""), next: byteOffsets[to] });
    }
    if (cmd === "clipboard_text_end_cmd") {
      state.ended.push(args!.id);
      return Promise.resolve();
    }
    if (cmd === "read_clipboard_attachments_cmd") return Promise.resolve(attachments);
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
  return state;
}

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
    fakeBackend("from os");
    await expect(readClipboardText()).resolves.toBe("from os");
    expect(invoke).toHaveBeenCalledWith("clipboard_text_begin_cmd");
    expect(readText).not.toHaveBeenCalled();
  });

  it("stitches pieces back into the exact text, multi-byte characters included", async () => {
    const text = "héllo 世界 😀 end\r\n".repeat(20);
    const state = fakeBackend(text, [], 5);
    await expect(readClipboardText()).resolves.toBe(text);
    expect(state.maxAsked.every((m) => m === CLIPBOARD_PIECE_BYTES)).toBe(true);
    expect(state.maxAsked.length).toBeGreaterThan(10);
  });

  it("is not cut off at any size (a paste past the old 32 MB cap)", async () => {
    // ASCII only, so byte offsets equal character offsets and no per-character tables are needed.
    const text = "x".repeat(40 * 1024 * 1024);
    invoke.mockImplementation((cmd: string, args?: Record<string, number>) => {
      if (cmd === "clipboard_text_begin_cmd") return Promise.resolve({ id: 1, len: text.length });
      if (cmd === "clipboard_text_chunk_cmd") {
        const next = Math.min(args!.offset + args!.max, text.length);
        return Promise.resolve({ text: text.slice(args!.offset, next), next });
      }
      return Promise.resolve();
    });
    const out = await readClipboardText();
    expect(out.length).toBe(text.length);
    const chunkCalls = invoke.mock.calls.filter(([c]) => c === "clipboard_text_chunk_cmd");
    expect(chunkCalls.length).toBe(10); // 40 MB in 4 MB pieces
  });

  it("releases the held text, even when a piece fails", async () => {
    const state = fakeBackend("abcdefgh");
    const base = invoke.getMockImplementation()!;
    let calls = 0;
    invoke.mockImplementation((cmd: string, args?: Record<string, number>) => {
      if (cmd === "clipboard_text_chunk_cmd" && ++calls === 2) return Promise.reject("gone");
      return base(cmd, args);
    });
    readText.mockResolvedValue("from webview");
    await expect(readClipboardText()).resolves.toBe("from webview");
    expect(state.ended).toEqual([7]);
  });

  it("reads an empty clipboard as an empty string", async () => {
    fakeBackend("");
    await expect(readClipboardText()).resolves.toBe("");
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
    fakeBackend("hello", [String.raw`C:\a.png`]);
    await expect(readPasteContent()).resolves.toBe("hello");
    expect(invoke).not.toHaveBeenCalledWith("read_clipboard_attachments_cmd");
  });

  it("pastes the paths when the clipboard has no text (a copied image or file)", async () => {
    const png = String.raw`C:\Temp\kai paste\p.png`;
    fakeBackend("", [png]);
    await expect(readPasteContent()).resolves.toBe(`"${png}" `);
  });

  it("pastes nothing when the clipboard is empty", async () => {
    fakeBackend("", []);
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
