// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => false }));

import { guardLinkClicks } from "../services/terminalLinks";

/**
 * Mirrors xterm 6's DOM: the Linkifier listens for mousedown on the screen
 * element (it records which link was pressed), and the terminal element,
 * its ancestor, listens for mousedown to send a mouse report to the pty.
 * Regression: a Ctrl+click on a link reached both, so a mouse-aware program
 * (Claude Code, `kai teams`) opened the link too — two browser tabs.
 */
describe("guardLinkClicks", () => {
  let terminalEl: HTMLDivElement;
  let screenEl: HTMLDivElement;
  let linkifierDown: ReturnType<typeof vi.fn<(e: Event) => void>>;
  let ptyReport: ReturnType<typeof vi.fn<(e: Event) => void>>;
  let focus: ReturnType<typeof vi.fn<() => void>>;
  let overLink: boolean;
  let dispose: () => void;

  const press = (init: MouseEventInit) => {
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, ...init });
    screenEl.dispatchEvent(ev);
    return ev;
  };

  beforeEach(() => {
    terminalEl = document.createElement("div");
    screenEl = document.createElement("div");
    terminalEl.appendChild(screenEl);
    document.body.appendChild(terminalEl);
    linkifierDown = vi.fn<(e: Event) => void>();
    ptyReport = vi.fn<(e: Event) => void>();
    focus = vi.fn<() => void>();
    overLink = true;
    // Registration order matches the app: xterm's listeners exist before ours.
    screenEl.addEventListener("mousedown", linkifierDown);
    terminalEl.addEventListener("mousedown", ptyReport);
    dispose = guardLinkClicks(screenEl, () => overLink, focus);
  });

  afterEach(() => {
    dispose();
    terminalEl.remove();
  });

  it("Ctrl+click on a link reaches the Linkifier but never the pty", () => {
    const ev = press({ ctrlKey: true, button: 0 });
    expect(linkifierDown).toHaveBeenCalledTimes(1);
    expect(ptyReport).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("Cmd+click on a link is guarded the same way (macOS)", () => {
    press({ metaKey: true, button: 0 });
    expect(ptyReport).not.toHaveBeenCalled();
  });

  it("a plain click still goes to the program, so TUIs keep working", () => {
    press({ button: 0 });
    expect(ptyReport).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+click away from any link still goes to the program", () => {
    overLink = false;
    press({ ctrlKey: true, button: 0 });
    expect(ptyReport).toHaveBeenCalledTimes(1);
  });

  it("only the primary button is guarded", () => {
    press({ ctrlKey: true, button: 2 });
    expect(ptyReport).toHaveBeenCalledTimes(1);
  });

  it("disposing removes the guard", () => {
    dispose();
    press({ ctrlKey: true, button: 0 });
    expect(ptyReport).toHaveBeenCalledTimes(1);
  });
});
