// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HeaderActions } from "../components/HeaderActions";
import type { CommandAction } from "../components/CommandPalette";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const IDS = [
  "manage-workspaces",
  "toggle-music",
  "review-changes",
  "split-vertical",
  "split-horizontal",
  "diagnostics",
  "check-updates",
];

function makeActions() {
  const performs = Object.fromEntries(IDS.map((id) => [id, vi.fn()]));
  const actions: CommandAction[] = IDS.map((id) => ({
    id,
    label: id,
    category: "x",
    shortcut: id === "split-vertical" ? "Ctrl+Alt+V" : undefined,
    icon: null,
    perform: performs[id],
  }));
  return { actions, performs };
}

async function mount(ui: ReactElement) {
  await act(async () => root.render(ui));
}

const base = () => ({
  paletteShortcut: "Ctrl+Shift+P",
  onOpenCommandPalette: vi.fn(),
  onOpenAiCli: vi.fn(),
  onOpenSettings: vi.fn(),
});

const open = () =>
  act(async () => container.querySelector<HTMLElement>('[aria-label^="More actions"]')!.click());
const openEditorMenu = () =>
  act(async () => container.querySelector<HTMLElement>('[aria-label="Choose editor"]')!.click());
const labels = () =>
  [...container.querySelectorAll('[role^="menuitem"] .popup-menu-label')].map((n) => n.textContent);
const itemWith = (text: string) =>
  [...container.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((i) =>
    i.textContent?.includes(text)
  )!;

describe("HeaderActions", () => {
  it("shows only the always-used controls and wires their handlers", async () => {
    const props = base();
    await mount(<HeaderActions {...props} actions={makeActions().actions} />);
    const click = (label: string) =>
      act(async () => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click());
    await click("Open command palette");
    await click("Open AI CLI providers");
    await click("Open settings");
    expect(props.onOpenCommandPalette).toHaveBeenCalledTimes(1);
    expect(props.onOpenAiCli).toHaveBeenCalledTimes(1);
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".header-palette-kbd")!.textContent).toBe("Ctrl+Shift+P");
    expect(container.querySelectorAll("button.header-icon-btn")).toHaveLength(3);
    // No editor handler: no editor control either.
    expect(container.querySelector('[aria-label="Open project in editor"]')).toBeNull();
  });

  it("puts the icon-only editor button right after the search box and before AI providers", async () => {
    const onOpenEditor = vi.fn();
    await mount(
      <HeaderActions {...base()} actions={makeActions().actions} onOpenEditor={onOpenEditor} />
    );
    const order = [
      ...container.querySelectorAll<HTMLElement>(".header-actions > button, .header-actions > div"),
    ].map(
      (el) =>
        el.getAttribute("aria-label") ??
        el.querySelector("[aria-label]")?.getAttribute("aria-label")
    );
    expect(order.slice(0, 3)).toEqual([
      "Open command palette",
      "Open project in editor",
      "Open AI CLI providers",
    ]);
    const editorBtn = container.querySelector<HTMLElement>(
      '[aria-label="Open project in editor"]'
    )!;
    expect(editorBtn.textContent).toBe("");
    await act(async () => editorBtn.click());
    expect(onOpenEditor).toHaveBeenCalledWith(undefined);
  });

  it("the more menu reuses the palette's handlers and shortcuts", async () => {
    const { actions, performs } = makeActions();
    await mount(<HeaderActions {...base()} actions={actions} />);
    await open();
    expect(labels()).toEqual([
      "Workspaces & sessions",
      "Review git changes",
      "Split pane right",
      "Split pane down",
      "Diagnostics & recovery",
      "Check for updates",
    ]);
    expect(container.querySelector(".popup-menu-hint")!.textContent).toBe("Ctrl+Alt+V");
    await act(async () => itemWith("Split pane right").click());
    expect(performs["split-vertical"]).toHaveBeenCalledTimes(1);
  });

  it("keeps Music Time and the editor list out of the more menu", async () => {
    await mount(
      <HeaderActions
        {...base()}
        actions={makeActions().actions}
        onOpenEditor={vi.fn()}
        installedEditors={[
          { id: "code", name: "VS Code", binary: "code", path: "/bin/code" },
          { id: "zed", name: "Zed", binary: "zed", path: "/bin/zed" },
        ]}
      />
    );
    await open();
    expect(labels()).not.toContain("Music Time");
    expect(labels()).not.toContain("VS Code");
    expect(labels().some((l) => l?.startsWith("Open project in"))).toBe(false);
  });

  it("lists every detected editor and opens the chosen one", async () => {
    const onOpenEditor = vi.fn();
    const editors = [
      { id: "code", name: "VS Code", binary: "code", path: "/bin/code" },
      { id: "zed", name: "Zed", binary: "zed", path: "/bin/zed" },
    ];
    await mount(
      <HeaderActions
        {...base()}
        actions={makeActions().actions}
        onOpenEditor={onOpenEditor}
        installedEditors={editors}
      />
    );
    await openEditorMenu();
    expect(labels()).toEqual(expect.arrayContaining(["VS Code", "Zed", "Default (auto-detect)"]));
    await act(async () => itemWith("Zed").click());
    expect(onOpenEditor).toHaveBeenCalledWith("/bin/zed");
  });

  it("opens a single detected editor from one entry", async () => {
    await mount(
      <HeaderActions
        {...base()}
        actions={makeActions().actions}
        onOpenEditor={vi.fn()}
        installedEditors={[{ id: "code", name: "VS Code", binary: "code", path: "/bin/code" }]}
      />
    );
    await openEditorMenu();
    expect(labels()).toContain("Open project in VS Code");
    expect(labels()).not.toContain("Default (auto-detect)");
  });

  it("refreshes the editor list each time the editor menu opens", async () => {
    const onRefreshEditors = vi.fn();
    await mount(
      <HeaderActions
        {...base()}
        actions={makeActions().actions}
        onOpenEditor={vi.fn()}
        onRefreshEditors={onRefreshEditors}
      />
    );
    await openEditorMenu();
    expect(onRefreshEditors).toHaveBeenCalledTimes(1);
  });

  it("flags an available update with a badge and an install entry instead of the check entry", async () => {
    const onViewUpdate = vi.fn();
    await mount(
      <HeaderActions
        {...base()}
        actions={makeActions().actions}
        updateAvailable
        latestVersion="2.0.0"
        onViewUpdate={onViewUpdate}
      />
    );
    expect(container.querySelector(".header-icon-badge")).not.toBeNull();
    await open();
    expect(labels()).toContain("Update available — v2.0.0");
    expect(labels()).not.toContain("Check for updates");
    await act(async () => itemWith("Update available").click());
    expect(onViewUpdate).toHaveBeenCalledTimes(1);
  });
});
