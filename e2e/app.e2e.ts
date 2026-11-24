/**
 * End-to-end workflows in the real Kai window (CI-04): the built app, a real shell, real
 * keystrokes through WebDriver. Run with `npm run test:e2e` (see e2e/globalSetup.ts for what it
 * needs and how it is kept away from a Kai already running on the machine).
 *
 * Commands are chosen to behave the same in cmd, PowerShell and bash (`echo`, `exit N`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRIVER_URL, appPath } from "./globalSetup";
import { Key, Session, waitFor } from "./webdriver";

/** The visible tab's area (hidden tabs stay mounted with display: none). */
const VISIBLE = '.tab-content[style*="block"]';

let s: Session;

/** Text of the visible tab's active pane (DOM renderer, so the rows are real text). */
const paneText = () =>
  s.execute<string>(
    `const root = document.querySelector(arguments[0]);
     const pane = root && (root.querySelector('.active-pane .xterm-rows') || root.querySelector('.xterm-rows'));
     return pane ? pane.textContent : '';`,
    VISIBLE
  );

const count = (css: string) =>
  s.execute<number>("return document.querySelectorAll(arguments[0]).length;", css);

/** Types into the visible tab's active terminal. */
async function typeInTerminal(text: string) {
  const input = await waitFor("the terminal's input", async () => {
    const found = await s.findAll(`${VISIBLE} .active-pane .xterm-helper-textarea`);
    return found[0] ?? (await s.findAll(`${VISIBLE} .xterm-helper-textarea`))[0];
  });
  await s.type(input, text);
}

/** The window's visible text, for a failure message (what the user would have seen). */
const screenText = () =>
  s.execute<string>("return document.body.innerText.slice(-2000);").catch(() => "(unavailable)");

/** `waitFor`, and on timeout the window's text in the error. */
async function expectSoon<T>(what: string, probe: () => Promise<T | null | undefined | false>) {
  try {
    return await waitFor(what, probe);
  } catch (err) {
    throw new Error(`${(err as Error).message}\n--- window text ---\n${await screenText()}`);
  }
}

/** Waits until the visible pane shows a prompt (any output at all). */
const waitForPrompt = () =>
  waitFor("a shell prompt", async () => (await paneText()).trim().length > 0, 30_000);

beforeEach(async () => {
  s = await Session.create(DRIVER_URL, appPath());
  await waitFor(
    "the first terminal",
    async () => (await count(".xterm-helper-textarea")) > 0,
    60_000
  );
  // A clean start for every test (the e2e profile is the app's own, see globalSetup), with the
  // DOM renderer so terminal text can be read: WebGL draws the rows into a canvas.
  await s.execute(
    "localStorage.clear(); localStorage.setItem('kai_renderer', 'dom'); location.reload();"
  );
  await waitFor("the terminal after reload", async () => (await count(".xterm-rows")) > 0, 60_000);
  await waitForPrompt();
});

afterEach(async () => {
  await s?.quit().catch(() => {});
});

describe("Kai end to end", () => {
  it("starts a shell and runs a command in it", async () => {
    await typeInTerminal(`echo kai-e2e-ok${Key.Enter}`);
    // Once in the typed command line, once in its output.
    await waitFor("the command's output", async () => {
      const text = await paneText();
      return (text.match(/kai-e2e-ok/g) ?? []).length >= 2;
    });
  });

  it("Ctrl+Shift+T opens a second tab", async () => {
    expect(await count("[data-tab-id]")).toBe(1);
    await typeInTerminal(""); // focus the terminal, as a user would be
    await s.chord(Key.Control, Key.Shift, "t");
    await waitFor("a second tab", async () => (await count("[data-tab-id]")) === 2);
    await waitForPrompt(); // the new tab has its own shell
  });

  it("Alt+Shift+= splits the terminal into two panes", async () => {
    await typeInTerminal("");
    await s.chord(Key.Alt, Key.Shift, "=");
    await waitFor("two panes", async () => (await count(`${VISIBLE} .pane-grid-pane`)) === 2);
    await waitFor("two terminals", async () => (await count(`${VISIBLE} .xterm-rows`)) === 2);
  });

  it("Ctrl+Shift+F opens find in terminal", async () => {
    await typeInTerminal("");
    await s.chord(Key.Control, Key.Shift, "f");
    await waitFor("the search bar", async () => (await count(".terminal-search-bar")) === 1);
  });

  it("Ctrl+Shift+P opens the command palette and Escape closes it", async () => {
    await typeInTerminal("");
    await s.chord(Key.Control, Key.Shift, "p");
    await waitFor("the command palette", async () => (await count(".command-palette-modal")) === 1);
    await s.chord(Key.Escape);
    await waitFor(
      "the palette to close",
      async () => (await count(".command-palette-modal")) === 0
    );
  });

  it("a failed shell keeps its pane with the exit code, and Restart starts a new shell (FUNC-09)", async () => {
    // In a second tab: the only shell of a window dying within seconds of opening is treated as
    // a shell that never started (Retry banner), which is a different guard.
    await typeInTerminal("");
    await s.chord(Key.Control, Key.Shift, "t");
    await waitFor("a second tab", async () => (await count("[data-tab-id]")) === 2);
    await waitForPrompt();
    await typeInTerminal(`exit 3${Key.Enter}`);
    const bar = await expectSoon(
      "the exit bar",
      async () => (await s.findAll(".pane-exit-bar"))[0]
    );
    expect(await s.attribute(bar, "aria-label")).toBe("Shell exited with code 3");
    const restart = (await s.findAll(".pane-exit-bar button"))[0];
    expect(await s.text(restart)).toBe("Restart");
    await s.click(restart);
    await waitFor("the exit bar to go", async () => (await count(".pane-exit-bar")) === 0);
    await waitForPrompt();
    await typeInTerminal(`echo kai-e2e-again${Key.Enter}`);
    await waitFor(
      "output from the new shell",
      async () => ((await paneText()).match(/kai-e2e-again/g) ?? []).length >= 2
    );
  });
});
