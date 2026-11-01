// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { WorkspaceModal } from "../components/WorkspaceModal";
import {
  MAX_TABS_PER_WORKSPACE,
  MAX_WORKSPACES,
  WORKSPACES_KEY,
  createWorkspace,
  loadOrMigrateWorkspaces,
  loadWorkspaces,
  saveWorkspaces,
} from "../services/workspaces";
import { LAYOUT_KEY, createDefaultTab } from "../services/tabFactory";
import type { TerminalTab } from "../types/terminal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const tabs = (n: number): TerminalTab[] =>
  Array.from({ length: n }, (_, i) => createDefaultTab(`Terminal ${i + 1}`));

async function open(currentTabs: TerminalTab[] = tabs(2)) {
  await act(async () =>
    root.render(
      <WorkspaceModal
        isOpen
        onClose={() => {}}
        currentTabs={currentTabs}
        onLoadWorkspace={() => {}}
      />
    )
  );
}
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes(label)
  )!;
const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? null;
const names = () => [...host.querySelectorAll(".workspace-name")].map((e) => e.textContent);

async function type(selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("saving the current layout", () => {
  it("uses the typed name and never opens a blocking prompt()", async () => {
    const prompt = vi.spyOn(window, "prompt");
    await open();
    await type('input[aria-label="Name for the saved layout"]', "  API work ");
    await act(async () => button("Save Current Layout").click());
    expect(prompt).not.toHaveBeenCalled();
    expect(names()).toEqual(["API work"]);
    expect(loadWorkspaces().map((w) => w.name)).toEqual(["API work"]);
  });

  it("falls back to a numbered default name when none is typed", async () => {
    await open();
    await act(async () => button("Save Current Layout").click());
    expect(names()).toEqual(["Workspace 1"]);
  });

  it("says so when it keeps only the first tabs instead of dropping the rest silently", async () => {
    await open(tabs(MAX_TABS_PER_WORKSPACE + 3));
    await act(async () => button("Save Current Layout").click());
    expect(alertText()).toContain(
      `first ${MAX_TABS_PER_WORKSPACE} of ${MAX_TABS_PER_WORKSPACE + 3}`
    );
    expect(loadWorkspaces()[0].tabs).toHaveLength(MAX_TABS_PER_WORKSPACE);
  });

  it("refuses to exceed the workspace limit and explains why", async () => {
    saveWorkspaces(Array.from({ length: MAX_WORKSPACES }, (_, i) => createWorkspace(`w${i}`)));
    await open();
    await act(async () => button("Save Current Layout").click());
    expect(alertText()).toContain(`up to ${MAX_WORKSPACES} workspaces`);
    expect(loadWorkspaces()).toHaveLength(MAX_WORKSPACES);
  });

  it("does not claim it saved when storage rejects the write", async () => {
    await open();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await act(async () => button("Save Current Layout").click());
    expect(alertText()).toMatch(/could not save/i);
    expect(names()).toEqual([]);
  });
});

describe("workspace storage", () => {
  it("saveWorkspaces reports a failed write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(saveWorkspaces([createWorkspace("x")])).toBe(false);
  });

  it("saveWorkspaces reports success", () => {
    expect(saveWorkspaces([createWorkspace("x")])).toBe(true);
    expect(loadWorkspaces()).toHaveLength(1);
  });

  it("migrates the legacy layout only the first time, never after the list was emptied", async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify([{ title: "live session" }]));
    // First open: no workspaces document yet -> one "Restored session" workspace.
    await open();
    expect(names()).toEqual(["Restored session"]);

    // The user deletes it. The live layout key is still there (it is rewritten on
    // every tab change), but the workspaces document now exists, so no resurrection.
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[title="Delete Workspace"]')!.click()
    );
    expect(names()).toEqual([]);
    expect(localStorage.getItem(WORKSPACES_KEY)).not.toBeNull();
    expect(loadOrMigrateWorkspaces()).toEqual([]);

    await act(async () => root.render(<div />));
    await open();
    expect(names()).toEqual([]);
  });
});
