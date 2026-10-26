import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
let tauri = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => tauri }));

import { readClipboardText } from "../services/clipboardService";

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
