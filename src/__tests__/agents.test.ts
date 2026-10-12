import { describe, it, expect } from "vitest";
import {
  AGENT_REGISTRY,
  buildAgentSetup,
  detectInstalledAgentsSync,
  getAgentDefinition,
  listAgentIds,
} from "../core/agents";

describe("agent registry (single source of truth)", () => {
  it("covers every previously supported agent plus opencode and aider", () => {
    const ids = listAgentIds();
    for (const id of [
      "claude",
      "cursor",
      "codex",
      "gemini",
      "copilot",
      "windsurf",
      "cline",
      "opencode",
      "aider",
    ]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("buildAgentSetup supports opencode and aider with valid JSON", () => {
    const opencode = buildAgentSetup("opencode", "/usr/local/bin/kai.js")!;
    expect(opencode).toBeTruthy();
    expect(opencode).toContain('"mcp"');
    expect(opencode).toContain("opencode.json");

    const aider = buildAgentSetup("aider", "/usr/local/bin/kai.js")!;
    expect(aider).toBeTruthy();
    expect(aider).toContain("mcpServers");
    expect(aider).toContain("mcp.json");
  });

  it("resolves aliases case-insensitively (vscode, codeium, open-code)", () => {
    expect(getAgentDefinition("vscode")?.id).toBe("copilot");
    expect(getAgentDefinition("Codeium")?.id).toBe("windsurf");
    expect(getAgentDefinition("Open-Code")?.id).toBe("opencode");
    expect(buildAgentSetup("VSCODE", "/bin/kai")).toBeTruthy();
  });

  it("returns null for unknown agents", () => {
    expect(buildAgentSetup("unknown-agent", "/bin/kai")).toBeNull();
  });

  it("dynamically detects system state without executing binaries", () => {
    const detected = detectInstalledAgentsSync();
    expect(detected).toHaveLength(AGENT_REGISTRY.length);
    for (const d of detected) {
      expect(typeof d.binaryFound).toBe("boolean");
      expect(typeof d.configured).toBe("boolean");
      if (d.binaryFound) expect(d.binaryPath).toBeTruthy();
      else expect(d.binaryPath).toBeNull();
    }
  });
});
