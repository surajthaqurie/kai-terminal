// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, buildSplitRows } from "../components/GitChangesModal";

describe("Unified Diff Parser", () => {
  it("parses standard unified diff with additions, deletions, and context", () => {
    const sampleDiff = `--- a/src/App.tsx
+++ b/src/App.tsx
@@ -10,6 +10,8 @@ import { useState } from "react";
 const x = 1;
-const y = 2;
+const y = 20;
+const z = 30;
 const w = 4;
`;
    const parsed = parseUnifiedDiff(sampleDiff);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(1);

    const hunk = parsed.hunks[0];
    expect(hunk.oldStart).toBe(10);
    expect(hunk.newStart).toBe(10);
    expect(hunk.lines).toHaveLength(5);

    // Context line 1
    expect(hunk.lines[0]).toEqual({
      type: "context",
      oldLineNumber: 10,
      newLineNumber: 10,
      content: "const x = 1;",
    });

    // Deletion
    expect(hunk.lines[1]).toEqual({
      type: "delete",
      oldLineNumber: 11,
      content: "const y = 2;",
    });

    // Additions
    expect(hunk.lines[2]).toEqual({
      type: "add",
      newLineNumber: 11,
      content: "const y = 20;",
    });
    expect(hunk.lines[3]).toEqual({
      type: "add",
      newLineNumber: 12,
      content: "const z = 30;",
    });

    // Context line 2
    expect(hunk.lines[4]).toEqual({
      type: "context",
      oldLineNumber: 12,
      newLineNumber: 13,
      content: "const w = 4;",
    });
  });

  it("handles newly added untracked files with all additions", () => {
    const newFileDiff = `--- /dev/null
+++ b/src/newFile.ts
@@ -0,0 +1,3 @@
+export const hello = "world";
+export const count = 42;
+console.log(hello);
`;
    const parsed = parseUnifiedDiff(newFileDiff);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.additions).toBe(3);
    expect(parsed.deletions).toBe(0);
    expect(parsed.hunks[0].lines.every((l) => l.type === "add")).toBe(true);
  });

  it("handles deleted files with all deletions", () => {
    const deletedDiff = `--- a/src/oldFile.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const old1 = 1;
-const old2 = 2;
`;
    const parsed = parseUnifiedDiff(deletedDiff);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.additions).toBe(0);
    expect(parsed.deletions).toBe(2);
    expect(parsed.hunks[0].lines.every((l) => l.type === "delete")).toBe(true);
  });

  it("handles empty or blank diff gracefully", () => {
    const parsed = parseUnifiedDiff("");
    expect(parsed.hunks).toHaveLength(0);
    expect(parsed.additions).toBe(0);
    expect(parsed.deletions).toBe(0);
  });
});

describe("Split (Side-by-Side) Diff Builder", () => {
  it("aligns modifications into side-by-side rows", () => {
    const sampleDiff = `@@ -1,3 +1,3 @@
 context 1
-deleted line
+added line
 context 2
`;
    const parsed = parseUnifiedDiff(sampleDiff);
    expect(parsed.hunks).toHaveLength(1);

    const splitRows = buildSplitRows(parsed.hunks[0]);
    expect(splitRows).toHaveLength(3);

    // Row 0: Context
    expect(splitRows[0].left?.content).toBe("context 1");
    expect(splitRows[0].right?.content).toBe("context 1");

    // Row 1: Modified (delete on left, add on right)
    expect(splitRows[1].left?.type).toBe("delete");
    expect(splitRows[1].left?.content).toBe("deleted line");
    expect(splitRows[1].right?.type).toBe("add");
    expect(splitRows[1].right?.content).toBe("added line");

    // Row 2: Context
    expect(splitRows[2].left?.content).toBe("context 2");
    expect(splitRows[2].right?.content).toBe("context 2");
  });

  it("handles unequal number of additions and deletions", () => {
    const sampleDiff = `@@ -1,2 +1,4 @@
-del 1
-del 2
+add 1
+add 2
+add 3
`;
    const parsed = parseUnifiedDiff(sampleDiff);
    const splitRows = buildSplitRows(parsed.hunks[0]);
    // Max of 2 deletes and 3 adds = 3 rows
    expect(splitRows).toHaveLength(3);
    expect(splitRows[0].left?.content).toBe("del 1");
    expect(splitRows[0].right?.content).toBe("add 1");
    expect(splitRows[1].left?.content).toBe("del 2");
    expect(splitRows[1].right?.content).toBe("add 2");
    expect(splitRows[2].left).toBeUndefined();
    expect(splitRows[2].right?.content).toBe("add 3");
  });
});

describe("Project Git Changes Service APIs", () => {
  it("rejects getGitChanges outside Tauri environment with actionable error", async () => {
    const { getGitChanges } = await import("../services/projectService");
    await expect(getGitChanges("/tmp")).rejects.toThrow(
      "Git actions are only available inside the desktop app."
    );
  });

  it("rejects getGitDiff outside Tauri environment with actionable error", async () => {
    const { getGitDiff } = await import("../services/projectService");
    await expect(getGitDiff("/tmp", "file.ts")).rejects.toThrow(
      "Git actions are only available inside the desktop app."
    );
  });

  it("rejects stageGitFile outside Tauri environment with actionable error", async () => {
    const { stageGitFile } = await import("../services/projectService");
    await expect(stageGitFile("/tmp", "file.ts")).rejects.toThrow(
      "Git actions are only available inside the desktop app."
    );
  });

  it("rejects unstageGitFile outside Tauri environment with actionable error", async () => {
    const { unstageGitFile } = await import("../services/projectService");
    await expect(unstageGitFile("/tmp", "file.ts")).rejects.toThrow(
      "Git actions are only available inside the desktop app."
    );
  });

  it("rejects discardGitFile outside Tauri environment with actionable error", async () => {
    const { discardGitFile } = await import("../services/projectService");
    await expect(discardGitFile("/tmp", "file.ts")).rejects.toThrow(
      "Git actions are only available inside the desktop app."
    );
  });
});

describe("Active Split Terminal and PaneHeader Component", () => {
  it("renders simple active indicator and triggers focus and changes", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { PaneHeader } = await import("../components/PaneHeader");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    let focused = false;
    let changesOpened = false;

    await React.act(async () => {
      root.render(
        React.createElement(PaneHeader, {
          paneId: "pane-1",
          cwd: "/home/user/project",
          isActive: true,
          gitInfo: {
            branch: "main",
            dirty: true,
            ahead_behind: null,
            repo_root: "/home/user/project",
            error: null,
          },
          showClose: true,
          onFocus: () => {
            focused = true;
          },
          onGitStatus: () => {},
          onOpenChanges: () => {
            changesOpened = true;
          },
          onOpenAi: () => {},
          onOpenEditor: () => {},
          onClosePane: () => {},
        })
      );
    });

    // 1. Active dot has 'on' class and header is-active
    const dot = container.querySelector(".pane-active-dot");
    expect(dot?.classList.contains("on")).toBe(true);

    const header = container.querySelector(".pane-header");
    expect(header?.classList.contains("is-active")).toBe(true);

    // 2. Code mode pill is NOT in split header (handled in footer status bar)
    expect(container.querySelector(".pane-mode-pill")).toBeNull();
    expect(container.querySelector(".pane-active-badge")).toBeNull();

    // 3. Changes button is visible when dirty
    const changesBtn = container.querySelector(".pane-changes-btn") as HTMLButtonElement | null;
    expect(changesBtn).not.toBeNull();
    expect(changesBtn?.textContent).toContain("Changes");

    // 4. Clicking changes button triggers onOpenChanges
    await React.act(async () => {
      changesBtn?.click();
    });
    expect(changesOpened).toBe(true);

    // 5. Clicking header triggers onFocus
    await React.act(async () => {
      (header as HTMLElement)?.click();
    });
    expect(focused).toBe(true);

    root.unmount();
    container.remove();
  });

  it("renders inactive split with subtle inactive dot and no is-active class", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { PaneHeader } = await import("../components/PaneHeader");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
      root.render(
        React.createElement(PaneHeader, {
          paneId: "pane-2",
          cwd: "/home/user/project",
          isActive: false,
          gitInfo: {
            branch: "main",
            dirty: false,
            ahead_behind: null,
            repo_root: "/home/user/project",
            error: null,
          },
          showClose: true,
          onFocus: () => {},
          onGitStatus: () => {},
          onOpenAi: () => {},
          onOpenEditor: () => {},
          onClosePane: () => {},
        })
      );
    });

    const dot = container.querySelector(".pane-active-dot");
    expect(dot?.classList.contains("on")).toBe(false);

    const header = container.querySelector(".pane-header");
    expect(header?.classList.contains("is-active")).toBe(false);

    root.unmount();
    container.remove();
  });
});

describe("StatusBar Footer with Active Split Directory, Mode and Git", () => {
  it("renders active split current path, code mode, and git branch in footer", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { StatusBar } = await import("../components/StatusBar");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
      root.render(
        React.createElement(StatusBar, {
          gitBranch: "feature/split-terminal",
          gitDirty: true,
          gitRepoRoot: "/home/user/workspace/kai",
          projectDir: "/home/user/workspace/kai",
          appVersion: "1.0.0",
          updateAvailable: false,
          onViewUpdate: () => {},
          onGitAction: () => {},
          mode: "code",
        })
      );
    });

    // 1. Current path is displayed in status-dir with Folder icon
    const dirBtn = container.querySelector(".status-dir");
    expect(dirBtn).not.toBeNull();
    expect(dirBtn?.textContent).toContain("/home/user/workspace/kai");

    // 2. Code mode pill is displayed
    const modePill = container.querySelector(".status-mode-pill");
    expect(modePill?.textContent).toContain("Code Mode");

    // 3. Git branch and dirty dot are displayed
    const branchText = container.querySelector(".status-git-branch");
    expect(branchText?.textContent).toBe("feature/split-terminal");

    const gitDot = container.querySelector(".status-git-dot");
    expect(gitDot?.classList.contains("dirty")).toBe(true);

    // 4. Path text is rendered cleanly for selection
    const dirText = container.querySelector(".status-dir-text");
    expect(dirText?.textContent).toBe("/home/user/workspace/kai");

    // 5. Order is strictly mode pill -> git -> path
    const statusLeftChildren = Array.from(container.querySelector(".status-left")?.children || []);
    expect(statusLeftChildren[0]?.classList.contains("status-mode-pill")).toBe(true);
    expect(statusLeftChildren[1]?.classList.contains("status-git-wrap")).toBe(true);
    expect(statusLeftChildren[2]?.classList.contains("status-dir")).toBe(true);

    root.unmount();
    container.remove();
  });

  it("renders the code-elsewhere pill with project name and jump action", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { StatusBar } = await import("../components/StatusBar");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    let opened = 0;
    await React.act(async () => {
      root.render(
        React.createElement(StatusBar, {
          gitBranch: "main",
          gitDirty: false,
          gitRepoRoot: "/home/user/other",
          projectDir: "/home/user/other",
          appVersion: "1.0.0",
          updateAvailable: false,
          onViewUpdate: () => {},
          onGitAction: () => {},
          mode: "code-elsewhere",
          codeProjectPath: "/home/user/workspace/kai",
          codeProjectName: "kai",
          onOpenCodeProject: () => {
            opened += 1;
          },
        })
      );
    });

    const pill = container.querySelector(".status-mode-elsewhere") as HTMLButtonElement | null;
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain("kai");
    expect(pill?.tagName).toBe("BUTTON");
    await React.act(async () => {
      pill?.click();
    });
    expect(opened).toBe(1);

    root.unmount();
    container.remove();
  });
});
