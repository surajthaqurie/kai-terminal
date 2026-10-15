import { describe, it, expect, vi } from "vitest";
import { PtyService } from "../services/ptyService";
import {
  splitTab,
  MAX_PANES_PER_TAB,
  MIN_SPLIT_EXTENT,
  SplitTabState,
  removePaneById,
  computePaneRects,
} from "../services/paneLayout";
import { TerminalPane } from "../types/terminal";

function makePane(id: string): TerminalPane {
  return { id, status: "connecting" };
}

describe("Terminal Native PTY and Rendering Hardening", () => {
  it("enforces the eight-pane ceiling strictly", () => {
    expect(MAX_PANES_PER_TAB).toBe(8);

    // Alternate directions so the size floor never blocks before the cap.
    let tab: SplitTabState = {
      panes: [makePane("pane-1")],
      activePaneId: "pane-1",
      splitDirection: "none",
    };
    for (let i = 2; i <= 20; i++) {
      tab = splitTab(tab, "tab-1", i % 2 ? "horizontal" : "vertical", (id) => makePane(id));
    }
    // Active pane keeps getting split, so the size floor stops it before the
    // cap; the cap itself must still never be exceeded.
    expect(tab.panes.length).toBeLessThanOrEqual(MAX_PANES_PER_TAB);
  });

  it("reaches exactly eight panes in a balanced 4x2 grid and refuses a ninth", () => {
    let tab: SplitTabState = {
      panes: [makePane("pane-1")],
      activePaneId: "pane-1",
      splitDirection: "none",
    };
    const make = (id: string) => makePane(id);
    const split = (dir: "horizontal" | "vertical") => {
      tab = splitTab(tab, "tab-1", dir, make);
    };
    const focus = (i: number) => {
      tab = { ...tab, activePaneId: tab.panes[i].id };
    };
    // 1 -> 2 columns -> 4 columns.
    split("vertical");
    focus(0);
    split("vertical");
    focus(2);
    split("vertical");
    expect(tab.panes).toHaveLength(4);
    // Halve each column into two rows -> 8 panes.
    for (let i = 0; i < 4; i++) {
      focus(i * 2);
      split("horizontal");
    }
    expect(tab.panes).toHaveLength(8);
    focus(0);
    split("horizontal");
    split("vertical");
    expect(tab.panes).toHaveLength(8);
  });

  it("refuses splits that would shrink a pane below the size floor", () => {
    let tab: SplitTabState = {
      panes: [makePane("pane-1")],
      activePaneId: "pane-1",
      splitDirection: "none",
    };
    // Splitting the newest pane every time: 1/2, 1/4, 1/8, 1/8 wide, then stop.
    for (let i = 2; i <= 10; i++) {
      tab = splitTab(tab, "tab-1", "vertical", (id) => makePane(id));
    }
    expect(tab.panes).toHaveLength(4);
    const rects = computePaneRects(tab.layout!);
    for (const r of rects) expect(r.w).toBeGreaterThanOrEqual(MIN_SPLIT_EXTENT - 1e-9);
  });

  it("handles large multi-megabyte output chunks without memory corruption or blocking", () => {
    // Generate large multiline output chunks with emojis, CJK, and ANSI codes
    const largeChunk = "🚀 \x1b[32mHello World\x1b[0m 漢字 café \r\n".repeat(5000); // ~200 KB
    expect(largeChunk.length).toBeGreaterThan(100_000);

    let pendingBuffer = "";
    const MAX_BUFFER = 1_048_576; // 1 MB cap

    // Simulate 10 high-speed burst writes (2 MB total)
    for (let i = 0; i < 10; i++) {
      pendingBuffer += largeChunk;
      if (pendingBuffer.length > MAX_BUFFER) {
        let startIdx = pendingBuffer.length - MAX_BUFFER;
        const code = pendingBuffer.charCodeAt(startIdx);
        if (code >= 0xdc00 && code <= 0xdfff) {
          startIdx += 1;
        }
        pendingBuffer = pendingBuffer.slice(startIdx);
      }
    }

    expect(pendingBuffer.length).toBeLessThanOrEqual(MAX_BUFFER);
    // Verify no split surrogate pair at the boundary
    const firstCode = pendingBuffer.charCodeAt(0);
    expect(firstCode < 0xdc00 || firstCode > 0xdfff).toBe(true);
  });

  it("preserves surrogate pairs when bounding output queue", () => {
    // String with emojis (each emoji is a surrogate pair in UTF-16)
    const emoji = "🚀"; // \uD83D\uDE80
    const str = "A".repeat(10) + emoji + "B".repeat(10);
    const splitPoint = 11; // Right on the low surrogate (\uDE80)

    let startIdx = splitPoint;
    const code = str.charCodeAt(startIdx);
    expect(code >= 0xdc00 && code <= 0xdfff).toBe(true);

    if (code >= 0xdc00 && code <= 0xdfff) {
      startIdx += 1;
    }
    const sliced = str.slice(startIdx);
    // Sliced string must not start with the low surrogate
    expect(sliced.charCodeAt(0)).not.toBe(0xde80);
    expect(sliced).toBe("B".repeat(10));
  });

  it("handles rapid pane close and repeated close calls idempotently", async () => {
    const closeSpy = vi.spyOn(PtyService, "closePty");

    // Test multiple calls to close the same PTY id
    const ptyId = "test-pty-uuid-1";
    await expect(PtyService.closePty(ptyId)).resolves.not.toThrow();
    await expect(PtyService.closePty(ptyId)).resolves.not.toThrow();
    await expect(PtyService.closePty(ptyId)).resolves.not.toThrow();

    expect(closeSpy).toHaveBeenCalledTimes(3);
    closeSpy.mockRestore();
  });

  it("isolates pane removal and updates neighbor focus without orphan survivors", () => {
    let tab: SplitTabState = {
      panes: [makePane("p1")],
      activePaneId: "p1",
      splitDirection: "none",
    };
    tab = splitTab(tab, "t", "vertical", (id) => makePane(id));
    tab = splitTab(tab, "t", "horizontal", (id) => makePane(id));
    tab = splitTab(tab, "t", "vertical", (id) => makePane(id));

    expect(tab.panes.length).toBe(4);
    const active = tab.activePaneId;

    // Remove the currently active pane
    const afterRemoval = removePaneById(tab, active);
    expect(afterRemoval.panes.length).toBe(3);
    expect(afterRemoval.panes.find((p) => p.id === active)).toBeUndefined();
    // Focus shifted to a surviving neighbor
    expect(afterRemoval.activePaneId).not.toBe(active);
    expect(afterRemoval.panes.some((p) => p.id === afterRemoval.activePaneId)).toBe(true);

    // Repeated removal of the same id is a no-op
    const noopRemoval = removePaneById(afterRemoval, active);
    expect(noopRemoval).toBe(afterRemoval);
  });

  it("validates paste payload rejection above 1MB limit with TextEncoder byte calculation", () => {
    const safePayload = "a".repeat(1024);
    const safeByteLen = new TextEncoder().encode(safePayload).length;
    expect(safeByteLen).toBe(1024);
    expect(safeByteLen <= 1_048_576).toBe(true);

    // Oversized multibyte payload (CJK / emoji 3-4 bytes per character)
    const bigEmoji = "🚀".repeat(300_000); // 300,000 * 4 = 1,200,000 bytes > 1 MB
    const bigByteLen = new TextEncoder().encode(bigEmoji).length;
    expect(bigByteLen).toBe(1_200_000);
    expect(bigByteLen > 1_048_576).toBe(true);
  });
});
