import { describe, it, expect, vi, afterEach } from "vitest";
import { CODE_MODE_OSC, buildCodeModeSignal, parseCodeModeSignal } from "../core/codeModeSignal";
import { announceCodeMode } from "../cli/activeProject";

/** What xterm hands an OSC handler: the text between `ESC ] 1337 ;` and the terminator. */
function oscPayload(bytes: string): string {
  const m = /^\u001b\](\d+);(.*)\u0007$/s.exec(bytes);
  expect(m).not.toBeNull();
  expect(Number(m![1])).toBe(CODE_MODE_OSC);
  return m![2];
}

describe("per-terminal Code Mode signal", () => {
  it("round-trips a project path on every OS shape", () => {
    for (const p of ["/repo/demo", "C:\Users\Me\My Repo", "/tmp/a;b=c d/ü", "D:/x/y"]) {
      expect(parseCodeModeSignal(oscPayload(buildCodeModeSignal(p)))).toEqual({
        active: true,
        path: p,
      });
    }
  });

  it("round-trips the stop signal", () => {
    expect(parseCodeModeSignal(oscPayload(buildCodeModeSignal(null)))).toEqual({ active: false });
  });

  it("keeps the wire bytes free of control characters inside the payload", () => {
    const body = oscPayload(buildCodeModeSignal("/a\u0007b\u001b]c\n"));
    expect(body).not.toMatch(/[\u0000-\u001f]/);
  });

  it("ignores other OSC 1337 users and malformed data", () => {
    expect(parseCodeModeSignal("File=name=x:AAAA")).toBeNull();
    expect(parseCodeModeSignal("KaiCodeMode=start;")).toBeNull();
    expect(parseCodeModeSignal("KaiCodeMode=start;%E0%A4%A")).toBeNull();
    expect(parseCodeModeSignal("KaiCodeMode=start;%00")).toBeNull();
    expect(parseCodeModeSignal("KaiCodeMode=start;%20")).toBeNull();
    expect(parseCodeModeSignal(`KaiCodeMode=start;${"a".repeat(5000)}`)).toBeNull();
    expect(parseCodeModeSignal("KaiCodeMode=stopx")).toBeNull();
    expect(parseCodeModeSignal("")).toBeNull();
  });
});

describe("announceCodeMode (CLI side)", () => {
  const realTty = process.stdout.isTTY;
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    Object.defineProperty(process.stdout, "isTTY", { value: realTty, configurable: true });
  });

  function run(env: string | undefined, tty: boolean, project: string | null): string[] {
    vi.stubEnv("KAI_TERMINAL", env as string);
    Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    announceCodeMode(project);
    // Only our own writes: the test runner may share stdout.
    const ours = write.mock.calls
      .map((c) => String(c[0]))
      .filter((c) => c.includes(`]${CODE_MODE_OSC};`));
    write.mockRestore();
    return ours;
  }

  it("writes the signal only inside Kai Terminal on a real TTY", () => {
    expect(run("1", true, "/repo")).toEqual([buildCodeModeSignal("/repo")]);
    expect(run("1", true, null)).toEqual([buildCodeModeSignal(null)]);
  });

  it("stays silent in other shells, pipes and CI", () => {
    expect(run(undefined, true, "/repo")).toEqual([]);
    expect(run("0", true, "/repo")).toEqual([]);
    expect(run("1", false, "/repo")).toEqual([]);
  });
});
