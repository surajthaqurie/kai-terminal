import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
let tauri = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => tauri }));

import { isOpenLinkClick, openTerminalLink } from "../services/terminalLinks";

describe("terminal links", () => {
  beforeEach(() => {
    invoke.mockReset();
    tauri = true;
  });

  it("opens only on Ctrl+click or Cmd+click, never a plain click", () => {
    expect(isOpenLinkClick({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(isOpenLinkClick({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(isOpenLinkClick({ ctrlKey: false, metaKey: false })).toBe(false);
  });

  it("hands the link to the validating backend command in the desktop app", async () => {
    invoke.mockResolvedValue(undefined);
    await openTerminalLink("https://example.com/a?b=1&c=2");
    expect(invoke).toHaveBeenCalledWith("open_terminal_link_cmd", {
      url: "https://example.com/a?b=1&c=2",
    });
  });

  it("uses window.open in browser dev mode", async () => {
    tauri = false;
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    await openTerminalLink("https://example.com");
    expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
    expect(invoke).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
