// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseAsset } from "../services/updateService";

const invoke = vi.fn();

vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));

import {
  UPDATE_PENDING_KEY,
  applyInstallHint,
  clearUpdatePending,
  consumeUpdateOutcome,
  downloadAndInstallUpdate,
  markUpdatePending,
} from "../services/updateService";

function asset(name: string): ReleaseAsset {
  return {
    name,
    browser_download_url: `https://github.com/surajthaqurie/kai-terminal/releases/download/v9.9.9/${name}`,
    size: 1024,
    content_type: null,
  };
}

const exe = asset("kai_9.9.9_x64-setup.exe");
const msi = asset("kai_9.9.9_x64_en-US.msi");
const deb = asset("kai_9.9.9_amd64.deb");
const image = asset("kai_9.9.9_amd64.AppImage");
const all = [exe, msi, deb, image];

describe("applyInstallHint", () => {
  it("keeps the default pick without a hint", () => {
    expect(applyInstallHint(exe, all, null)).toBe(exe);
  });

  it("updates the AppImage when running from one (not a second system .deb)", () => {
    expect(applyInstallHint(deb, all, "appimage")).toBe(image);
  });

  it("updates through the MSI when Kai was installed by it", () => {
    expect(applyInstallHint(exe, all, "msi")).toBe(msi);
  });

  it("falls back to the default pick when the matching installer is missing", () => {
    expect(applyInstallHint(deb, [deb], "appimage")).toBe(deb);
    expect(applyInstallHint(exe, [exe], "msi")).toBe(exe);
  });
});

describe("downloadAndInstallUpdate (desktop)", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("downloads then hands the file to the installer, which owns its cleanup", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_update_install_hint_cmd") return null;
      if (cmd === "download_update_asset_cmd") {
        return { path: "/tmp/kai-update-x.exe", filename: "x.exe", bytes: 10 };
      }
      if (cmd === "launch_update_installer_cmd") {
        return { message: "Kai will restart", unattended: true };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const phases: string[] = [];
    const result = await downloadAndInstallUpdate(
      exe,
      null,
      { onInstalling: () => phases.push("installing") },
      all
    );

    expect(result).toEqual({ message: "Kai will restart", unattended: true });
    // The UI is told the download is done before the installer is launched.
    expect(phases).toEqual(["installing"]);
    const cmds = invoke.mock.calls.map((c) => c[0]);
    expect(cmds).toEqual([
      "get_update_install_hint_cmd",
      "download_update_asset_cmd",
      "launch_update_installer_cmd",
    ]);
    expect(invoke).toHaveBeenCalledWith("launch_update_installer_cmd", {
      path: "/tmp/kai-update-x.exe",
    });
  });

  it("downloads the installer that matches the install hint", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_update_install_hint_cmd") return "msi";
      if (cmd === "download_update_asset_cmd") return { path: "p", filename: "f", bytes: 1 };
      return { message: "ok", unattended: true };
    });

    await downloadAndInstallUpdate(exe, null, undefined, all);

    expect(invoke).toHaveBeenCalledWith("download_update_asset_cmd", {
      url: msi.browser_download_url,
      filename: msi.name,
    });
  });

  it("still installs when the hint command is unavailable", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_update_install_hint_cmd") throw new Error("unknown command");
      if (cmd === "download_update_asset_cmd") return { path: "p", filename: "f", bytes: 1 };
      return { message: "ok", unattended: true };
    });

    await expect(downloadAndInstallUpdate(exe, null, undefined, all)).resolves.toEqual({
      message: "ok",
      unattended: true,
    });
  });

  it("surfaces a failed launch so the UI can offer the release page", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_update_install_hint_cmd") return null;
      if (cmd === "download_update_asset_cmd") return { path: "p", filename: "f", bytes: 1 };
      throw new Error("Failed to start the installer");
    });

    await expect(downloadAndInstallUpdate(exe, null, undefined, all)).rejects.toThrow(
      "Failed to start the installer"
    );
  });
});

describe("update outcome after the restart", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("reports success when the running version reached the target", () => {
    markUpdatePending("0.1.7", "v0.1.8");
    expect(consumeUpdateOutcome("0.1.8")).toEqual({ kind: "updated", version: "0.1.8" });
    // Reported once only.
    expect(consumeUpdateOutcome("0.1.8")).toBeNull();
  });

  it("reports failure when Kai is still on the old version", () => {
    markUpdatePending("0.1.7", "0.1.8");
    expect(consumeUpdateOutcome("0.1.7")).toEqual({ kind: "failed", version: "0.1.8" });
  });

  it("stays silent without a pending update or when the marker is stale", () => {
    expect(consumeUpdateOutcome("0.1.7")).toBeNull();
    markUpdatePending("0.1.7", "0.1.8", Date.now() - 31 * 60 * 1000);
    expect(consumeUpdateOutcome("0.1.7")).toBeNull();
    expect(localStorage.getItem(UPDATE_PENDING_KEY)).toBeNull();
  });

  it("ignores a corrupt marker and clears a cancelled one", () => {
    localStorage.setItem(UPDATE_PENDING_KEY, "{nope");
    expect(consumeUpdateOutcome("0.1.7")).toBeNull();
    markUpdatePending("0.1.7", "0.1.8");
    clearUpdatePending();
    expect(consumeUpdateOutcome("0.1.7")).toBeNull();
  });
});
