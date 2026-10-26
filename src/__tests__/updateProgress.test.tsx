// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { UpdateProgressBar, describeUpdateStep } from "../components/UpdateProgressBar";
import { UpdateResultNotice } from "../components/UpdateResultNotice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, unmount: () => act(() => root.unmount()) };
}

describe("describeUpdateStep", () => {
  it("shows the two visible steps and nothing otherwise", () => {
    expect(describeUpdateStep({ status: "downloading", progress: 41.6, message: null })).toContain(
      "Step 1 of 2 · Downloading 42%"
    );
    expect(describeUpdateStep({ status: "installing", progress: null, message: "Working" })).toBe(
      "Step 2 of 2 · Working"
    );
    expect(describeUpdateStep({ status: "idle", progress: null, message: null })).toBeNull();
  });
});

describe("UpdateProgressBar", () => {
  it("is determinate while downloading", () => {
    const { host, unmount } = render(
      <UpdateProgressBar state={{ status: "downloading", progress: 40 }} />
    );
    const bar = host.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(bar.classList.contains("indeterminate")).toBe(false);
    unmount();
  });

  it("is indeterminate while installing and hidden when idle", () => {
    const a = render(<UpdateProgressBar state={{ status: "installing", progress: null }} />);
    const bar = a.host.querySelector('[role="progressbar"]')!;
    expect(bar.classList.contains("indeterminate")).toBe(true);
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    a.unmount();
    const b = render(<UpdateProgressBar state={{ status: "idle", progress: null }} />);
    expect(b.host.querySelector('[role="progressbar"]')).toBeNull();
    b.unmount();
  });
});

describe("UpdateResultNotice", () => {
  it("announces success and auto-dismisses", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { host, unmount } = render(
      <UpdateResultNotice
        outcome={{ kind: "updated", version: "0.1.8" }}
        onDismiss={onDismiss}
        onRetry={() => {}}
      />
    );
    expect(host.textContent).toContain("Kai updated");
    expect(host.textContent).toContain("v0.1.8");
    act(() => {
      vi.advanceTimersByTime(8100);
    });
    expect(onDismiss).toHaveBeenCalled();
    unmount();
    vi.useRealTimers();
  });

  it("offers a retry on failure and does not auto-dismiss", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const onRetry = vi.fn();
    const { host, unmount } = render(
      <UpdateResultNotice
        outcome={{ kind: "failed", version: "0.1.8" }}
        onDismiss={onDismiss}
        onRetry={onRetry}
      />
    );
    expect(host.textContent).toContain("didn't finish");
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    const retry = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Try again")
    )!;
    act(() => retry.click());
    expect(onRetry).toHaveBeenCalled();
    unmount();
    vi.useRealTimers();
  });
});
