// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../services/settingsService";
import { createTerminalKeyHandler } from "../services/terminalKeyHandler";

/** The terminal's key rules, tested directly now that they are not buried in the component. */
function setup(overrides: Partial<Parameters<typeof createTerminalKeyHandler>[0]> = {}) {
  const term = {
    selection: "",
    hasSelection() {
      return this.selection !== "";
    },
    getSelection() {
      return this.selection;
    },
    selectAll: vi.fn(),
    clear: vi.fn(),
    scrollToTop: vi.fn(),
    scrollToBottom: vi.fn(),
  };
  const copied: string[] = [];
  const pasted: string[] = [];
  const handler = createTerminalKeyHandler({
    term,
    fixedKeys: () => DEFAULT_SETTINGS.fixedKeybindings,
    keybindings: () => DEFAULT_SETTINGS.keybindings,
    copyText: async (t) => void copied.push(t),
    readPaste: async () => "from clipboard",
    paste: (t) => void pasted.push(t),
    pasteFallbackMs: 20,
    ...overrides,
  });
  return { term, handler, copied, pasted };
}

function key(init: KeyboardEventInit & { type?: string; altGraph?: boolean }): KeyboardEvent {
  const e = new KeyboardEvent(init.type ?? "keydown", { bubbles: true, cancelable: true, ...init });
  e.getModifierState = (n: string) => n === "AltGraph" && init.altGraph === true;
  return e;
}
const ctrlShift = (k: string, code: string, extra: KeyboardEventInit = {}) =>
  key({ key: k, code, ctrlKey: true, shiftKey: true, ...extra });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("copy", () => {
  it("Ctrl+Shift+C copies the selection and is not sent to the shell", () => {
    const { term, handler, copied } = setup();
    term.selection = "hello";
    expect(handler.handle(ctrlShift("C", "KeyC"))).toBe(false);
    expect(copied).toEqual(["hello"]);
  });

  it("copies on keydown only, not again on keyup", () => {
    const { term, handler, copied } = setup();
    term.selection = "x";
    handler.handle(ctrlShift("C", "KeyC", { type: "keyup" } as KeyboardEventInit));
    expect(copied).toEqual([]);
  });

  it("with nothing selected the key goes on to the shell", () => {
    const { handler, copied } = setup();
    expect(handler.handle(ctrlShift("C", "KeyC"))).toBe(true);
    expect(copied).toEqual([]);
  });

  it("plain Ctrl+C is always the shell's (SIGINT), even with a selection", () => {
    const { term, handler, copied } = setup();
    term.selection = "hello";
    expect(handler.handle(key({ key: "c", code: "KeyC", ctrlKey: true }))).toBe(true);
    expect(copied).toEqual([]);
  });
});

describe("paste", () => {
  it("lets the WebView's own paste event answer, and reads the clipboard only if none does", async () => {
    const { handler, pasted } = setup();
    expect(handler.handle(ctrlShift("V", "KeyV"))).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    expect(pasted).toEqual(["from clipboard"]);
  });

  it("does nothing more once the paste event arrived and cancelled the fallback", async () => {
    const { handler, pasted } = setup();
    handler.handle(ctrlShift("V", "KeyV"));
    handler.cancelPendingPaste(); // the native paste handler does this
    await vi.advanceTimersByTimeAsync(100);
    expect(pasted).toEqual([]);
  });

  it("a held combo queues one paste: auto-repeat is swallowed", async () => {
    const { handler, pasted } = setup();
    handler.handle(ctrlShift("V", "KeyV"));
    const repeat = ctrlShift("V", "KeyV", { repeat: true });
    expect(handler.handle(repeat)).toBe(false);
    expect(repeat.defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(pasted).toHaveLength(1);
  });

  it("a failing clipboard read is not an error", async () => {
    const { handler, pasted } = setup({ readPaste: async () => Promise.reject(new Error("no")) });
    handler.handle(ctrlShift("V", "KeyV"));
    await vi.advanceTimersByTimeAsync(100);
    expect(pasted).toEqual([]);
  });
});

describe("AltGr", () => {
  it("is never taken as a shortcut", () => {
    const { handler, copied } = setup();
    const e = ctrlShift("C", "KeyC", { altKey: true, altGraph: true } as KeyboardEventInit);
    expect(handler.handle(e)).toBe(true);
    expect(copied).toEqual([]);
  });
});

describe("terminal-local actions and app shortcuts", () => {
  it("select all, clear and the scrollback jumps act on the terminal and are swallowed", () => {
    const { term, handler } = setup();
    expect(handler.handle(ctrlShift("A", "KeyA"))).toBe(false);
    expect(term.selectAll).toHaveBeenCalledTimes(1);
    expect(handler.handle(ctrlShift("K", "KeyK"))).toBe(false);
    expect(term.clear).toHaveBeenCalledTimes(1);
    expect(handler.handle(ctrlShift("Home", "Home"))).toBe(false);
    expect(term.scrollToTop).toHaveBeenCalledTimes(1);
    expect(handler.handle(ctrlShift("End", "End"))).toBe(false);
    expect(term.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("a user-bound app shortcut is kept from the shell without being cancelled", () => {
    const search = DEFAULT_SETTINGS.keybindings.search;
    expect(search, "the default bindings include search").toBeTruthy();
    const { handler } = setup();
    const e = ctrlShift("F", "KeyF");
    expect(handler.handle(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false); // it must still reach App's window handler
  });

  it("with no bindings loaded, and for an ordinary key, the key goes to the shell", () => {
    const { handler } = setup({ keybindings: () => undefined });
    expect(handler.handle(key({ key: "a", code: "KeyA" }))).toBe(true);
    expect(handler.handle(ctrlShift("F", "KeyF"))).toBe(true);
  });

  it("reads the bindings at each key, so a Settings change applies to an open pane", () => {
    let bindings: typeof DEFAULT_SETTINGS.keybindings | undefined = undefined;
    const { handler } = setup({ keybindings: () => bindings });
    expect(handler.handle(ctrlShift("F", "KeyF"))).toBe(true);
    bindings = DEFAULT_SETTINGS.keybindings;
    expect(handler.handle(ctrlShift("F", "KeyF"))).toBe(false);
  });
});
