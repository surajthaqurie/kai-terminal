// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { TerminalSearch } from "../hooks/useTerminalSearch";

type ResultsListener = (r: { resultIndex: number; resultCount: number }) => void;

const addons: FakeSearchAddon[] = [];
class FakeSearchAddon {
  resultsListener: ResultsListener | undefined;
  findNext = vi.fn();
  findPrevious = vi.fn();
  clearDecorations = vi.fn();
  constructor() {
    addons.push(this);
  }
  onDidChangeResults(l: ResultsListener) {
    this.resultsListener = l;
    return { dispose() {} };
  }
}
const loadSearchAddon = vi.fn(async () => FakeSearchAddon);
vi.mock("../services/xtermLazyAddons", async (orig) => ({
  ...(await orig<typeof import("../services/xtermLazyAddons")>()),
  loadSearchAddon: () => loadSearchAddon(),
}));

let root: Root;
let search: TerminalSearch;
const term = { loadAddon: vi.fn(), focus: vi.fn() };

beforeEach(async () => {
  addons.length = 0;
  loadSearchAddon.mockClear();
  term.loadAddon.mockClear();
  term.focus.mockClear();
  root = createRoot(document.createElement("div"));
  const { useTerminalSearch } = await import("../hooks/useTerminalSearch");
  function Harness() {
    search = useTerminalSearch(() => term as unknown as Terminal, "kai-dark");
    return null;
  }
  await act(async () => root.render(createElement(Harness)));
});

afterEach(async () => {
  await act(async () => root.unmount());
});

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const opts = { caseSensitive: false, regex: false, wholeWord: false };

describe("useTerminalSearch", () => {
  it("loads nothing until the bar is first opened, then opens and closes it", async () => {
    expect(loadSearchAddon).not.toHaveBeenCalled();
    expect(search.visible).toBe(false);
    await act(async () => search.toggle());
    await settle();
    expect(loadSearchAddon).toHaveBeenCalledTimes(1);
    expect(term.loadAddon).toHaveBeenCalledWith(addons[0]);
    expect(search.visible).toBe(true);
    await act(async () => search.toggle());
    expect(search.visible).toBe(false);
    expect(loadSearchAddon).toHaveBeenCalledTimes(1);
  });

  it("typing searches incrementally with the theme highlight colours", async () => {
    await act(async () => search.search("err", opts));
    await settle();
    const [query, options] = addons[0].findNext.mock.calls[0];
    expect(query).toBe("err");
    expect(options).toMatchObject({ ...opts, incremental: true });
    expect(options.decorations).toBeDefined();
  });

  it("next and previous search without the incremental flag; an empty query does nothing", async () => {
    await act(async () => search.next("x", opts));
    await act(async () => search.previous("x", opts));
    await act(async () => search.next("", opts));
    await settle();
    expect(addons[0].findNext).toHaveBeenCalledTimes(1);
    expect(addons[0].findNext.mock.calls[0][1].incremental).toBeUndefined();
    expect(addons[0].findPrevious).toHaveBeenCalledTimes(1);
  });

  it("shows the match count the add-on reports, and clearing the query removes it", async () => {
    await act(async () => search.toggle());
    await settle();
    await act(async () => addons[0].resultsListener!({ resultIndex: 2, resultCount: 17 }));
    expect(search.results).toEqual({ index: 2, count: 17 });
    await act(async () => search.search("", opts));
    expect(addons[0].clearDecorations).toHaveBeenCalled();
    expect(search.results).toBeNull();
  });

  it("closing returns focus to the terminal and clears the highlights", async () => {
    await act(async () => search.toggle());
    await settle();
    await act(async () => addons[0].resultsListener!({ resultIndex: 0, resultCount: 1 }));
    await act(async () => search.close());
    expect(search.visible).toBe(false);
    expect(term.focus).toHaveBeenCalled();
    expect(addons[0].clearDecorations).toHaveBeenCalled();
    expect(search.results).toBeNull();
  });

  it("closing with toggle (shortcut, palette) also clears the highlights", async () => {
    await act(async () => search.toggle());
    await settle();
    addons[0].clearDecorations.mockClear();
    await act(async () => search.toggle());
    expect(addons[0].clearDecorations).toHaveBeenCalled();
  });

  it("after reset (pane torn down) the add-on is loaded afresh on next use", async () => {
    await act(async () => search.toggle());
    await settle();
    search.reset();
    await act(async () => search.next("x", opts));
    await settle();
    expect(loadSearchAddon).toHaveBeenCalledTimes(2);
    expect(addons).toHaveLength(2);
    expect(addons[1].findNext).toHaveBeenCalled();
  });
});
