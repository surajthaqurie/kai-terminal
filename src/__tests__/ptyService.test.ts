import { describe, it, expect } from "vitest";
import { PtyService } from "../services/ptyService";

describe("PtyService (Mock Fallback)", () => {
  it("should return mock shells when not in Tauri environment", async () => {
    const shells = await PtyService.getAvailableShells();
    expect(shells.length).toBeGreaterThan(0);
    expect(shells[0]).toHaveProperty("id");
    expect(shells[0]).toHaveProperty("name");
    expect(shells[0]).toHaveProperty("path");
  });

  it("should return session info on createPty mock", async () => {
    const session = await PtyService.createPty({
      cols: 80,
      rows: 24,
      cwd: "/tmp",
    });
    expect(session).toBeDefined();
    expect(session.id).toBe("mock-session-1");
    expect(session.cols).toBe(80);
    expect(session.rows).toBe(24);
  });

  it("should register onPtyOutput and onPtyExit listeners without throwing in mock mode", async () => {
    const unlistenOutput = await PtyService.onPtyOutput(() => {});
    const unlistenExit = await PtyService.onPtyExit(() => {});
    expect(typeof unlistenOutput).toBe("function");
    expect(typeof unlistenExit).toBe("function");
    unlistenOutput();
    unlistenExit();
  });
});
