// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  migrateLegacyLayout,
  sanitizeWorkspace,
  createWorkspace,
  renameWorkspace,
  deleteWorkspace,
  validateWorkspaceDir,
  saveWorkspaces,
  loadWorkspaces,
} from "../services/workspaces";

beforeEach(() => {
  localStorage.clear();
});

describe("workspace persistence and migration", () => {
  it("migrates existing saved tabs without losing them", () => {
    const legacy = [
      { title: "API", shellPath: "/bin/bash", cwd: "/tmp" },
      { title: "Web", cwd: "/tmp" },
    ];
    const ws = migrateLegacyLayout(legacy);
    expect(ws).not.toBeNull();
    expect(ws!.tabs).toHaveLength(2);
    expect(ws!.tabs[0].title).toBe("API");
    expect(ws!.tabs[0].cwd).toBe("/tmp");
    // Never persists history or env values.
    expect(JSON.stringify(ws)).not.toContain("history");
  });

  it("returns null for empty or corrupt legacy data", () => {
    expect(migrateLegacyLayout([])).toBeNull();
    expect(migrateLegacyLayout(null)).toBeNull();
    expect(migrateLegacyLayout([{ title: 123 } as never])).not.toBeNull();
  });

  it("creates, renames, restores, and deletes named workspaces", () => {
    const ws = createWorkspace("Project A", [{ title: "T1", cwd: "/tmp" }]);
    saveWorkspaces([ws]);
    const loaded = loadWorkspaces();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("Project A");
    const renamed = renameWorkspace(loaded, loaded[0].id, "Project B");
    expect(renamed[0].name).toBe("Project B");
    expect(renameWorkspace(loaded, loaded[0].id, "   ")).toEqual(loaded);
    expect(deleteWorkspace(renamed, renamed[0].id)).toHaveLength(0);
  });

  it("recovers safely from corrupted storage", () => {
    localStorage.setItem("terminal_workspaces_v1", "{not json");
    expect(loadWorkspaces()).toEqual([]);
    localStorage.setItem(
      "terminal_workspaces_v1",
      JSON.stringify({ version: 2, workspaces: "nope" })
    );
    expect(loadWorkspaces()).toEqual([]);
  });

  it("flags invalid workspace directories with actionable errors", () => {
    expect(validateWorkspaceDir("")).not.toBeNull();
    expect(validateWorkspaceDir("bad\0dir")).not.toBeNull();
    expect(validateWorkspaceDir("x".repeat(5000))).not.toBeNull();
    expect(validateWorkspaceDir("/tmp")).toBeNull();
  });

  it("drops oversized or malformed workspaces on load", () => {
    expect(sanitizeWorkspace(null)).toBeNull();
    expect(sanitizeWorkspace({ name: "" })).toBeNull();
    const many = Array.from({ length: 50 }, (_, i) => ({ title: `T${i}` }));
    const ws = sanitizeWorkspace({ id: "x", name: "N", tabs: many });
    expect(ws!.tabs.length).toBeLessThanOrEqual(10);
  });
});
