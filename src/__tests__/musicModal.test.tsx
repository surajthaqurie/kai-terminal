// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MusicPanel } from "../components/MusicPlayer/MusicPanel";

describe("MusicPanel modal implementation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders as modal backdrop and dialog with proper open state", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={true} onClose={onClose} />);
    });

    const backdrop = container.querySelector(".music-modal-backdrop");
    expect(backdrop).not.toBeNull();
    expect(backdrop?.classList.contains("open")).toBe(true);
    expect(backdrop?.getAttribute("role")).toBe("dialog");
    expect(backdrop?.getAttribute("aria-modal")).toBe("true");

    const dialog = container.querySelector(".music-modal-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("role")).toBe("document");
    expect(container.querySelector(".modal-header.music-head")).not.toBeNull();
  });

  it("renders in closed state without unmounting the DOM structure", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={false} onClose={onClose} />);
    });

    const backdrop = container.querySelector(".music-modal-backdrop");
    expect(backdrop).not.toBeNull();
    expect(backdrop?.classList.contains("closed")).toBe(true);
    expect(backdrop?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".music-modal-dialog")).not.toBeNull();
  });

  it("calls onClose when clicking the modal backdrop", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={true} onClose={onClose} />);
    });

    const backdrop = container.querySelector(".music-modal-backdrop") as HTMLElement;
    expect(backdrop).not.toBeNull();
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when clicking inside the dialog card", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={true} onClose={onClose} />);
    });

    const dialog = container.querySelector(".music-modal-dialog") as HTMLElement;
    expect(dialog).not.toBeNull();
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when pressing Escape key while open", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={true} onClose={onClose} />);
    });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when pressing Escape key while closed", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={false} onClose={onClose} />);
    });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when clicking the close button", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={true} onClose={onClose} />);
    });

    const closeBtn = container.querySelector(".btn-close") as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    closeBtn.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
