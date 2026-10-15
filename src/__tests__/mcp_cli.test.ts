import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runCli } from "../cli/index";

let kaiHome: string;
let savedKaiHome: string | undefined;
let savedHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  savedKaiHome = process.env.KAI_HOME;
  savedHome = process.env.HOME;
  kaiHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-home-"));
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-user-home-"));
  process.env.KAI_HOME = kaiHome;
  process.env.HOME = tempHome;
  // os.homedir() ignores $HOME on Windows (uses USERPROFILE), so mock it
  // to keep CLI home-relative writes hermetic on every OS.
  vi.spyOn(os, "homedir").mockReturnValue(tempHome);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedKaiHome === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = savedKaiHome;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(kaiHome, { recursive: true, force: true });
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe("kai mcp CLI commands", () => {
  it("prints help with 'kai mcp --help'", async () => {
    const code = await runCli(["node", "kai", "mcp", "--help"]);
    expect(code).toBe(0);
  });

  it("lists MCP status with 'kai mcp list' and 'kai list mcp'", async () => {
    expect(await runCli(["node", "kai", "mcp", "list"])).toBe(0);
    expect(await runCli(["node", "kai", "list", "mcp"])).toBe(0);
    expect(await runCli(["node", "kai", "list", "-m"])).toBe(0);
    expect(await runCli(["node", "kai", "list", "--mcp"])).toBe(0);
  });

  it("configures claude with 'kai mcp claude'", async () => {
    // Dry-run should succeed and not modify files
    const dryCode = await runCli(["node", "kai", "mcp", "claude", "--dry-run"]);
    expect(dryCode).toBe(0);
    const claudeJson = path.join(tempHome, ".claude.json");
    expect(fs.existsSync(claudeJson)).toBe(false);

    // Real run writes the MCP config
    const code = await runCli(["node", "kai", "mcp", "claude"]);
    expect(code).toBe(0);
    expect(fs.existsSync(claudeJson)).toBe(true);
    const content = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
    expect(content.mcpServers.kai).toBeDefined();
    expect(content.mcpServers.kai.command).toBe("node");
  });

  it("removes claude wiring with 'kai remove -m claude' and 'kai mcp remove claude'", async () => {
    const claudeJson = path.join(tempHome, ".claude.json");
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: {
          kai: { command: "node", args: ["kai.js", "mcp", "."] },
          other: { command: "other" },
        },
      })
    );

    // Dry-run removal
    expect(await runCli(["node", "kai", "remove", "-m", "claude", "--dry-run"])).toBe(0);
    const beforeRaw = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
    expect(beforeRaw.mcpServers.kai).toBeDefined();

    // Real remove with -m
    expect(await runCli(["node", "kai", "remove", "-m", "claude"])).toBe(0);
    const afterRaw = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
    expect(afterRaw.mcpServers.kai).toBeUndefined();
    expect(afterRaw.mcpServers.other).toBeDefined();

    // Re-add and remove with kai mcp remove
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: {
          kai: { command: "node", args: ["kai.js", "mcp", "."] },
        },
      })
    );
    expect(await runCli(["node", "kai", "mcp", "remove", "claude"])).toBe(0);
    const finalRaw = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
    expect(finalRaw.mcpServers.kai).toBeUndefined();
  });

  it("handles typos gracefully", async () => {
    const code = await runCli(["node", "kai", "mcp", "calude"]);
    expect(code).toBe(1);
  });

  it("runs kai health and outputs readiness message", async () => {
    const consoleSpy = vi.spyOn(console, "log");
    const code = await runCli(["node", "kai", "health"]);
    expect(code).toBe(0);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("is ready"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Fast and private · Free"));
  });

  it("redirects removed kai status to kai health", async () => {
    const errorSpy = vi.spyOn(console, "error");
    const code = await runCli(["node", "kai", "status"]);
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("replaced by 'kai health'"));
  });

  it("handles 'kai mcp' with no args by printing help", async () => {
    const code = await runCli(["node", "kai", "mcp"]);
    expect(code).toBe(0);
  });

  it("informs user that MCP runs automatically when 'kai mcp .' is run in TTY", async () => {
    const origIsTTY = process.stdin.isTTY;
    try {
      process.stdin.isTTY = true;
      const logSpy = vi.spyOn(console, "log");
      const code = await runCli(["node", "kai", "mcp", "."]);
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("runs automatically over stdio"));
    } finally {
      process.stdin.isTTY = origIsTTY;
    }
  });

  it("supports both -m and --mcp for kai list and kai remove", async () => {
    expect(await runCli(["node", "kai", "list", "-m"])).toBe(0);
    expect(await runCli(["node", "kai", "list", "--mcp"])).toBe(0);
    expect(await runCli(["node", "kai", "list", "-a"])).toBe(0);
    expect(await runCli(["node", "kai", "list", "--agent"])).toBe(0);

    const claudeJson = path.join(tempHome, ".claude.json");
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: {
          kai: { command: "node", args: ["kai.js", "mcp", "."] },
        },
      })
    );
    expect(await runCli(["node", "kai", "remove", "--mcp", "claude"])).toBe(0);
    const doc = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
    expect(doc.mcpServers.kai).toBeUndefined();
  });
});
