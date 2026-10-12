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
  getActiveMode,
  setActiveMode,
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
    expect(getActiveMode()).toBe("code");

    setActiveProject("/home/kali/Documents/project", "code");
    expect(getActiveProject()).toBe("/home/kali/Documents/project");
    expect(getActiveMode()).toBe("code");

    setActiveMode("terminal");
    expect(getActiveMode()).toBe("terminal");
  });
});
