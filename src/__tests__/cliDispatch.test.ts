import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { AGENT_FLAGS, agentTargetFrom, flagValue } from "../cli/args";
import { listSessionCacheFiles, removeFiles, clearSessionCacheFiles } from "../cli/sessionFiles";
import { loadKaiConfig, kaiConfigPath } from "../cli/kaiConfig";
import { runCli } from "../cli/index";

describe("cli argument helpers", () => {
  it("flagValue returns the value after the first matching flag", () => {
    expect(flagValue(["x", "-a", "claude", "-m", "cursor"], AGENT_FLAGS)).toBe("claude");
    expect(flagValue(["--mcp", "cursor"], AGENT_FLAGS)).toBe("cursor");
  });

  it("flagValue ignores a missing value or a value that is itself a flag", () => {
    expect(flagValue(["-a"], AGENT_FLAGS)).toBeUndefined();
    expect(flagValue(["-a", "--dry-run"], AGENT_FLAGS)).toBeUndefined();
    expect(flagValue(["claude"], AGENT_FLAGS)).toBeUndefined();
  });

  it("agentTargetFrom prefers the flag, falls back to the first positional, and lowercases", () => {
    expect(agentTargetFrom(["-a", "Claude", "cursor"])).toBe("claude");
    expect(agentTargetFrom(["--dry-run", "Cursor", "x"])).toBe("cursor");
    expect(agentTargetFrom(["--print"])).toBe("");
    expect(agentTargetFrom([])).toBe("");
  });
});

describe("cli session/cache + config helpers", () => {
  let home: string;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.KAI_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cli-helpers-"));
    process.env.KAI_HOME = home;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.KAI_HOME;
    else process.env.KAI_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("lists nothing when the managed directories do not exist yet", () => {
    const l = listSessionCacheFiles();
    expect(l.sessionFiles).toEqual([]);
    expect(l.cacheFiles).toEqual([]);
  });

  it("removeFiles deletes regular files only and tolerates missing entries", () => {
    const dir = path.join(home, "d");
    fs.mkdirSync(path.join(dir, "keep-dir"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a.json"), "1");
    fs.writeFileSync(path.join(dir, "b.json"), "2");
    removeFiles(dir, ["a.json", "keep-dir", "ghost.json"]);
    expect(fs.readdirSync(dir).sort()).toEqual(["b.json", "keep-dir"]);
  });

  it("clearSessionCacheFiles empties both directories and reports the counts", () => {
    const { sessionsDir, cacheDir } = listSessionCacheFiles();
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "s1"), "x");
    fs.writeFileSync(path.join(cacheDir, "c1"), "x");
    fs.writeFileSync(path.join(cacheDir, "c2"), "x");
    expect(clearSessionCacheFiles()).toEqual({ sessions: 1, cache: 2 });
    expect(fs.readdirSync(sessionsDir)).toEqual([]);
    expect(fs.readdirSync(cacheDir)).toEqual([]);
  });

  it("loadKaiConfig returns defaults, then the stored config, and survives a corrupt file", () => {
    expect(loadKaiConfig().defaultTokenBudget).toBe(4000);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(kaiConfigPath(), JSON.stringify({ defaultTokenBudget: 1234 }));
    expect(loadKaiConfig().defaultTokenBudget).toBe(1234);
    fs.writeFileSync(kaiConfigPath(), "{not json");
    expect(loadKaiConfig().defaultTokenBudget).toBe(4000);
  });
});

describe("cli dispatch", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "treats inherited object keys like '%s' as unknown commands",
    async (name) => {
      expect(await runCli(["node", "kai", name])).toBe(1);
      const messages = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes(`Unknown command: "${name}"`))).toBe(true);
    }
  );

  it("redirects removed commands to their replacements", async () => {
    expect(await runCli(["node", "kai", "status"])).toBe(1);
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain("kai health");
  });

  it("ignores unknown subcommands of session and agent instead of crashing", async () => {
    expect(await runCli(["node", "kai", "session", "bogus"])).toBe(1);
    expect(await runCli(["node", "kai", "agent", "bogus"])).toBe(1);
  });
});
