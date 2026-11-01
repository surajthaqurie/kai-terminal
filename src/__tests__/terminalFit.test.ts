import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { canFitPane, createPtySizeSync } from "../components/terminalFit";

describe("createPtySizeSync (PTY learns every grid change exactly once)", () => {
  const setup = () => {
    const sent: Array<[string, number, number]> = [];
    const sync = createPtySizeSync((id, cols, rows) => sent.push([id, cols, rows]));
    return { sent, sync };
  };

  it("sends a changed grid and skips a repeat of it", () => {
    const { sent, sync } = setup();
    expect(sync.push("a", 120, 30)).toBe(true);
    expect(sync.push("a", 120, 30)).toBe(false);
    expect(sync.push("a", 120, 40)).toBe(true);
    expect(sent).toEqual([
      ["a", 120, 30],
      ["a", 120, 40],
    ]);
  });

  it("does not resend the spawn grid, but does send a change made during the spawn", () => {
    // The shell was spawned at 80x24; the window grew to 150x45 while the
    // async spawn was in flight (no backend id yet, so that resize was lost).
    const { sent, sync } = setup();
    sync.spawned("a", 80, 24);
    expect(sync.push("a", 80, 24)).toBe(false);
    expect(sync.push("a", 150, 45)).toBe(true);
    expect(sent).toEqual([["a", 150, 45]]);
  });

  it("treats a respawned shell (new id, same grid) as needing the size", () => {
    const { sent, sync } = setup();
    sync.push("a", 100, 30);
    expect(sync.push("b", 100, 30)).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("skips when there is no live session or the grid is empty", () => {
    const { sent, sync } = setup();
    expect(sync.push(null, 100, 30)).toBe(false);
    expect(sync.push("a", 0, 30)).toBe(false);
    expect(sync.push("a", 100, 0)).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("canFitPane (never size a shell from a hidden tab)", () => {
  const box = { clientWidth: 1200, clientHeight: 700 };

  it("fits a visible pane that has a layout box", () => {
    expect(canFitPane(true, box)).toBe(true);
  });

  it("refuses a hidden tab even if its container still reports a size", () => {
    expect(canFitPane(false, box)).toBe(false);
  });

  it("refuses a pane whose container collapsed to nothing (display:none ancestor)", () => {
    expect(canFitPane(true, { clientWidth: 0, clientHeight: 0 })).toBe(false);
    expect(canFitPane(true, { clientWidth: 1200, clientHeight: 0 })).toBe(false);
    expect(canFitPane(true, { clientWidth: 0, clientHeight: 700 })).toBe(false);
  });

  it("refuses before the container is mounted", () => {
    expect(canFitPane(true, null)).toBe(false);
  });
});

describe("TerminalView keeps the PTY grid in sync with xterm", () => {
  const source = readFileSync(resolve(__dirname, "../components/TerminalView.tsx"), "utf8");

  it("pushes the PTY size after a settings (font) refit", () => {
    const effect = source.slice(source.indexOf("// React to settings changes dynamically"));
    const body = effect.slice(0, effect.indexOf("}, [settings]);"));
    expect(body).toContain("if (fitWhenShown()) pushPtySize(term)");
  });

  it("re-syncs the PTY right after spawn, since resizes during the spawn are dropped", () => {
    const start = source.indexOf("backendPtyIdRef.current = sessionInfo.id;");
    const body = source.slice(start, source.indexOf('onStatusRef.current?.("connected")', start));
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("ptySizeSyncRef.current?.spawned(sessionInfo.id, cols, rows)");
    expect(body).toContain("if (fitWhenShown()) pushPtySize(term)");
  });

  it("routes the imperative refit through the de-duplicating push", () => {
    const start = source.indexOf("refit: () => {");
    const body = source.slice(start, source.indexOf("copySelection:", start));
    expect(body).toContain("if (fitWhenShown()) pushPtySize(term)");
    expect(body).not.toContain("resizePty");
  });

  it("refits after fonts load and removes its listener on unmount", () => {
    expect(source).toContain('fontSet?.addEventListener?.("loadingdone", refitAfterFonts)');
    expect(source).toContain('fontSet?.removeEventListener?.("loadingdone", refitAfterFonts)');
    expect(source).toContain("resizeObserver.disconnect()");
  });
});
