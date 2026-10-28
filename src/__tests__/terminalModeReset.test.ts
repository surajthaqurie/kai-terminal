import { describe, it, expect, vi, afterEach } from "vitest";
import {
  AGENT_EXIT_CLEANUP_SEQ,
  AGENT_FINISHED_MARKER,
  TERMINAL_MODE_RESET_SEQ,
  scanAgentFinishedTail,
  shouldAutoResetModes,
  stripStaleTerminalReplies,
  stripStuckInputReports,
} from "../services/terminalModes";
import { resetTerminalModesAfterAgent } from "../core/codeModeWorkflow";
import { AGENT_REGISTRY } from "../core/agents";
import { resolveAgent } from "../cli/index";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("terminal mode reset sequence (ghost-typing fix)", () => {
  it("disables mouse, focus-reporting and bracketed-paste modes", () => {
    for (const mode of ["1000", "1002", "1003", "1006", "1004", "2004"]) {
      expect(TERMINAL_MODE_RESET_SEQ).toContain(`[?${mode}l`);
    }
  });

  it("is screen-safe: no erase, scroll, or alt-screen sequences", () => {
    expect(TERMINAL_MODE_RESET_SEQ).not.toMatch(/\[2J/);
    expect(TERMINAL_MODE_RESET_SEQ).not.toMatch(/\?1049[hl]/);
    expect(TERMINAL_MODE_RESET_SEQ).not.toMatch(/\?47[hl]/);
    expect(TERMINAL_MODE_RESET_SEQ).not.toMatch(/\[3J/);
  });

  it("agent-finished marker matches the CLI log line", () => {
    expect("[kai] Agent finished (command exited with code 0, 67134ms).").toContain(
      AGENT_FINISHED_MARKER
    );
  });
});

describe("scanAgentFinishedTail", () => {
  it("detects the marker in a single chunk", () => {
    const { hit } = scanAgentFinishedTail("", "foo [kai] Agent finished (command exited");
    expect(hit).toBe(true);
  });

  it("detects the marker split across chunk boundaries", () => {
    const first = scanAgentFinishedTail("", "foo [kai] Agent fin");
    expect(first.hit).toBe(false);
    const second = scanAgentFinishedTail(first.tail, "ished (command exited");
    expect(second.hit).toBe(true);
  });

  it("does not fire on ordinary output and keeps a bounded tail", () => {
    let tail = "";
    for (const chunk of ["ls\n", "README.md\n", "$ "]) {
      const r = scanAgentFinishedTail(tail, chunk);
      expect(r.hit).toBe(false);
      tail = r.tail;
    }
    expect(tail.length).toBeLessThanOrEqual(AGENT_FINISHED_MARKER.length);
  });
});

describe("stripStuckInputReports", () => {
  // Exact fragments from the ghost-typing screenshot.
  const sgrLeak = "05;20;1M\x1b[078;8M5;181;9;10731M";
  const x10Leak = "\x1b[M#\xc3\x93;206;53M";
  const focusLeak = "\x1b[I\x1b[O";

  it("strips SGR mouse reports on the normal buffer", () => {
    expect(stripStuckInputReports("\x1b[<35;3;3M", false)).toBe("");
    expect(stripStuckInputReports("\x1b[<0;10;20m", false)).toBe("");
    // Screenshot-style stream with a real report embedded in echo garbage.
    expect(stripStuckInputReports(`\x1b[<35;20;1M${sgrLeak}`, false)).not.toContain("\x1b[<");
  });

  it("strips X10 mouse and focus reports on the normal buffer", () => {
    expect(stripStuckInputReports(x10Leak, false)).not.toContain("\x1b[M");
    expect(stripStuckInputReports(focusLeak, false)).toBe("");
  });

  it("keeps normal typing, arrows and paste markers intact", () => {
    expect(stripStuckInputReports("ls -la\r", false)).toBe("ls -la\r");
    expect(stripStuckInputReports("\x1b[A\x1b[B", false)).toBe("\x1b[A\x1b[B");
    expect(stripStuckInputReports("\x1b[200~pasted\x1b[201~", false)).toBe(
      "\x1b[200~pasted\x1b[201~"
    );
  });

  it("passes TUI mouse through untouched on the alternate screen", () => {
    expect(stripStuckInputReports("\x1b[<35;3;3M", true)).toBe("\x1b[<35;3;3M");
    expect(stripStuckInputReports(focusLeak, true)).toBe(focusLeak);
  });

  it("strips a leak glued to real typing, keeping the typing", () => {
    expect(stripStuckInputReports("ec\x1b[<35;3;3Mho\r", false)).toBe("echo\r");
  });
});

describe("shouldAutoResetModes (gentle reset policy)", () => {
  it("ignores the first stray report to protect TUI startup", () => {
    expect(shouldAutoResetModes(0, false)).toBe(false);
    expect(shouldAutoResetModes(1, false)).toBe(false);
  });

  it("resets on repeated reports (genuinely stuck modes)", () => {
    expect(shouldAutoResetModes(2, false)).toBe(true);
    expect(shouldAutoResetModes(10, false)).toBe(true);
  });

  it("resets immediately once the agent-finished marker proved the TUI is gone", () => {
    expect(shouldAutoResetModes(0, true)).toBe(true);
    expect(shouldAutoResetModes(1, true)).toBe(true);
  });
});

describe("agent funnel audit (all agents, all OS)", () => {
  it("every registry agent id and alias resolves to the reset-covered workflow", () => {
    // `kai <agent>` and `kai run -- <agent>` both route through
    // executeAgentWorkflow -> runExternalAgentCommand, which always emits
    // the terminal-mode reset on settle. An agent that failed to resolve
    // here would fall through to "unknown command" (no spawn, no modes).
    expect(AGENT_REGISTRY.length).toBeGreaterThan(0);
    for (const agent of AGENT_REGISTRY) {
      expect(resolveAgent(agent.id), `agent id ${agent.id}`).not.toBeNull();
      for (const alias of agent.aliases) {
        expect(resolveAgent(alias), `agent alias ${alias}`).not.toBeNull();
      }
    }
  });

  it("builtin command names never resolve as agents", () => {
    for (const builtin of ["run", "mcp", "list", "graph", "stop", "remove"]) {
      expect(resolveAgent(builtin), `builtin ${builtin}`).toBeNull();
    }
  });
});

describe("resetTerminalModesAfterAgent", () => {
  it("writes the reset sequence on a TTY stdout", () => {
    const writes: string[] = [];
    vi.stubGlobal("process", {
      ...process,
      stdout: { isTTY: true, write: (s: string) => void writes.push(s) },
    });
    resetTerminalModesAfterAgent();
    expect(writes.join("")).toContain(TERMINAL_MODE_RESET_SEQ);
  });

  it("erases the agent's leftover last frame only when asked", () => {
    const writes: string[] = [];
    vi.stubGlobal("process", {
      ...process,
      stdout: { isTTY: true, write: (s: string) => void writes.push(s) },
    });
    resetTerminalModesAfterAgent();
    expect(writes.join("")).not.toContain(AGENT_EXIT_CLEANUP_SEQ);
    writes.length = 0;
    resetTerminalModesAfterAgent({ clearStaleUi: true });
    const out = writes.join("");
    expect(out).toContain(TERMINAL_MODE_RESET_SEQ);
    expect(out.endsWith("\r\x1b[J")).toBe(true);
    // Below-cursor erase only: never the whole screen, scrollback or alt screen.
    expect(AGENT_EXIT_CLEANUP_SEQ).not.toMatch(/\[[23]J|\?1049|\?47/);
  });

  it("stays silent when stdout is piped (CI/logs)", () => {
    const writes: string[] = [];
    vi.stubGlobal("process", {
      ...process,
      stdout: { isTTY: false, write: (s: string) => void writes.push(s) },
    });
    resetTerminalModesAfterAgent();
    expect(writes).toHaveLength(0);
  });
});

describe("stripStaleTerminalReplies (leftover query replies after agent exit)", () => {
  it("drops DA1/DA2, CPR, DECRQM and kitty-keyboard replies", () => {
    for (const reply of ["[?1;2c", "[>0;276;0c", "[24;80R", "[?2004;2$y", "[?0u"]) {
      expect(stripStaleTerminalReplies(reply)).toBe("");
    }
  });

  it("drops OSC colour replies (BEL and ST terminated) and XTVERSION", () => {
    expect(stripStaleTerminalReplies("]11;rgb:0000/0000/0000\x07")).toBe("");
    expect(stripStaleTerminalReplies("]10;rgb:ffff/ffff/ffff\\")).toBe("");
    expect(stripStaleTerminalReplies("P>|xterm.js(5.5.0)\\")).toBe("");
    expect(stripStaleTerminalReplies("P>|xterm.js(6.0.0)\\")).toBe("");
  });

  it("keeps real typing, arrows, Delete and Alt+key untouched", () => {
    for (const key of ["a", "ls -la", "\r", "[A", "[D", "\x7f", "[3~", "b"]) {
      expect(stripStaleTerminalReplies(key)).toBe(key);
    }
  });

  it("removes only the reply when mixed with typed text", () => {
    expect(stripStaleTerminalReplies("x[?1;2cy")).toBe("xy");
  });
});
