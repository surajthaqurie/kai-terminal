// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ESCAPE_OWNER_ATTR, useModalBehavior } from "../hooks/useModalBehavior";
import { SettingsModal } from "../components/SettingsModal";
import { DEFAULT_SETTINGS } from "../services/settingsService";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Dialog({
  id,
  isOpen,
  onClose,
  ownEscape,
}: {
  id: string;
  isOpen: boolean;
  onClose: () => void;
  ownEscape?: boolean;
}) {
  const ref = useModalBehavior(isOpen, onClose);
  if (!isOpen) return null;
  return (
    <div ref={ref} data-testid={id}>
      <button id={`${id}-first`}>first</button>
      <input id={`${id}-input`} {...{ [ESCAPE_OWNER_ATTR]: ownEscape ? "true" : undefined }} />
      <button id={`${id}-last`}>last</button>
    </div>
  );
}

let host: HTMLDivElement;
let root: Root;
const render = (node: React.ReactElement) => act(async () => root.render(node));
const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })
    );
  });
const $ = (sel: string) => host.querySelector(sel) as HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("useModalBehavior", () => {
  it("moves focus into the dialog on open and restores it on close", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    await render(<Dialog id="a" isOpen onClose={() => {}} />);
    expect($("[data-testid=a]").contains(document.activeElement)).toBe(true);

    await render(<Dialog id="a" isOpen={false} onClose={() => {}} />);
    expect(document.activeElement).toBe(outside);
  });

  it("does not steal focus from a control inside that already took it (autofocus)", async () => {
    function AutoFocusDialog() {
      const ref = useModalBehavior(true, () => {});
      return (
        <div ref={ref}>
          <input id="auto" autoFocus />
        </div>
      );
    }
    await render(<AutoFocusDialog />);
    expect(document.activeElement?.id).toBe("auto");
  });

  it("Escape closes the dialog and stops the event so other Escape handlers never see it", async () => {
    const onClose = vi.fn();
    const other = vi.fn();
    window.addEventListener("keydown", other);
    await render(<Dialog id="a" isOpen onClose={onClose} />);
    await key("Escape", {}, $("#a-first"));
    window.removeEventListener("keydown", other);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it("leaves Escape to a control that is using it, and closes on the next press", async () => {
    const onClose = vi.fn();
    await render(<Dialog id="a" isOpen onClose={onClose} ownEscape />);
    await key("Escape", {}, $("#a-input"));
    expect(onClose).not.toHaveBeenCalled();
    await render(<Dialog id="a" isOpen onClose={onClose} ownEscape={false} />);
    await key("Escape", {}, $("#a-input"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape that an earlier capture-phase handler already consumed", async () => {
    const onClose = vi.fn();
    // Registered before the dialog opens, so it runs first (same phase and target).
    const consume = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener("keydown", consume, true);
    try {
      await render(<Dialog id="a" isOpen onClose={onClose} />);
      await key("Escape", {}, $("#a-first"));
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", consume, true);
    }
  });

  it("only the topmost of two stacked dialogs reacts", async () => {
    const lower = vi.fn();
    const upper = vi.fn();
    await render(
      <>
        <Dialog id="lower" isOpen onClose={lower} />
        <Dialog id="upper" isOpen onClose={upper} />
      </>
    );
    await key("Escape", {}, $("#upper-first"));
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();

    await render(
      <>
        <Dialog id="lower" isOpen onClose={lower} />
        <Dialog id="upper" isOpen={false} onClose={upper} />
      </>
    );
    await key("Escape", {}, $("#lower-first"));
    expect(lower).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside the dialog in both directions", async () => {
    await render(<Dialog id="a" isOpen onClose={() => {}} />);
    $("#a-last").focus();
    await key("Tab", {}, $("#a-last"));
    expect(document.activeElement?.id).toBe("a-first");
    await key("Tab", { shiftKey: true }, $("#a-first"));
    expect(document.activeElement?.id).toBe("a-last");
  });

  it("pulls focus back in when Tab is pressed with focus outside the dialog", async () => {
    await render(<Dialog id="a" isOpen onClose={() => {}} />);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    await key("Tab", {}, outside);
    expect($("[data-testid=a]").contains(document.activeElement)).toBe(true);
  });

  it("does nothing while closed", async () => {
    const onClose = vi.fn();
    await render(<Dialog id="a" isOpen={false} onClose={onClose} />);
    await key("Escape");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("SettingsModal", () => {
  const settingsProps = {
    settings: DEFAULT_SETTINGS,
    onSaveSettings: vi.fn(),
    shells: [],
  };

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    await render(<SettingsModal isOpen onClose={onClose} {...settingsProps} />);
    await key("Escape", {}, $(".settings-modal"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("puts the saved theme back when it closes without saving, however it was closed", async () => {
    await render(<SettingsModal isOpen onClose={() => {}} {...settingsProps} />);
    // A previewed theme is on the document while the dialog is open.
    document.documentElement.setAttribute("data-theme", "dracula");
    document.body.setAttribute("data-theme", "dracula");

    // Closed from outside (the Settings shortcut flips isOpen): no cancel handler runs.
    await render(<SettingsModal isOpen={false} onClose={() => {}} {...settingsProps} />);
    expect(document.documentElement.getAttribute("data-theme")).toBe(DEFAULT_SETTINGS.theme);
    expect(document.body.getAttribute("data-theme")).toBe(DEFAULT_SETTINGS.theme);
  });

  it("Escape cancels shortcut recording first and closes the dialog on the next press", async () => {
    const onClose = vi.fn();
    await render(<SettingsModal isOpen onClose={onClose} {...settingsProps} />);
    const shortcutsTab = [...host.querySelectorAll<HTMLButtonElement>(".modal-tab-btn")].find((b) =>
      b.textContent?.includes("Shortcuts")
    )!;
    await act(async () => shortcutsTab.click());

    const recorder = $(".shortcut-input") as HTMLInputElement;
    await act(async () => recorder.focus());
    expect(recorder.value).toBe("Press shortcut...");

    await key("Escape", {}, recorder);
    expect(onClose).not.toHaveBeenCalled();
    expect(recorder.value).not.toBe("Press shortcut...");

    await key("Escape", {}, recorder);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens on the tab it is asked to, and keeps the usual first tab otherwise", async () => {
    const activeTabLabel = () =>
      host.querySelector<HTMLButtonElement>(".modal-tab-btn.active")?.textContent ?? "";
    await render(<SettingsModal isOpen onClose={() => {}} {...settingsProps} />);
    expect(activeTabLabel()).toContain("Appearance");

    await render(<SettingsModal isOpen={false} onClose={() => {}} {...settingsProps} />);
    await render(
      <SettingsModal isOpen initialTab="shortcuts" onClose={() => {}} {...settingsProps} />
    );
    expect(activeTabLabel()).toContain("Shortcuts");
    expect($("input.shortcut-filter")).not.toBeNull();
  });

  describe("Shortcuts tab", () => {
    const openShortcuts = async () => {
      await render(<SettingsModal isOpen onClose={() => {}} {...settingsProps} />);
      const tab = [...host.querySelectorAll<HTMLButtonElement>(".modal-tab-btn")].find((b) =>
        b.textContent?.includes("Shortcuts")
      )!;
      await act(async () => tab.click());
    };
    const row = (label: string) =>
      [...host.querySelectorAll<HTMLElement>(".shortcut-row-item")].find(
        (r) => r.querySelector(".shortcut-label")?.textContent === label
      )!;
    const input = (label: string) => row(label).querySelector<HTMLInputElement>("input")!;
    const reset = (label: string) =>
      row(label).querySelector<HTMLButtonElement>(".shortcut-reset")!;
    const record = async (label: string, init: KeyboardEventInit) => {
      await act(async () => input(label).focus());
      await key(init.key ?? "", init, input(label));
    };

    it("groups the shortcuts by what they act on", async () => {
      await openShortcuts();
      const headings = [...host.querySelectorAll(".settings-tab-panel label")].map(
        (l) => l.textContent
      );
      expect(headings).toEqual(expect.arrayContaining(["Tabs", "Panes", "App", "Music Time"]));
      expect(input("Split terminal (vertical)").value).toBe("Alt+Shift+=");
    });

    it("records Ctrl+Tab-style chords and offers a per-row reset only once changed", async () => {
      await openShortcuts();
      expect(reset("Next tab").disabled).toBe(true);
      await record("Next tab", { key: "ArrowRight", code: "ArrowRight", ctrlKey: true });
      expect(input("Next tab").value).toBe("Ctrl+ArrowRight");
      expect(reset("Next tab").disabled).toBe(false);
      await act(async () => reset("Next tab").click());
      expect(input("Next tab").value).toBe("Ctrl+Tab");
      expect(reset("Next tab").disabled).toBe(true);
    });

    describe("find a shortcut", () => {
      const filter = async (text: string) => {
        const box = $("input.shortcut-filter") as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        await act(async () => {
          setter.call(box, text);
          box.dispatchEvent(new Event("input", { bubbles: true }));
        });
      };
      const labels = () =>
        [...host.querySelectorAll(".shortcut-row-item .shortcut-label")].map((l) => l.textContent);

      it("lists every shortcut when the box is empty", async () => {
        await openShortcuts();
        expect(labels()).toEqual(
          expect.arrayContaining(["New tab", "Music: previous song", "Zoom in"])
        );
      });

      it("finds a shortcut by name, by group, or by its keys", async () => {
        await openShortcuts();
        await filter("music");
        expect(labels()).toEqual([
          "Show / hide music player",
          "Music: play / pause",
          "Music: previous song",
          "Music: next song",
          "Music: mute / unmute",
        ]);
        // Hides the groups with nothing left in them.
        const headings = [...host.querySelectorAll(".settings-tab-panel label")].map(
          (l) => l.textContent
        );
        expect(headings).toContain("Music Time");
        expect(headings).not.toContain("Tabs");

        await filter("ctrl shift w");
        expect(labels()).toEqual(["Close tab or pane"]);
        await filter("Ctrl+Shift+W");
        expect(labels()).toEqual(["Close tab or pane"]);
        await filter("split");
        expect(labels()).toEqual(["Split terminal (vertical)", "Split terminal (horizontal)"]);
      });

      it("says so when nothing matches, and clearing it brings everything back", async () => {
        await openShortcuts();
        await filter("zzzz");
        expect(labels()).toEqual([]);
        expect(host.textContent).toContain("No shortcut matches");
        await filter("");
        expect(labels().length).toBeGreaterThan(20);
      });

      it("a shortcut being edited keeps working while filtered", async () => {
        await openShortcuts();
        await filter("previous song");
        await record("Music: previous song", {
          key: "B",
          code: "KeyB",
          ctrlKey: true,
          shiftKey: true,
        });
        expect(input("Music: previous song").value).toBe("Ctrl+Shift+B");
      });
    });

    it("names the other action when two shortcuts collide", async () => {
      await openShortcuts();
      await record("Find in terminal", { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true });
      const alerts = [...host.querySelectorAll(".shortcut-input-group .error-text")].map(
        (e) => e.textContent ?? ""
      );
      expect(alerts.some((t) => t.includes('"Toggle command palette"'))).toBe(true);
      expect(alerts.some((t) => t.includes('"Find in terminal"'))).toBe(true);
    });
  });
});
