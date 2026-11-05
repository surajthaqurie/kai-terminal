// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("../services/projectService", () => ({
  getGitChanges: vi.fn(async () => ({
    branch: "main",
    staged: [],
    working_tree: [{ path: "a.txt", status: "M", staged: false }],
    untracked: [],
    total_changes: 1,
    clean: false,
  })),
  getGitDiff: vi.fn(async () => ""),
  stageGitFile: vi.fn(),
  unstageGitFile: vi.fn(),
  discardGitFile: vi.fn(),
  runGitAction: vi.fn(),
}));

import { GitChangesModal } from "../components/GitChangesModal";
import { ShellPicker } from "../components/ShellPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
// A stand-in for the terminal: xterm handles Escape itself (sends it to the
// shell) and stops it bubbling, so listeners on window never see it.
let terminalInput: HTMLTextAreaElement;

const render = (node: React.ReactElement) => act(async () => root.render(node));
const pressEscapeInTerminal = () =>
  act(async () => {
    terminalInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
  });

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  terminalInput = document.createElement("textarea");
  terminalInput.addEventListener("keydown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  document.body.appendChild(terminalInput);
  terminalInput.focus();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  terminalInput.remove();
});

describe("Escape while the terminal has focus", () => {
  it("closes the Git Changes modal", async () => {
    const onClose = vi.fn();
    await render(<GitChangesModal dir="/repo" onClose={onClose} />);
    await pressEscapeInTerminal();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancels the discard confirmation first, then closes the modal", async () => {
    const onClose = vi.fn();
    await render(<GitChangesModal dir="/repo" onClose={onClose} />);
    await act(async () => {
      (host.querySelector("button[aria-label^='Discard changes in']") as HTMLElement).click();
    });
    expect(host.querySelector(".discard-confirm-box")).not.toBeNull();

    await pressEscapeInTerminal();
    expect(host.querySelector(".discard-confirm-box")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await pressEscapeInTerminal();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses the Shell Picker restart prompt", async () => {
    const shells = [
      { id: "a", name: "Bash", path: "/bin/bash", is_default: true },
      { id: "b", name: "Zsh", path: "/bin/zsh", is_default: false },
    ] as never;
    await render(
      <ShellPicker shells={shells} current={(shells as never[])[0]} onChange={() => {}} />
    );
    await act(async () => {
      (host.querySelector(".shell-chip") as HTMLElement).click();
    });
    const zsh = [
      ...document.querySelectorAll<HTMLElement>("[role='menuitemradio'], [role='menuitem']"),
    ].find((el) => /Zsh/.test(el.textContent ?? ""));
    expect(zsh).toBeTruthy();
    await act(async () => zsh!.click());
    expect(host.querySelector("[role='alertdialog']")).not.toBeNull();

    await pressEscapeInTerminal();
    expect(host.querySelector("[role='alertdialog']")).toBeNull();
  });
});
