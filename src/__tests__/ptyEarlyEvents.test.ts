import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  MAX_EARLY_EVENTS,
  MAX_EARLY_OUTPUT_CHARS,
  claimPtyId,
  createEarlyPtyEvents,
  releasePtyId,
} from "../services/ptyEarlyEvents";

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
    const total = MAX_EARLY_EVENTS * 2;
    for (let i = 0; i < total; i++) early.hold(out("mine", String(i)));
    const kept = early.take("mine");
    expect(kept.length).toBeLessThanOrEqual(MAX_EARLY_EVENTS);
    expect(kept[kept.length - 1]).toEqual(out("mine", String(total - 1)));
  });

  it("bounds the buffer by output size", () => {
    const early = createEarlyPtyEvents(() => false);
    const chunk = "x".repeat(Math.ceil(MAX_EARLY_OUTPUT_CHARS * 0.4));
    early.hold(out("mine", chunk));
    early.hold(out("mine", chunk));
    early.hold(out("mine", chunk));
    const kept = early.take("mine");
    expect(
      kept.reduce((n, e) => n + (e.kind === "output" ? e.data.length : 0), 0)
    ).toBeLessThanOrEqual(MAX_EARLY_OUTPUT_CHARS);
    expect(kept.length).toBe(2);
  });

  it("is sized above what output flow control allows in flight, so a held event is never dropped", () => {
    // The backend sends at most ~1 MiB (plus a batch) before the frontend acknowledges
    // anything. A dropped early event would also never be acknowledged.
    expect(MAX_EARLY_OUTPUT_CHARS).toBeGreaterThanOrEqual(3 * 1024 * 1024);
    const early = createEarlyPtyEvents(() => false);
    const oneMiB = 1024 * 1024;
    for (let sent = 0; sent < oneMiB + 98_304; sent += 32_768) {
      early.hold(out("mine", "y".repeat(32_768)));
    }
    const kept = early.take("mine");
    expect(kept.reduce((n, e) => n + (e.kind === "output" ? e.data.length : 0), 0)).toBe(
      Math.ceil((oneMiB + 98_304) / 32_768) * 32_768
    );
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
    // Both launch paths (new shell, moved shell) go live through `markLive` then `replayHeld`.
    const live = source.slice(
      source.indexOf("const markLive = "),
      source.indexOf("const replayHeld = ")
    );
    expect(live).toContain("backendPtyIdRef.current = id;");
    expect(live).toContain("claimPtyId(id)");
    expect(live).toContain('onStatusRef.current?.("connected")');
    const held = source.slice(
      source.indexOf("const replayHeld = "),
      source.indexOf("const launchFailed = ")
    );
    expect(held).toContain("replayEarlyEventsRef.current(");
    for (const launch of ["const initPtySession = ", "const adoptSession = "]) {
      const body = source.slice(source.indexOf(launch));
      expect(body.indexOf("markLive("), launch).toBeGreaterThan(-1);
      expect(body.indexOf("markLive("), launch).toBeLessThan(body.indexOf("replayHeld("));
    }
  });

  it("releases the session id when the shell exits, respawns, or the pane unmounts", () => {
    expect(source.match(/releasePtyId\(/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
