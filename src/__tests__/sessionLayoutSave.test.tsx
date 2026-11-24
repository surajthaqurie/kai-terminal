// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionPersistence } from "../hooks/useSessionPersistence";
import {
  ACTIVE_TAB_KEY,
  LAYOUT_KEY,
  MAX_PERSISTED_TABS,
  createDefaultTab,
  loadPersistedLayout,
} from "../services/tabFactory";
import type { TerminalTab } from "../types/terminal";

/**
 * FUNC-07: the saved layout kept only 10 tabs (an 11th vanished after a restart, silently),
 * forgot which tab was in front, and was serialised and written synchronously on every change.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Api {
  tabs: TerminalTab[];
  setTabs: (t: TerminalTab[]) => void;
  activeTabId: string;
  setActive: (id: string) => void;
  persistence: ReturnType<typeof useSessionPersistence>;
}
let api: Api;
let root: Root;

function Harness() {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [createDefaultTab("Terminal 1")]);
  const [activeTabId, setActive] = useState(() => tabs[0].id);
  const persistence = useSessionPersistence({
    tabs,
    setTabs,
    setActiveTabId: setActive,
    activeTabId,
    autoRestoreSession: false,
  });
  api = { tabs, setTabs, activeTabId, setActive, persistence };
  return null;
}

const named = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    createDefaultTab(`Tab ${i + 1}`, undefined, `/work/${i + 1}`)
  );
const saved = () =>
  JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "[]") as Array<{ title: string }>;

async function mount() {
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

describe("saved layout", () => {
  it("keeps more than ten tabs", async () => {
    await mount();
    const twelve = named(12);
    await act(async () => api.setTabs(twelve));
    await act(async () => void vi.advanceTimersByTime(600));
    expect(MAX_PERSISTED_TABS).toBeGreaterThanOrEqual(12);
    expect(saved().map((t) => t.title)).toEqual(twelve.map((t) => t.title));
    expect(loadPersistedLayout()).toHaveLength(12);
  });

  it("remembers which tab was in front, and brings it back on restore", async () => {
    await mount();
    const tabs = named(5);
    await act(async () => {
      api.setTabs(tabs);
      api.setActive(tabs[3].id);
    });
    await act(async () => void vi.advanceTimersByTime(600));
    expect(localStorage.getItem(ACTIVE_TAB_KEY)).toBe("3");

    // A new launch: the starter tab is replaced by the saved ones, with the right one in front.
    await act(async () => root.unmount());
    await mount();
    expect(api.persistence.pendingRestore).toHaveLength(5);
    await act(async () => api.persistence.restoreSession());
    expect(api.tabs.map((t) => t.title)).toEqual(tabs.map((t) => t.title));
    expect(api.activeTabId).toBe(api.tabs[3].id);
  });

  it("is written once after a burst of changes, not once per change", async () => {
    await mount();
    await act(async () => void vi.advanceTimersByTime(600)); // settle the initial save
    const write = vi.spyOn(Storage.prototype, "setItem");
    for (let i = 0; i < 25; i++) {
      await act(async () => api.setTabs(named(2 + (i % 3))));
      await act(async () => void vi.advanceTimersByTime(40));
    }
    expect(write.mock.calls.filter(([k]) => k === LAYOUT_KEY)).toHaveLength(0); // still quiet
    await act(async () => void vi.advanceTimersByTime(600));
    expect(write.mock.calls.filter(([k]) => k === LAYOUT_KEY)).toHaveLength(1);
    write.mockRestore();
  });

  it("is not lost when the window closes before the quiet period ends", async () => {
    await mount();
    await act(async () => api.setTabs(named(3)));
    expect(saved().map((t) => t.title)).not.toEqual(["Tab 1", "Tab 2", "Tab 3"]); // not yet
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(saved().map((t) => t.title)).toEqual(["Tab 1", "Tab 2", "Tab 3"]);
  });

  it("is flushed when the hook unmounts too", async () => {
    await mount();
    await act(async () => api.setTabs(named(2)));
    await act(async () => root.unmount());
    expect(saved().map((t) => t.title)).toEqual(["Tab 1", "Tab 2"]);
    root = createRoot(document.createElement("div")); // so afterEach can unmount
  });
});
