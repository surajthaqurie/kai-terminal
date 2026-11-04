import { describe, expect, it, vi } from "vitest";
import {
  agentInChain,
  ancestorChain,
  chainFromTable,
  isKaiApp,
  matchAgentProcess,
  parseProcStat,
  parsePsTable,
  parseWindowsProcesses,
  type ProcessInfo,
} from "../core/teams/agentProcess";
import { assertNotAgentSession, detectAgentSession } from "../core/teams/guard";

const proc = (pid: number, ppid: number, name: string, cmdline = ""): ProcessInfo => ({
  pid,
  ppid,
  name,
  cmdline,
});

describe("matchAgentProcess", () => {
  it("recognises agent command-line tools by their executable name", () => {
    for (const [name, label] of [
      ["claude.exe", "Claude Code"],
      ["C:\\Users\\me\\.local\\bin\\claude.exe", "Claude Code"],
      ["/usr/local/bin/codex", "Codex"],
      ["gemini", "Gemini CLI"],
      ["opencode", "OpenCode"],
      ["aider.exe", "Aider"],
      ["copilot", "GitHub Copilot CLI"],
      ["Cline.cmd", "Cline"],
      ["cursor-agent", "Cursor Agent"],
    ]) {
      expect(matchAgentProcess({ name, cmdline: "" }), name).toBe(label);
    }
  });

  it("recognises agents that run under node by the package in the command line", () => {
    expect(
      matchAgentProcess({
        name: "node.exe",
        cmdline:
          '"node" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
      })
    ).toBe("Claude Code");
    expect(
      matchAgentProcess({
        name: "node",
        cmdline: "node /usr/lib/node_modules/@openai/codex/bin/codex.js",
      })
    ).toBe("Codex");
    expect(
      matchAgentProcess({
        name: "node",
        cmdline: "node /usr/lib/node_modules/@google/gemini-cli/dist/index.js",
      })
    ).toBe("Gemini CLI");
  });

  it("does not mistake people's tools for agents", () => {
    for (const p of [
      { name: "powershell.exe", cmdline: "powershell -NoProfile" },
      { name: "bash", cmdline: "bash -c cd /home/me/claude-notes" },
      { name: "node", cmdline: "node server.js --gemini-mode" },
      { name: "Code.exe", cmdline: "Code.exe ." },
      { name: "Cursor.exe", cmdline: "Cursor.exe ." },
      { name: "windsurf", cmdline: "" },
      { name: "WindowsTerminal.exe", cmdline: "" },
      { name: "node", cmdline: "node C:\\work\\claude\\notes.js" },
    ]) {
      expect(matchAgentProcess(p), `${p.name} ${p.cmdline}`).toBeNull();
    }
  });
});

describe("agentInChain", () => {
  it("finds an agent among the processes that started this command", () => {
    const chain = [
      proc(5, 4, "node", "node kai.js teams"),
      proc(4, 3, "bash"),
      proc(3, 2, "claude.exe"),
      proc(2, 1, "explorer.exe"),
    ];
    expect(agentInChain(chain)).toBe("Claude Code");
  });

  it("finds nothing in an ordinary terminal", () => {
    const chain = [
      proc(5, 4, "node"),
      proc(4, 3, "pwsh.exe"),
      proc(3, 2, "WindowsTerminal.exe"),
      proc(2, 1, "explorer.exe"),
    ];
    expect(agentInChain(chain)).toBeNull();
  });

  it("stops at the Kai desktop app: a tab inside Kai is a person's, even if something once started the app", () => {
    const chain = [
      proc(5, 4, "node"),
      proc(4, 3, "pwsh.exe"),
      proc(3, 2, "kai.exe"),
      proc(2, 1, "claude.exe"),
    ];
    expect(agentInChain(chain)).toBeNull();
    expect(isKaiApp({ name: "kai.exe" })).toBe(true);
    expect(isKaiApp({ name: "node" })).toBe(false);
  });

  it("still catches an agent started with `kai <agent>` inside a Kai tab", () => {
    const chain = [
      proc(6, 5, "node"),
      proc(5, 4, "codex"),
      proc(4, 3, "node", "kai.js codex ."),
      proc(3, 2, "pwsh.exe"),
      proc(2, 1, "kai.exe"),
    ];
    expect(agentInChain(chain)).toBe("Codex");
  });

  it("cannot see an agent whose shell was started through a launcher that has exited (use the markers)", () => {
    // Real case on Windows: the parent chain ends at an orphaned bash.exe.
    const orphan = [proc(10, 9, "node"), proc(9, 8, "cmd.exe"), proc(8, 7, "bash.exe")];
    expect(agentInChain(orphan)).toBeNull();
  });
});

describe("chainFromTable", () => {
  it("walks parents in order and survives cycles, missing parents and runaway depth", () => {
    const table = [proc(3, 2, "c"), proc(2, 1, "b"), proc(1, 0, "a")];
    expect(chainFromTable(table, 3).map((p) => p.name)).toEqual(["c", "b", "a"]);
    expect(chainFromTable([proc(1, 2, "x"), proc(2, 1, "y")], 1)).toHaveLength(2);
    expect(chainFromTable([proc(5, 99, "orphan")], 5)).toHaveLength(1);
    expect(chainFromTable(table, 42)).toEqual([]);
    const long = Array.from({ length: 100 }, (_, i) => proc(i + 1, i, `p${i}`));
    expect(chainFromTable(long, 100).length).toBeLessThanOrEqual(24);
  });
});

describe("reading the process table", () => {
  it("parses Windows output, one process or many", () => {
    const many = JSON.stringify([
      { ProcessId: 4, ParentProcessId: 3, Name: "node.exe", CommandLine: "node kai.js teams" },
      { ProcessId: 3, ParentProcessId: 0, Name: "System", CommandLine: null },
    ]);
    expect(parseWindowsProcesses(many)).toEqual([
      { pid: 4, ppid: 3, name: "node.exe", cmdline: "node kai.js teams" },
      { pid: 3, ppid: 0, name: "System", cmdline: "" },
    ]);
    expect(
      parseWindowsProcesses(JSON.stringify({ ProcessId: 9, ParentProcessId: 1, Name: "x" }))
    ).toHaveLength(1);
  });

  it("parses macOS ps output, including names with spaces", () => {
    const comm =
      "  101     1 /Applications/Kai Terminal.app/Contents/MacOS/kai\n  202   101 -zsh\n";
    const args = "  101 /Applications/Kai Terminal.app/Contents/MacOS/kai\n  202 -zsh\n";
    const t = parsePsTable(comm, args);
    expect(t).toEqual([
      {
        pid: 101,
        ppid: 1,
        name: "/Applications/Kai Terminal.app/Contents/MacOS/kai",
        cmdline: "/Applications/Kai Terminal.app/Contents/MacOS/kai",
      },
      { pid: 202, ppid: 101, name: "-zsh", cmdline: "-zsh" },
    ]);
    expect(isKaiApp({ name: t[0].name })).toBe(true);
  });

  it("parses /proc/<pid>/stat when the name has spaces and parentheses", () => {
    expect(parseProcStat("1234 (node) S 99 1234 1234 0 -1")).toEqual({ ppid: 99, name: "node" });
    expect(parseProcStat("1234 (my (odd) name) S 7 1 1")).toEqual({
      ppid: 7,
      name: "my (odd) name",
    });
    expect(parseProcStat("garbage")).toBeNull();
  });

  it("reads the chain on Windows and macOS through the OS tools, and gives up quietly when they fail", async () => {
    const winJson = JSON.stringify([
      { ProcessId: 30, ParentProcessId: 20, Name: "node.exe", CommandLine: "node kai.js teams" },
      { ProcessId: 20, ParentProcessId: 10, Name: "codex.exe", CommandLine: "codex" },
      { ProcessId: 10, ParentProcessId: 0, Name: "explorer.exe", CommandLine: "" },
    ]);
    const win = await ancestorChain({ platform: "win32", pid: 30, exec: async () => winJson });
    expect(win?.map((p) => p.name)).toEqual(["node.exe", "codex.exe", "explorer.exe"]);

    const mac = await ancestorChain({
      platform: "darwin",
      pid: 3,
      exec: async (_cmd, args) =>
        args[1] === "pid=,ppid=,comm="
          ? "3 2 node\n2 1 claude\n1 0 launchd\n"
          : "3 node kai.js\n2 claude\n1 launchd\n",
    });
    expect(mac?.map((p) => p.name)).toEqual(["node", "claude", "launchd"]);

    expect(await ancestorChain({ platform: "win32", exec: async () => null })).toBeNull();
    expect(
      await ancestorChain({
        platform: "win32",
        exec: async () => {
          throw new Error("denied");
        },
      })
    ).toBeNull();
    expect(await ancestorChain({ platform: "win32", exec: async () => "not json" })).toBeNull();
  });
});

describe("detectAgentSession", () => {
  const chainWithAgent = async () => [proc(3, 2, "node"), proc(2, 1, "gemini")];
  const plainChain = async () => [proc(3, 2, "node"), proc(2, 1, "pwsh.exe")];

  it("trusts an environment marker without even reading the process list", async () => {
    const processes = vi.fn(plainChain);
    const found = await detectAgentSession({ KAI_AGENT_SESSION: "1" } as NodeJS.ProcessEnv, {
      processes,
    });
    expect(found).toEqual({ by: "environment", agent: "KAI_AGENT_SESSION" });
    expect(processes).not.toHaveBeenCalled();
  });

  it("knows the variables other agents set", async () => {
    for (const name of [
      "CLAUDECODE",
      "GEMINI_CLI",
      "OPENCODE",
      "CURSOR_AGENT",
      "CODEX_SANDBOX_NETWORK_DISABLED",
    ]) {
      const found = await detectAgentSession({ [name]: "1" } as NodeJS.ProcessEnv, {
        processes: plainChain,
      });
      expect(found?.agent, name).toBe(name);
    }
  });

  it("finds an agent from the process tree when no variable says so", async () => {
    expect(
      await detectAgentSession({} as NodeJS.ProcessEnv, { processes: chainWithAgent })
    ).toEqual({
      by: "process",
      agent: "Gemini CLI",
    });
  });

  it("lets a person through, including when the process list cannot be read", async () => {
    expect(await detectAgentSession({} as NodeJS.ProcessEnv, { processes: plainChain })).toBeNull();
    expect(
      await detectAgentSession({} as NodeJS.ProcessEnv, { processes: async () => null })
    ).toBeNull();
    expect(
      await detectAgentSession({} as NodeJS.ProcessEnv, {
        processes: async () => {
          throw new Error("denied");
        },
      })
    ).toBeNull();
  });

  it("refuses with the agent's name and what to do", async () => {
    await expect(
      assertNotAgentSession({} as NodeJS.ProcessEnv, { processes: chainWithAgent })
    ).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("Gemini CLI is running this command"),
      hint: expect.stringContaining("normal terminal tab"),
    });
    await expect(
      assertNotAgentSession({} as NodeJS.ProcessEnv, { processes: plainChain })
    ).resolves.toBeUndefined();
  });
});
