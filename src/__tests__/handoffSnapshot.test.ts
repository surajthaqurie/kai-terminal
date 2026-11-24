import { describe, expect, it } from "vitest";
import { MAX_HANDOFF_SNAPSHOT_CHARS, boundedSnapshot } from "../services/handoffSnapshot";

/** A serializer whose output is `charsPerRow` per scrollback row plus a 100-char screen. */
const fake = (charsPerRow: number) => {
  const asked: number[] = [];
  const serialize = (rows: number) => {
    asked.push(rows);
    return "x".repeat(100 + rows * charsPerRow);
  };
  return { serialize, asked };
};

describe("boundedSnapshot (REL-08)", () => {
  it("carries every scrollback row when the snapshot fits", () => {
    const { serialize, asked } = fake(80);
    expect(boundedSnapshot(serialize, 10_000)).toHaveLength(100 + 10_000 * 80);
    expect(asked).toEqual([10_000]);
  });

  it("halves the rows only while the snapshot is too large", () => {
    const { serialize, asked } = fake(100);
    const text = boundedSnapshot(serialize, 100_000, 2_000_000);
    expect(asked).toEqual([100_000, 50_000, 25_000, 12_500]);
    expect(text.length).toBeLessThanOrEqual(2_000_000);
  });

  it("keeps the visible screen even when no history fits", () => {
    const { serialize, asked } = fake(1_000);
    expect(boundedSnapshot(serialize, 3, 50)).toHaveLength(100);
    expect(asked[asked.length - 1]).toBe(0);
  });

  it("leaves room for several panes under the 32 MB window limit", () => {
    expect(MAX_HANDOFF_SNAPSHOT_CHARS * 6 * 1.5).toBeLessThan(32 * 1024 * 1024);
  });
});
