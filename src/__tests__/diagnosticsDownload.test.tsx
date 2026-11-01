// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("../services/diagnosticsService", () => ({
  getDiagnostics: vi.fn(async () => ({ app: "kai" })),
}));

import { DiagnosticsModal } from "../components/DiagnosticsModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Diagnostics download", () => {
  let root: Root;
  let host: HTMLDivElement;
  const created = vi.fn(() => "blob:kai-test");
  const revoked = vi.fn();

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = created;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revoked;
    created.mockClear();
    revoked.mockClear();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<DiagnosticsModal isOpen onClose={() => {}} />));
    await act(async () => {});
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the blob URL alive while the WebView starts the download, then frees it", async () => {
    const download = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      /download/i.test(b.textContent ?? b.getAttribute("aria-label") ?? "")
    )!;
    await act(async () => download.click());
    expect(created).toHaveBeenCalledTimes(1);
    expect(revoked).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(10_500);
    });
    expect(revoked).toHaveBeenCalledWith("blob:kai-test");
  });
});
