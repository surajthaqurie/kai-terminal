import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyAgentSetup,
  approveKaiForClaudeProject,
  isAgentWired,
  removeAgentSetup,
} from "../core/agents";

const KAI_BIN = "/usr/local/bin/kai.js";
const homes: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-agent-safety-"));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (homes.length) fs.rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("a config that exists but cannot be read is never overwritten", () => {
  // A directory where the file should be is a read failure (EISDIR) on every OS
  // without needing permission tricks; EACCES/EBUSY take the same code path.
  it("JSON agents report the problem and leave the path alone", () => {
    const home = tempHome();
    const config = path.join(home, ".config", "aider", "mcp.json");
    fs.mkdirSync(config, { recursive: true });

    const result = applyAgentSetup("aider", KAI_BIN, { homeDir: home });

    expect(result.wrote).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.message).toContain("could not be read");
    expect(fs.statSync(config).isDirectory()).toBe(true);
    expect(isAgentWired("aider", { homeDir: home })).toBe(false);
  });

  it("TOML agents (codex) report the problem and leave the path alone", () => {
    const home = tempHome();
    const config = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(config, { recursive: true });

    const result = applyAgentSetup("codex", KAI_BIN, { homeDir: home });

    expect(result.wrote).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.message).toContain("could not be read");
    expect(fs.statSync(config).isDirectory()).toBe(true);
  });

  it("removal and the Claude approval step also refuse instead of rewriting", () => {
    const home = tempHome();
    const aider = path.join(home, ".config", "aider", "mcp.json");
    fs.mkdirSync(aider, { recursive: true });
    const removed = removeAgentSetup("aider", { homeDir: home });
    expect(removed.removed).toBe(false);
    expect(removed.message).toContain("could not be read");

    const codex = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(codex, { recursive: true });
    const removedToml = removeAgentSetup("codex", { homeDir: home });
    expect(removedToml.removed).toBe(false);
    expect(removedToml.message).toContain("could not be read");

    const project = tempHome();
    const settings = path.join(project, ".claude", "settings.local.json");
    fs.mkdirSync(settings, { recursive: true });
    const approval = approveKaiForClaudeProject(project);
    expect(approval.wrote).toBe(false);
    expect(approval.message).toContain("could not be read");
    expect(fs.statSync(settings).isDirectory()).toBe(true);
  });

  it("a failing write is reported, not thrown, and keeps the original", () => {
    const home = tempHome();
    const config = path.join(home, ".config", "aider", "mcp.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, "{}");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });

    const result = applyAgentSetup("aider", KAI_BIN, { homeDir: home });

    expect(result.wrote).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.message).toContain("Failed to write config file");
    expect(fs.readFileSync(config, "utf-8")).toBe("{}");
  });

  it("a genuinely absent config is still created", () => {
    const home = tempHome();
    expect(applyAgentSetup("aider", KAI_BIN, { homeDir: home })).toMatchObject({
      wrote: true,
      created: true,
    });
    expect(applyAgentSetup("codex", KAI_BIN, { homeDir: home })).toMatchObject({
      wrote: true,
      created: true,
    });
  });
});

describe("the .kai.bak backup is write-once", () => {
  it("keeps the user's original through repeated forced refreshes", () => {
    const home = tempHome();
    const config = path.join(home, ".config", "aider", "mcp.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const original = JSON.stringify({ mcpServers: { other: { command: "other-bin" } } });
    fs.writeFileSync(config, original);

    const first = applyAgentSetup("aider", KAI_BIN, { homeDir: home });
    expect(first.backupPath).toBe(`${config}.kai.bak`);
    expect(fs.readFileSync(`${config}.kai.bak`, "utf-8")).toBe(original);

    // The file now holds Kai's own output; a second run must not back THAT up.
    const second = applyAgentSetup("aider", "/other/kai.js", { homeDir: home, force: true });
    expect(second.wrote).toBe(true);
    expect(second.backupPath).toBe(`${config}.kai.bak`);
    expect(fs.readFileSync(`${config}.kai.bak`, "utf-8")).toBe(original);
  });

  it("applies to TOML configs and removal too", () => {
    const home = tempHome();
    const config = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const original = 'model = "gpt"\n';
    fs.writeFileSync(config, original);

    applyAgentSetup("codex", KAI_BIN, { homeDir: home });
    applyAgentSetup("codex", "/other/kai.js", { homeDir: home, force: true });
    removeAgentSetup("codex", { homeDir: home });
    expect(fs.readFileSync(`${config}.kai.bak`, "utf-8")).toBe(original);
  });
});

describe("codex TOML section replacement", () => {
  const SEED = [
    'model = "gpt"',
    "",
    "[mcp_servers.kai-terminal]",
    'command = "node"',
    'args = ["/old/kai.js", "mcp", "."]',
    "",
    "[mcp_servers.kai-terminal.env]",
    'FOO = "bar"',
    "",
    "# Notes about the other server",
    "# (keep these lines)",
    "[mcp_servers.other]",
    'command = "other-bin"',
    "",
  ].join("\n");

  function seed(home: string, text: string): string {
    const config = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, text);
    return config;
  }

  it("drops the whole kai table including its subtable, and keeps the next table's comments", () => {
    const home = tempHome();
    const config = seed(home, SEED);

    const result = applyAgentSetup("codex", "/new/kai.js", { homeDir: home, force: true });
    expect(result.wrote).toBe(true);

    const raw = fs.readFileSync(config, "utf-8");
    expect(raw.match(/\[mcp_servers\.kai-terminal\]/g)).toHaveLength(1);
    expect(raw).not.toContain("kai-terminal.env");
    expect(raw).not.toContain("FOO");
    expect(raw).not.toContain("/old/kai.js");
    expect(raw).toContain("/new/kai.js");
    expect(raw).toContain('model = "gpt"');
    expect(raw).toContain(
      '# Notes about the other server\n# (keep these lines)\n[mcp_servers.other]\ncommand = "other-bin"'
    );
  });

  it("removal leaves the neighbouring tables and their comments intact", () => {
    const home = tempHome();
    const config = seed(home, SEED);

    expect(removeAgentSetup("codex", { homeDir: home }).removed).toBe(true);

    expect(fs.readFileSync(config, "utf-8")).toBe(
      [
        'model = "gpt"',
        "",
        "# Notes about the other server",
        "# (keep these lines)",
        "[mcp_servers.other]",
        'command = "other-bin"',
        "",
      ].join("\n")
    );
  });

  it("matches quoted keys and the legacy name, but not look-alike servers", () => {
    const home = tempHome();
    const config = seed(
      home,
      [
        '[mcp_servers."kai-terminal"]',
        'command = "node"',
        "",
        "[mcp_servers.kai]",
        'command = "legacy"',
        "",
        "[mcp_servers.kai-terminal-extra]",
        'command = "unrelated"',
        "",
      ].join("\n")
    );

    applyAgentSetup("codex", KAI_BIN, { homeDir: home, force: true });

    const raw = fs.readFileSync(config, "utf-8");
    expect(raw).not.toContain("legacy");
    expect(raw).not.toContain('"kai-terminal"');
    expect(raw).toContain("[mcp_servers.kai-terminal-extra]");
    expect(raw).toContain('command = "unrelated"');
    expect(raw.match(/^\[mcp_servers\.kai-terminal\]$/gm)).toHaveLength(1);
  });
});
