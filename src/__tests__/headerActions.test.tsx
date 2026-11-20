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
    // Opening the project in the editor lives on the status bar's mode pill.
    expect(container.querySelector('[aria-label*="editor"]')).toBeNull();
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
    await mount(<HeaderActions {...base()} actions={makeActions().actions} />);
    await open();
    expect(labels()).not.toContain("Music Time");
    expect(labels().some((l) => l?.startsWith("Open project in"))).toBe(false);
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
