import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { claimPtyId, createEarlyPtyEvents, releasePtyId } from "../services/ptyEarlyEvents";

const out = (id: string, data: string) => ({ kind: "output" as const, id, data });
const exit = (id: string, exit_code = 0) => ({ kind: "exit" as const, id, exit_code });

describe("createEarlyPtyEvents (events that beat the create_pty reply)", () => {
  it("returns only the events of the session that was spawned, in arrival order", () => {
    const early = createEarlyPtyEvents(() => false);
    early.hold(out("mine", "PS C:\\> "));
    early.hold(out("other-spawning", "bash$ "));
    early.hold(out("mine", "ready"));
    expect(early.take("mine")).toEqual([out("mine", "PS C:\\> "), out("mine", "ready")]);
  });

  it("keeps an instant exit so a shell that dies at launch is not left 'connected'", () => {
    const early = createEarlyPtyEvents(() => false);
    early.hold(out("mine", "boom"));
    early.hold(exit("mine", 1));
    expect(early.take("mine")).toEqual([out("mine", "boom"), exit("mine", 1)]);
  });

  it("empties the buffer once taken, so nothing is replayed twice", () => {
    const early = createEarlyPtyEvents(() => false);
    early.hold(out("mine", "x"));
    early.take("mine");
    expect(early.take("mine")).toEqual([]);
  });

  it("ignores output of sessions another pane already owns (a busy pane cannot crowd out the buffer)", () => {
    const early = createEarlyPtyEvents((id) => id === "busy");
    for (let i = 0; i < 5000; i++) early.hold(out("busy", "yes\n"));
    early.hold(out("mine", "prompt"));
    expect(early.take("mine")).toEqual([out("mine", "prompt")]);
  });

  it("bounds the buffer by event count, dropping the oldest and keeping the newest", () => {
    const early = createEarlyPtyEvents(() => false);
    for (let i = 0; i < 1000; i++) early.hold(out("mine", String(i)));
    const kept = early.take("mine");
    expect(kept.length).toBeLessThanOrEqual(256);
    expect(kept[kept.length - 1]).toEqual(out("mine", "999"));
  });

  it("bounds the buffer by output size", () => {
    const early = createEarlyPtyEvents(() => false);
    const chunk = "x".repeat(400_000);
    early.hold(out("mine", chunk));
    early.hold(out("mine", chunk));
    early.hold(out("mine", chunk));
    const kept = early.take("mine");
    expect(
      kept.reduce((n, e) => n + (e.kind === "output" ? e.data.length : 0), 0)
    ).toBeLessThanOrEqual(1_048_576);
    expect(kept.length).toBe(2);
  });

  it("clear() discards everything held", () => {
    const early = createEarlyPtyEvents(() => false);
    early.hold(out("mine", "x"));
    early.clear();
    expect(early.take("mine")).toEqual([]);
  });

  it("uses the shared claimed-id registry by default", () => {
    const early = createEarlyPtyEvents();
    claimPtyId("owned-by-another-pane");
    early.hold(out("owned-by-another-pane", "noise"));
    expect(early.take("owned-by-another-pane")).toEqual([]);
    releasePtyId("owned-by-another-pane");
    early.hold(out("owned-by-another-pane", "now unowned"));
    expect(early.take("owned-by-another-pane")).toHaveLength(1);
  });
});

describe("TerminalView replays early PTY events after spawn", () => {
  const source = readFileSync(resolve(__dirname, "../components/TerminalView.tsx"), "utf8");

  it("holds events for unknown ids only while a spawn is in flight", () => {
    expect(source).toContain("else if (spawningRef.current)");
    expect(source).toContain('hold({ kind: "output"');
    expect(source).toContain('kind: "exit"');
  });

  it("replays them after the session id is assigned and 'connected' is reported", () => {
    const start = source.indexOf("backendPtyIdRef.current = sessionInfo.id;");
    const body = source.slice(start, source.indexOf("} catch (err: unknown) {", start));
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("claimPtyId(sessionInfo.id)");
    expect(body.indexOf('onStatusRef.current?.("connected")')).toBeLessThan(
      body.indexOf("replayEarlyEventsRef.current(")
    );
  });

  it("releases the session id when the shell exits, respawns, or the pane unmounts", () => {
    expect(source.match(/releasePtyId\(/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
