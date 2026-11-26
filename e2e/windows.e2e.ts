/**
 * FUNC-07 in the real app, with the real Tauri window list and window labels (an ACL that denied
 * them would make the feature silently do nothing, which unit tests with mocks cannot see).
 *
 * WebDriver starts every session in a fresh temporary WebView2 profile, so a real quit and
 * relaunch cannot be observed here (storage never survives a session). The previous session is
 * therefore written into storage and the main page reloaded, which is what a launch reads.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DRIVER_URL, appPath } from "./globalSetup";
import { Key, Session, killApp, waitFor } from "./webdriver";

let s: Session | undefined;

const count = (css: string) =>
  s!.execute<number>("return document.querySelectorAll(arguments[0]).length;", css);

/** Labels of the open windows, through the same Tauri API the app uses. */
const windowLabels = () =>
  s!.execute<string[]>(
    "return window.__TAURI_INTERNALS__.invoke('plugin:window|get_all_windows');"
  );

const savedExtras = () =>
  s!.execute<Record<string, { tabs: Array<{ title: string }> }>>(
    "return JSON.parse(localStorage.getItem('terminal_extra_windows_v1') || '{}');"
  );

afterEach(async () => {
  await s?.quit().catch(() => {});
  s = undefined;
  killApp(appPath());
});

describe("windows of the last session (FUNC-07)", () => {
  it("another window saves under its label; the previous windows are offered and reopened", async () => {
    s = await Session.create(DRIVER_URL, appPath());
    await waitFor(
      "the first terminal",
      async () => (await count(".xterm-helper-textarea")) > 0,
      60_000
    );
    const main = (await s.windowHandles())[0];

    // A second window saves its tabs under its own label.
    await s.type((await s.findAll(".xterm-helper-textarea"))[0], "");
    await s.chord(Key.Control, Key.Shift, "n");
    await waitFor("a second window", async () => (await windowLabels()).length === 2);
    const live = (await windowLabels()).find((l) => l !== "main")!;
    await waitFor("its saved layout", async () => Boolean((await savedExtras())[live]), 15_000);

    // The main window gets a second tab, saved the normal way (the reload below flushes it).
    await s.switchToWindow(main);
    await s.type((await s.findAll(".xterm-helper-textarea"))[0], "");
    await s.chord(Key.Control, Key.Shift, "t");
    await waitFor(
      "a second tab in the main window",
      async () => (await count("[data-tab-id]")) === 2
    );

    // A window of the previous session that is not open now, with two tabs.
    await s.execute(
      `const extras = JSON.parse(localStorage.getItem('terminal_extra_windows_v1') || '{}');
       extras['term-7'] = { tabs: [{ title: 'w-a' }, { title: 'w-b' }], activeIndex: 1, savedAt: 1 };
       localStorage.setItem('terminal_extra_windows_v1', JSON.stringify(extras));
       location.reload();`
    );
    const banner = await waitFor(
      "the restore offer",
      async () => (await s!.findAll('[aria-label="Restore previous session"]'))[0],
      60_000
    );
    // The live second window is not part of the offer.
    expect(await s.text(banner)).toContain("4 tabs in 2 windows");
    expect(await count("[data-tab-id]")).toBe(1); // a fresh starter tab until Load

    // The banner sits over the terminal area: its buttons must take the click, not xterm.
    const onTop = await s.execute<boolean>(
      `const b = document.querySelector('[aria-label="Restore previous session"] button');
       const r = b.getBoundingClientRect();
       const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
       return hit === b || b.contains(hit);`
    );
    expect(onTop).toBe(true);

    const before = new Set(await s.windowHandles());
    await s.click((await s.findAll('[aria-label="Restore previous session"] button'))[0]);
    const reopened = await waitFor("the other window to reopen", async () =>
      (await s!.windowHandles()).find((h) => !before.has(h))
    );
    await s.switchToWindow(reopened);
    await waitFor("its two tabs", async () => (await count("[data-tab-id]")) === 2);
    const strip = await s.execute<string>(
      "return [...document.querySelectorAll('[data-tab-id]')].map((t) => t.textContent).join('|');"
    );
    expect(strip).toContain("w-a");
    expect(strip).toContain("w-b");

    // The main window got its own two tabs back.
    await s.switchToWindow(main);
    await waitFor(
      "the main window's restored tabs",
      async () => (await count("[data-tab-id]")) === 2
    );
  });
});
