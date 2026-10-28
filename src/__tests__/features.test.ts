// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { SettingsService, DEFAULT_KEYBINDINGS } from "../services/settingsService";
import {
  registerUserCustomAiCli,
  loadUserCustomClis,
  getAiCliDetails,
} from "../services/aiCliService";
import {
  openProjectInEditor,
  runGitAction,
  getActiveProject,
  setActiveProject,
  clearActiveProject,
  getActiveMode,
  setActiveMode,
  getActiveProjectState,
  isCodeModeActiveForDir,
  recordRecentProject,
} from "../services/projectService";

describe("Project Workspace Settings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("saves and loads project-specific workspace settings", () => {
    const projDir = "/home/user/project-a";
    SettingsService.saveProjectSettings({
      projectDir: projDir,
      defaultShellId: "bash",
      editorPath: "code",
    });

    const loaded = SettingsService.getProjectSettings(projDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.defaultShellId).toBe("bash");
    expect(loaded?.editorPath).toBe("code");
  });

  it("normalizes keybindings in settings", () => {
    const norm = SettingsService.normalize({
      keybindings: {
        newTab: "Ctrl+T",
      } as never,
    });
    expect(norm.keybindings.newTab).toBe("Ctrl+T");
    expect(norm.keybindings.closeTab).toBe(DEFAULT_KEYBINDINGS.closeTab);
  });
});

describe("User-Defined Custom AI CLI Registration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("registers and retrieves custom AI CLI executables", async () => {
    await registerUserCustomAiCli({
      id: "ollama",
      name: "Ollama Local",
      path: "/usr/local/bin/ollama",
      install_guidance: "Local LLM runner",
    });

    const saved = loadUserCustomClis();
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe("ollama");

    const details = await getAiCliDetails();
    const registered = details.find((d) => d.id === "custom:ollama");
    expect(registered).toBeDefined();
    expect(registered?.name).toBe("Ollama Local");
  });
});

describe("Project Services Fallbacks", () => {
  it("rejects editor launch outside Tauri", async () => {
    await expect(openProjectInEditor("/tmp")).rejects.toThrow(
      "Editor launch is only available inside the desktop app."
    );
  });

  it("rejects git actions outside Tauri", async () => {
    await expect(runGitAction("/tmp", "status")).rejects.toThrow(
      "Git actions are only available inside the desktop app."
    );
  });
});

describe("Active Project and Code Mode Persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stores and retrieves active project and code mode", () => {
    expect(getActiveProject()).toBeNull();
    expect(getActiveMode()).toBe("terminal");

    setActiveProject("/home/kali/Documents/project", "code");
    expect(getActiveProject()).toBe("/home/kali/Documents/project");
    expect(getActiveMode()).toBe("code");

    setActiveMode("terminal");
    expect(getActiveMode()).toBe("terminal");
    expect(getActiveProject()).toBeNull();
  });

  it("never activates Code Mode from recent history alone", async () => {
    recordRecentProject("/home/kali/Documents/project");
    // Recent folders must NOT light up the Code Mode badge: only an
    // explicit `kai code <path>` does.
    expect(getActiveProject()).toBeNull();
    expect(getActiveMode()).toBe("terminal");
    await expect(getActiveProjectState()).resolves.toEqual({
      path: null,
      mode: "terminal",
    });
  });

  it("clears Code Mode like `kai stop code`", async () => {
    setActiveProject("/home/kali/Documents/project", "code");
    expect(getActiveProject()).toBe("/home/kali/Documents/project");
    clearActiveProject();
    expect(getActiveProject()).toBeNull();
    await expect(getActiveProjectState()).resolves.toEqual({
      path: null,
      mode: "terminal",
    });
  });

  it("matches project dir and children only (no bare-prefix leaks)", () => {
    expect(isCodeModeActiveForDir("/repo/app", "/repo/app")).toBe(true);
    expect(isCodeModeActiveForDir("/repo/app/src", "/repo/app")).toBe(true);
    expect(isCodeModeActiveForDir("/repo/app-other", "/repo/app")).toBe(false);
    expect(isCodeModeActiveForDir("C:\\Repo\\App\\src", "c:/repo/app")).toBe(true);
    expect(isCodeModeActiveForDir("/repo/app", null)).toBe(false);
    expect(isCodeModeActiveForDir("", "/repo/app")).toBe(false);
  });
});
