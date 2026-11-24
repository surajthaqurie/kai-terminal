// @vitest-environment jsdom
/**
 * UI primitives (src/components/ui) and the command palette rebuilt on them
 * (audit H6, M8): roles, labels, keyboard behaviour, ranking and recents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CommandPalette, type CommandAction } from "../components/CommandPalette";
import {
  loadRecentCommands,
  rankActions,
  recordRecentCommand,
  withRecentsFirst,
} from "../components/commandRanking";
import { Badge, Banner, Button, Dialog, IconButton, Kbd } from "../components/ui";
import { SessionBanners } from "../components/SessionBanners";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(el: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

beforeEach(() => {
  localStorage.clear();
  // jsdom has no layout: record scroll requests instead.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

const action = (id: string, label: string, category = "General"): CommandAction => ({
  id,
  label,
  category,
  icon: null,
  perform: vi.fn(),
});

describe("command ranking", () => {
  const actions = [
    action("settings", "Open Settings", "App"),
    action("split-right", "Split Pane Right", "Panes"),
    action("split-down", "Split Pane Down", "Panes"),
    action("search", "Find in Terminal", "Terminal"),
    action("theme", "Toggle Theme", "Appearance"),
  ];

  it("ranks label prefix > word start > substring > fuzzy subsequence", () => {
    expect(rankActions(actions, "split").map((a) => a.id)).toEqual(["split-right", "split-down"]);
    expect(rankActions(actions, "set")[0].id).toBe("settings");
    // Fuzzy: s-p-r in order inside "Split Pane Right".
    expect(rankActions(actions, "spr")[0].id).toBe("split-right");
  });

  it("matches every word, in any position ('pane right')", () => {
    expect(rankActions(actions, "pane right").map((a) => a.id)).toEqual(["split-right"]);
  });

  it("also finds commands by category, below label matches", () => {
    expect(rankActions(actions, "appearance").map((a) => a.id)).toEqual(["theme"]);
  });

  it("returns nothing for no match, and keeps original order on ties", () => {
    expect(rankActions(actions, "zzzz")).toEqual([]);
    expect(rankActions(actions, "").map((a) => a.id)).toEqual(actions.map((a) => a.id));
  });

  it("remembers the five most recent commands, newest first, without duplicates", () => {
    for (const id of ["a", "b", "c", "a", "d", "e", "f"]) recordRecentCommand(id);
    expect(loadRecentCommands()).toEqual(["f", "e", "d", "a", "c"]);
    const { items, recentCount } = withRecentsFirst(actions, ["theme", "gone", "search"]);
    expect(recentCount).toBe(2);
    expect(items.map((a) => a.id).slice(0, 2)).toEqual(["theme", "search"]);
    expect(items).toHaveLength(actions.length);
  });
});

describe("command palette", () => {
  function openPalette(actions: CommandAction[], onClose = vi.fn()) {
    vi.useFakeTimers();
    const el = render(createElement(CommandPalette, { isOpen: true, onClose, actions }));
    void act(() => vi.runAllTimers());
    const input = el.querySelector("input")!;
    return { el, input, onClose };
  }

  const key = (target: Element, k: string) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    });

  it("is a modal dialog holding a combobox that controls a listbox", () => {
    const { el, input } = openPalette([action("a", "Alpha"), action("b", "Beta")]);
    const dialog = el.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Command palette");
    expect(input.getAttribute("role")).toBe("combobox");
    const list = el.querySelector('[role="listbox"]')!;
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    expect(el.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(document.activeElement).toBe(input);
  });

  it("moves the active option with the arrow keys and scrolls it into view", () => {
    const { el, input } = openPalette([action("a", "Alpha"), action("b", "Beta")]);
    const options = () => [...el.querySelectorAll('[role="option"]')];
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[0].id);
    key(input, "ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[1].id);
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    key(input, "ArrowDown"); // wraps
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[0].id);
  });

  it("runs the command on Enter (the same perform), records it as recent, and closes", () => {
    const run = action("b", "Beta");
    const { input, onClose } = openPalette([action("a", "Alpha"), run]);
    key(input, "ArrowDown");
    key(input, "Enter");
    expect(run.perform).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(loadRecentCommands()).toEqual(["b"]);
  });

  it("lists recent commands first, labelled Recent, when the query is empty", () => {
    recordRecentCommand("b");
    const { el } = openPalette([action("a", "Alpha"), action("b", "Beta")]);
    const first = el.querySelector('[role="option"]')!;
    expect(first.textContent).toContain("Beta");
    expect(first.textContent).toContain("Recent");
  });

  it("closes on Escape through the shared modal behaviour", () => {
    const { input, onClose } = openPalette([action("a", "Alpha")]);
    key(input, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus to where it was (the terminal) when it closes", () => {
    const terminal = document.createElement("textarea");
    document.body.appendChild(terminal);
    terminal.focus();
    const { onClose } = openPalette([action("a", "Alpha")]);
    act(() => root!.render(createElement(CommandPalette, { isOpen: false, onClose, actions: [] })));
    expect(document.activeElement).toBe(terminal);
    terminal.remove();
  });
});

describe("primitives", () => {
  it("Button defaults to type=button and maps variant/size to classes", () => {
    const el = render(
      createElement(Button, { variant: "danger", size: "sm", disabled: true, children: "Discard" })
    );
    const b = el.querySelector("button")!;
    expect(b.type).toBe("button");
    expect(b.className).toBe("btn btn-danger btn-small");
    expect(b.disabled).toBe(true);
  });

  it("IconButton always has an accessible name and tooltip", () => {
    const el = render(createElement(IconButton, { label: "Close", icon: createElement("svg") }));
    const b = el.querySelector("button")!;
    expect(b.getAttribute("aria-label")).toBe("Close");
    expect(b.title).toBe("Close");
    expect(b.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
  });

  it("Banner announces danger and warning assertively, info politely", () => {
    const el = render(
      createElement(
        "div",
        null,
        createElement(Banner, { tone: "danger", label: "Fault", children: "Shell keeps exiting" }),
        createElement(Banner, { tone: "info", label: "Note", children: "Split refused" })
      )
    );
    const [danger, info] = [...el.querySelectorAll(".banner")];
    expect(danger.getAttribute("role")).toBe("alert");
    expect(danger.classList.contains("banner-danger")).toBe(true);
    expect(info.getAttribute("role")).toBe("status");
  });

  it("SessionBanners marks the crash-loop fault as danger (not just a border colour)", () => {
    const el = render(
      createElement(SessionBanners, {
        pendingRestoreCount: 0,
        onRestoreSession: () => {},
        onDismissRestore: () => {},
        paneNotice: null,
        onDismissNotice: () => {},
        faultMessage: "Shell keeps exiting",
        onRetryFault: () => {},
        onOpenSettings: () => {},
        onDismissFault: () => {},
      })
    );
    const banner = el.querySelector(".banner")!;
    expect(banner.classList.contains("banner-danger")).toBe(true);
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.getAttribute("style")).toBeNull();
  });

  it("Dialog is labelled by its title and closes from its close button", () => {
    const onClose = vi.fn();
    const el = render(
      createElement(Dialog, { open: true, onClose, title: "Rename", children: "body" })
    );
    const dialog = el.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const title = document.getElementById(dialog.getAttribute("aria-labelledby")!)!;
    expect(title.textContent).toBe("Rename");
    act(() => (el.querySelector('[aria-label="Close"]') as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalled();
  });

  it("Badge and Kbd render their classes", () => {
    const el = render(
      createElement(
        "div",
        null,
        createElement(Badge, { tone: "success", children: "Connected" }),
        createElement(Kbd, { className: "palette-shortcut", children: "Ctrl+K" })
      )
    );
    expect(el.querySelector(".badge.badge-success")!.textContent).toBe("Connected");
    expect(el.querySelector("kbd.kbd.palette-shortcut")).not.toBeNull();
  });
});
