import { describe, it, expect } from "vitest";
import { canFitPane } from "../components/terminalFit";

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
