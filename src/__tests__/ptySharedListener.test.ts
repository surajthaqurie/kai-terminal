// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: { payload: unknown }) => void;
const registrations: Array<{ name: string; handler: Handler; unlisten: ReturnType<typeof vi.fn> }> =
  [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    const unlisten = vi.fn();
    registrations.push({ name, handler, unlisten });
    return unlisten;
  }),
}));

describe("PTY events share one Tauri listener", () => {
  beforeEach(() => {
    registrations.length = 0;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("registers once for many panes and fans each event out", async () => {
    const { PtyService } = await import("../services/ptyService");
    const seen: string[] = [];
    const offs = await Promise.all(
      ["a", "b", "c"].map((pane) =>
        PtyService.onPtyOutput((p) => seen.push(`${pane}:${p.id}:${p.data}`))
      )
    );
    const output = registrations.filter((r) => r.name === "pty-output");
    expect(output).toHaveLength(1);

    output[0].handler({ payload: { id: "s1", data: "hi" } });
    expect(seen).toEqual(["a:s1:hi", "b:s1:hi", "c:s1:hi"]);

    offs[0]();
    offs[0](); // idempotent
    output[0].handler({ payload: { id: "s1", data: "x" } });
    expect(seen.slice(3)).toEqual(["b:s1:x", "c:s1:x"]);
    expect(output[0].unlisten).not.toHaveBeenCalled();

    offs[1]();
    offs[2]();
    await Promise.resolve();
    await Promise.resolve();
    expect(output[0].unlisten).toHaveBeenCalledTimes(1);

    // A later pane registers afresh.
    await PtyService.onPtyOutput(() => {});
    expect(registrations.filter((r) => r.name === "pty-output")).toHaveLength(2);
  });

  it("one failing pane does not stop the others", async () => {
    const { PtyService } = await import("../services/ptyService");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    await PtyService.onPtyExit(() => {
      throw new Error("boom");
    });
    await PtyService.onPtyExit((p) => seen.push(p.id));
    registrations.find((r) => r.name === "pty-exit")!.handler({ payload: { id: "s9" } });
    expect(seen).toEqual(["s9"]);
    errSpy.mockRestore();
  });
});
