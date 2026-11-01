// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useTerminalConfig } from "../hooks/useTerminalConfig";
import { pickDefaultShell } from "../services/paneShell";
import { DEFAULT_SETTINGS } from "../services/settingsService";
import type { ShellProfile } from "../types/terminal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SHELLS: ShellProfile[] = [
  { id: "cmd", name: "Command Prompt", path: "C:\Windows\cmd.exe", is_default: false },
  { id: "ps", name: "PowerShell", path: "C:\ps\pwsh.exe", is_default: true },
  { id: "zsh", name: "Zsh", path: "C:\zsh\zsh.exe", is_default: false },
];

describe("pickDefaultShell", () => {
  it("prefers the configured shell when it is detected", () => {
    expect(pickDefaultShell(SHELLS, "zsh")?.id).toBe("zsh");
  });
  it("treats an empty id as System Default", () => {
    expect(pickDefaultShell(SHELLS, "")?.id).toBe("ps");
    expect(pickDefaultShell(SHELLS, undefined)?.id).toBe("ps");
  });
  it("treats an id that is no longer installed as System Default", () => {
    expect(pickDefaultShell(SHELLS, "fish")?.id).toBe("ps");
  });
  it("falls back to the first shell when none is marked default, and to nothing when empty", () => {
    const none = SHELLS.map((s) => ({ ...s, is_default: false }));
    expect(pickDefaultShell(none, "")?.id).toBe("cmd");
    expect(pickDefaultShell([], "ps")).toBeUndefined();
  });
});

vi.mock("../services/ptyService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/ptyService")>();
  return {
    ...actual,
    isTauriAvailable: () => false,
    PtyService: { ...actual.PtyService, getAvailableShells: vi.fn(async () => SHELLS) },
  };
});

describe("useTerminalConfig.saveSettings: default shell", () => {
  let api: ReturnType<typeof useTerminalConfig>;
  let root: Root;
  function Probe() {
    api = useTerminalConfig({ setLastError: vi.fn(), isSettingsOpen: false });
    return null;
  }
  beforeEach(async () => {
    localStorage.clear();
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    await act(async () => {});
  });
  afterEach(() => act(() => root.unmount()));

  it("starts on the system default shell", () => {
    expect(api.selectedShellId).toBe("ps");
  });

  it("applies a newly chosen default shell to new sessions right away", async () => {
    await act(async () => api.saveSettings({ ...DEFAULT_SETTINGS, defaultShellId: "zsh" }));
    expect(api.selectedShellId).toBe("zsh");
  });

  it("switching back to System Default applies immediately instead of being ignored", async () => {
    await act(async () => api.saveSettings({ ...DEFAULT_SETTINGS, defaultShellId: "zsh" }));
    expect(api.selectedShellId).toBe("zsh");
    await act(async () => api.saveSettings({ ...DEFAULT_SETTINGS, defaultShellId: "" }));
    expect(api.selectedShellId).toBe("ps");
  });

  it("leaves the selection alone when the default did not change", async () => {
    await act(async () => api.setSelectedShellId("cmd"));
    await act(async () => api.saveSettings({ ...DEFAULT_SETTINGS, theme: "dracula" }));
    expect(api.selectedShellId).toBe("cmd");
  });
});
