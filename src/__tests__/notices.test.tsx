// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { MAX_VISIBLE_NOTICES, NOTICE_AUTO_DISMISS_MS, useNotices } from "../hooks/useNotices";
import { ToastHost } from "../components/ToastHost";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let api: ReturnType<typeof useNotices>;
function Harness({ onDetails }: { onDetails?: () => void }) {
  api = useNotices();
  return <ToastHost notices={api.notices} onDismiss={api.dismiss} onDetails={onDetails} />;
}

let host: HTMLDivElement;
let unmount: () => void;
function mount(onDetails?: () => void) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Harness onDetails={onDetails} />));
  unmount = () => act(() => root.unmount());
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  host.remove();
  vi.useRealTimers();
});

describe("useNotices", () => {
  it("shows a notice and ignores blank messages", () => {
    mount();
    act(() => api.notify("error", "   "));
    expect(api.notices).toHaveLength(0);
    act(() => api.notify("error", "Boom"));
    expect(api.notices.map((n) => n.message)).toEqual(["Boom"]);
  });

  it("does not stack an identical message that is already visible", () => {
    mount();
    act(() => {
      api.notify("error", "Same");
      api.notify("error", "Same");
      api.notify("info", "Same");
    });
    expect(api.notices.map((n) => n.kind)).toEqual(["error", "info"]);
  });

  it("keeps only the newest few so a failure loop cannot bury the UI", () => {
    mount();
    act(() => {
      for (let i = 1; i <= MAX_VISIBLE_NOTICES + 2; i++) api.notify("error", `e${i}`);
    });
    expect(api.notices).toHaveLength(MAX_VISIBLE_NOTICES);
    expect(api.notices[api.notices.length - 1].message).toBe(`e${MAX_VISIBLE_NOTICES + 2}`);
  });

  it("fades confirmations on its own but never an error", () => {
    mount();
    act(() => {
      api.notify("info", "Up to date");
      api.notify("success", "Saved");
      api.notify("error", "Failed");
    });
    act(() => vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS + 50));
    expect(api.notices.map((n) => n.message)).toEqual(["Failed"]);
    act(() => vi.advanceTimersByTime(10 * NOTICE_AUTO_DISMISS_MS));
    expect(api.notices.map((n) => n.message)).toEqual(["Failed"]);
  });

  it("dismisses one notice by id and clears them all", () => {
    mount();
    act(() => {
      api.notify("error", "a");
      api.notify("error", "b");
    });
    act(() => api.dismiss(api.notices[0].id));
    expect(api.notices.map((n) => n.message)).toEqual(["b"]);
    act(() => api.clear());
    expect(api.notices).toHaveLength(0);
  });

  it("leaves no timer behind after unmount", () => {
    mount();
    act(() => api.notify("info", "temp"));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    // afterEach unmounts again: mount a fresh no-op so that stays valid.
    mount();
  });
});

describe("ToastHost", () => {
  it("renders nothing when there are no notices", () => {
    mount();
    expect(host.querySelector(".toast-host")).toBeNull();
  });

  it("announces errors assertively and confirmations politely", () => {
    mount();
    act(() => {
      api.notify("error", "Disk full");
      api.notify("success", "Saved");
    });
    expect(host.querySelector(".toast-error")?.getAttribute("role")).toBe("alert");
    expect(host.querySelector(".toast-success")?.getAttribute("role")).toBe("status");
  });

  it("offers Details on errors only, and calls it", () => {
    const onDetails = vi.fn();
    mount(onDetails);
    act(() => {
      api.notify("info", "FYI");
      api.notify("error", "Bad");
    });
    const details = [...host.querySelectorAll<HTMLButtonElement>("button")].filter(
      (b) => b.textContent === "Details"
    );
    expect(details).toHaveLength(1);
    expect(host.querySelector(".toast-info button.toast-action")).toBeNull();
    act(() => details[0].click());
    expect(onDetails).toHaveBeenCalledTimes(1);
  });

  it("the close button removes just that toast", () => {
    mount();
    act(() => {
      api.notify("error", "first");
      api.notify("error", "second");
    });
    act(() => host.querySelector<HTMLButtonElement>(".toast-close")!.click());
    expect([...host.querySelectorAll(".toast-message")].map((e) => e.textContent)).toEqual([
      "second",
    ]);
  });
});
