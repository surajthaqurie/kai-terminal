import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, afterEach } from "vitest";
import {
  AGENT_REGISTRY,
  applyAgentSetup,
  autoSetupDetectedAgents,
  buildKaiMcpEntry,
  getAgentDefinition,
  isAgentWired,
  resolveAgentConfigPath,
} from "../core/agents";
import { getKaiCliLaunch, setupAgentMcp } from "../services/aiCliService";

const KAI_BIN = "/usr/local/bin/kai.js";

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-agent-setup-"));
  tempHomes.push(dir);
  return dir;
}

const tempHomes: string[] = [];

afterEach(() => {
  while (tempHomes.length) {
    const dir = tempHomes.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent install targets (machine-readable registry)", () => {
  it("defines a safe, unique target for every agent", () => {
    expect(AGENT_REGISTRY.length).toBeGreaterThanOrEqual(9);
    const seen = new Set<string>();
    for (const def of AGENT_REGISTRY) {
      expect(def.targets.length).toBeGreaterThanOrEqual(1);
      for (const t of def.targets) {
        expect(t.relPath).not.toMatch(/^~|\.\.|^[/\\]|[A-Z]:/);
        expect(t.relPath.length).toBeLessThan(256);
        const key = `${t.scope}:${t.relPath}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it("builds style-correct kai entries (opencode local array, vscode stdio)", () => {
    const opencode = getAgentDefinition("opencode")!;
    const entry = buildKaiMcpEntry(opencode, KAI_BIN) as Record<string, unknown>;
    expect(entry.type).toBe("local");
    expect(entry.command).toEqual(["node", KAI_BIN, "mcp", "."]);

    const copilot = getAgentDefinition("copilot")!;
    const vsEntry = buildKaiMcpEntry(copilot, KAI_BIN) as Record<string, unknown>;
    expect(vsEntry.type).toBe("stdio");
    expect(vsEntry.args).toEqual([KAI_BIN, "mcp", "."]);

    const cursor = getAgentDefinition("cursor")!;
    const cursorEntry = buildKaiMcpEntry(cursor, KAI_BIN) as Record<string, unknown>;
    expect(cursorEntry.args).toEqual([KAI_BIN, "mcp", "${workspaceFolder}"]);
  });

  it("declines cline when VS Code storage is absent instead of fabricating dirs", () => {
    const home = makeTempHome();
    const cline = getAgentDefinition("cline")!;
    const resolved = resolveAgentConfigPath(cline, { homeDir: home });
    expect("error" in resolved).toBe(true);
    const res = applyAgentSetup("cline", KAI_BIN, { homeDir: home });
    expect(res.skipped).toBe(true);
    expect(res.wrote).toBe(false);
  });
});

describe("applyAgentSetup (automatic install)", () => {
  it("writes aider config automatically and is idempotent", () => {
    const home = makeTempHome();
    expect(isAgentWired("aider", { homeDir: home })).toBe(false);

    const first = applyAgentSetup("aider", KAI_BIN, { homeDir: home });
    expect(first.wrote).toBe(true);
    expect(first.created).toBe(true);
    expect(first.backupPath).toBeNull();
    const file = path.join(home, ".config/aider/mcp.json");
    expect(first.path).toBe(file);
    const doc = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(doc.mcpServers.kai.args).toEqual([KAI_BIN, "mcp", "."]);
    expect(isAgentWired("aider", { homeDir: home })).toBe(true);

    const second = applyAgentSetup("aider", KAI_BIN, { homeDir: home });
    expect(second.wrote).toBe(false);
    expect(second.alreadyConfigured).toBe(true);

    const forced = applyAgentSetup("aider", "/other/kai.js", {
      homeDir: home,
      force: true,
    });
    expect(forced.wrote).toBe(true);
    expect(forced.backupPath).toBe(`${file}.kai.bak`);
    expect(fs.existsSync(`${file}.kai.bak`)).toBe(true);
    const refreshed = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(refreshed.mcpServers.kai.args[0]).toBe("/other/kai.js");
  });

  it("merges without touching unrelated servers", () => {
    const home = makeTempHome();
    const dir = path.join(home, ".config/aider");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other-bin", args: [] } } })
    );
    const res = applyAgentSetup("aider", KAI_BIN, { homeDir: home });
    expect(res.wrote).toBe(true);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf-8"));
    expect(doc.mcpServers.other.command).toBe("other-bin");
    expect(doc.mcpServers.kai.command).toBe("node");
  });

  it("writes opencode config under the mcp key (not mcpServers)", () => {
    const home = makeTempHome();
    const res = applyAgentSetup("opencode", KAI_BIN, { homeDir: home });
    expect(res.wrote).toBe(true);
    const doc = JSON.parse(fs.readFileSync(res.path, "utf-8"));
    expect(doc.mcp.kai.type).toBe("local");
    expect(doc.mcp.kai.command).toEqual(["node", KAI_BIN, "mcp", "."]);
    expect(doc.mcpServers).toBeUndefined();
    expect(isAgentWired("opencode", { homeDir: home })).toBe(true);
  });

  it("appends codex TOML idempotently", () => {
    const home = makeTempHome();
    const first = applyAgentSetup("codex", KAI_BIN, { homeDir: home });
    expect(first.wrote).toBe(true);
    const raw = fs.readFileSync(first.path, "utf-8");
    expect(raw).toContain("[mcp_servers.kai]");
    expect(isAgentWired("codex", { homeDir: home })).toBe(true);
    const second = applyAgentSetup("codex", KAI_BIN, { homeDir: home });
    expect(second.alreadyConfigured).toBe(true);
    expect(second.wrote).toBe(false);
  });

  it("supports project scope for copilot", () => {
    const home = makeTempHome();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "kai-agent-proj-"));
    tempHomes.push(project);
    const res = applyAgentSetup("copilot", KAI_BIN, {
      homeDir: home,
      projectDir: project,
      scope: "project",
    });
    expect(res.wrote).toBe(true);
    expect(res.scope).toBe("project");
    const doc = JSON.parse(fs.readFileSync(path.join(project, ".vscode/mcp.json"), "utf-8"));
    expect(doc.servers.kai.type).toBe("stdio");
  });

  it("dry-run previews without writing", () => {
    const home = makeTempHome();
    const res = applyAgentSetup("gemini", KAI_BIN, { homeDir: home, dryRun: true });
    expect(res.wrote).toBe(false);
    expect(res.created).toBe(true);
    expect(fs.existsSync(path.join(home, ".muse/settings.json"))).toBe(false);
  });

  it("refuses invalid JSON instead of destroying user config", () => {
    const home = makeTempHome();
    const dir = path.join(home, ".muse");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), "{broken");
    const res = applyAgentSetup("gemini", KAI_BIN, { homeDir: home });
    expect(res.skipped).toBe(true);
    expect(res.wrote).toBe(false);
    expect(fs.readFileSync(path.join(dir, "settings.json"), "utf-8")).toBe("{broken");
  });

  it("rejects unknown agents and invalid kai paths", () => {
    const home = makeTempHome();
    const unknown = applyAgentSetup("nope", KAI_BIN, { homeDir: home });
    expect(unknown.skipped).toBe(true);
    const badBin = applyAgentSetup("aider", "", { homeDir: home });
    expect(badBin.skipped).toBe(true);
    expect(fs.existsSync(path.join(home, ".config"))).toBe(false);
  });
});

describe("desktop auto-wire service (outside Tauri)", () => {
  it("rejects IPC wiring when Tauri is unavailable", async () => {
    await expect(getKaiCliLaunch()).rejects.toThrow("desktop app");
    await expect(setupAgentMcp("aider", ["kai"])).rejects.toThrow("desktop app");
  });
});

describe("autoSetupDetectedAgents (system-driven wiring)", () => {
  it("wires only agents installed on PATH, skips the rest", () => {
    const home = makeTempHome();
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-agent-bin-"));
    tempHomes.push(binDir);
    // Fake installed binaries (never executed, only PATH-probed).
    const exts = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""];
    for (const bin of ["opencode", "aider"]) {
      for (const ext of exts) {
        const p = path.join(binDir, `${bin}${ext}`);
        fs.writeFileSync(p, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      }
    }
    const oldPath = process.env.PATH || process.env.Path || "";
    const hadUpperPath = process.env.Path !== undefined;
    const oldUpperPath = process.env.Path;
    // Isolate PATH to the fake bin dir so the test is hermetic on every OS:
    // runners (or dev machines) may have real agents like `claude`/`gemini`
    // installed, which would otherwise be detected and break the
    // skipped/wrote assertions.
    process.env.PATH = binDir;
    if (hadUpperPath) {
      process.env.Path = binDir;
    }
    try {
      const results = autoSetupDetectedAgents(KAI_BIN, { homeDir: home });
      expect(results).toHaveLength(AGENT_REGISTRY.length);
      const byId = Object.fromEntries(results.map((r) => [r.id, r]));
      expect(byId.opencode.wrote).toBe(true);
      expect(byId.aider.wrote).toBe(true);
      expect(byId.claude.skipped).toBe(true);
      expect(byId.gemini.skipped).toBe(true);
      expect(isAgentWired("opencode", { homeDir: home })).toBe(true);
      expect(isAgentWired("aider", { homeDir: home })).toBe(true);
    } finally {
      process.env.PATH = oldPath;
      if (hadUpperPath) {
        process.env.Path = oldUpperPath;
      }
    }
  });
});
