// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StatusBar } from "../components/StatusBar";

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

type Props = ComponentProps<typeof StatusBar>;

const mount = (props: Partial<Props> = {}) =>
  act(async () =>
    root.render(
      <StatusBar
        gitBranch={null}
        gitDirty={false}
        projectDir="/proj"
        appVersion="1.0.0"
        updateAvailable={false}
        {...props}
      />
    )
  );

const pill = () => container.querySelector<HTMLElement>(".status-mode-pill")!;
const caret = () => container.querySelector<HTMLElement>('[aria-label="Choose editor"]')!;
const labels = () =>
  [...container.querySelectorAll('[role^="menuitem"] .popup-menu-label')].map((n) => n.textContent);
const itemWith = (text: string) =>
  [...container.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((i) =>
    i.textContent?.includes(text)
  )!;

describe("StatusBar mode pill opens the project in the editor", () => {
  it.each([
    ["code", "Code Mode"],
    ["terminal", "Terminal"],
  ])("%s mode: clicking the pill opens the default editor", async (mode, text) => {
    const onOpenEditor = vi.fn();
    await mount({ mode, onOpenEditor });
    expect(pill().tagName).toBe("BUTTON");
    expect(pill().textContent).toBe(text);
    expect(pill().getAttribute("aria-label")).toContain("Open project in editor");
    await act(async () => pill().click());
    expect(onOpenEditor).toHaveBeenCalledWith(undefined);
  });

  it("stays display-only without an editor handler", async () => {
    await mount({ mode: "code" });
    expect(pill().tagName).toBe("SPAN");
    expect(container.querySelector('[aria-label="Choose editor"]')).toBeNull();
  });

  it("the caret lists every detected editor and opens the chosen one", async () => {
    const onOpenEditor = vi.fn();
    const onRefreshEditors = vi.fn();
    await mount({
      onOpenEditor,
      onRefreshEditors,
      installedEditors: [
        { id: "code", name: "VS Code", binary: "code", path: "/bin/code" },
        { id: "zed", name: "Zed", binary: "zed", path: "/bin/zed" },
      ],
    });
    await act(async () => caret().click());
    expect(onRefreshEditors).toHaveBeenCalledTimes(1);
    expect(labels()).toEqual(expect.arrayContaining(["VS Code", "Zed", "Default (auto-detect)"]));
    await act(async () => itemWith("Zed").click());
    expect(onOpenEditor).toHaveBeenCalledWith("/bin/zed");
  });

  it("offers a single detected editor as one entry", async () => {
    await mount({
      onOpenEditor: vi.fn(),
      installedEditors: [{ id: "code", name: "VS Code", binary: "code", path: "/bin/code" }],
    });
    await act(async () => caret().click());
    expect(labels()).toContain("Open project in VS Code");
    expect(labels()).not.toContain("Default (auto-detect)");
  });
});
