// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalConfig } from "../hooks/useTerminalConfig";
import { DEFAULT_SETTINGS, SettingsService } from "../services/settingsService";

/**
 * FUNC-06: a theme / font / shortcut change saved in one Kai window was not applied in the
 * others until restart, and a later save from another window wrote its stale copy of every
 * setting back over it. Windows share one storage; the browser tells the others when it changes.
 */
vi.mock("../services/ptyService", () => ({
  isTauriAvailable: () => false,
  PtyService: { getAvailableShells: vi.fn(async () => []) },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let config: ReturnType<typeof useTerminalConfig>;
function Harness() {
  config = useTerminalConfig({ setLastError: vi.fn(), isSettingsOpen: false });
  return null;
}

let root: Root;
beforeEach(async () => {
  localStorage.clear();
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
});

/** What the browser does in window B when window A writes: update storage, then notify. */
function otherWindowSaves(next: typeof DEFAULT_SETTINGS) {
  SettingsService.saveSettings(next);
  const key = "kai_user_settings";
  window.dispatchEvent(
    new StorageEvent("storage", {
      key,
      newValue: localStorage.getItem(key),
      storageArea: localStorage,
    })
  );
}

describe("settings saved in another window", () => {
  it("are applied here without a restart", async () => {
    expect(config.userSettings.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    await act(async () =>
      otherWindowSaves({ ...DEFAULT_SETTINGS, fontSize: 19, theme: "kai-light" })
    );
    expect(config.userSettings.fontSize).toBe(19);
    expect(config.userSettings.theme).toBe("kai-light");
  });

  it("do not make this window write anything back (no save loop between windows)", async () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    await act(async () => otherWindowSaves({ ...DEFAULT_SETTINGS, fontSize: 17 }));
    // The helper's own save is the only write; applying the change must add none.
    expect(write).toHaveBeenCalledTimes(1);
    write.mockRestore();
  });

  it("ignore unrelated storage keys", async () => {
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "kai_something_else" }));
    });
    expect(config.userSettings.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
  });

  it("are listened for from the moment the window starts", async () => {
    await act(async () => root.unmount());
    const add = vi.spyOn(window, "addEventListener");
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness />));
    expect(add.mock.calls.some(([type]) => type === "storage")).toBe(true);
    add.mockRestore();
  });
});
