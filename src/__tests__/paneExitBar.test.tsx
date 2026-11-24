// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { PaneExitBar, describeExitCode } from "../components/PaneExitBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("describeExitCode", () => {
  it("shows ordinary codes as they are", () => {
    expect(describeExitCode(1)).toBe("code 1");
    expect(describeExitCode(127)).toBe("code 127");
    expect(describeExitCode(255)).toBe("code 255");
  });

  it("adds hex for a Windows status too large to read as decimal", () => {
    expect(describeExitCode(3221225786)).toBe("code 3221225786 (0xC000013A)"); // Ctrl+C
    expect(describeExitCode(-1073741510)).toBe("code -1073741510 (0xC000013A)");
  });

  it("says when the status is unknown", () => {
    expect(describeExitCode(undefined)).toBe("an unknown status");
  });
});

describe("PaneExitBar", () => {
  it("states the exit and wires Restart and Close", async () => {
    const onRestart = vi.fn();
    const onClose = vi.fn();
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(PaneExitBar, { code: 2, onRestart, onClose })));
    const bar = host.querySelector('[role="status"]')!;
    expect(bar.getAttribute("aria-label")).toBe("Shell exited with code 2");
    const [restart, close] = [...bar.querySelectorAll("button")];
    expect([restart.textContent, close.textContent]).toEqual(["Restart", "Close"]);
    await act(async () => restart.click());
    await act(async () => close.click());
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
