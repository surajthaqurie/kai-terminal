// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "../services/clipboardService";

/** FUNC-10: copying with the clipboard permission denied must never be an unhandled rejection. */
const setClipboard = (writeText: ((t: string) => Promise<void>) | undefined) =>
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });

afterEach(() => {
  setClipboard(undefined);
  Reflect.deleteProperty(document, "execCommand");
});

describe("copyTextToClipboard", () => {
  it("uses the clipboard API when it works", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard(writeText);
    expect(await copyTextToClipboard("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when access is denied, and reports the result", async () => {
    setClipboard(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    expect(await copyTextToClipboard("secret text")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull(); // the helper field is cleaned up
  });

  it("resolves false, without throwing, when nothing works (no clipboard object at all)", async () => {
    setClipboard(undefined);
    document.execCommand = () => {
      throw new Error("unsupported");
    };
    await expect(copyTextToClipboard("x")).resolves.toBe(false);
  });
});
