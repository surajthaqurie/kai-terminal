import { describe, expect, it, vi } from "vitest";

/**
 * SEC-08: the command an agent's config is told to run is resolved by the backend from the
 * installed CLI. The page must never supply it: a compromised page could otherwise persist a
 * command of its own into `~/.claude.json` and similar files.
 */
const invoke = vi.fn(async (..._args: unknown[]) => ({ message: "ok" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => true }));

describe("desktop agent auto-wire request", () => {
  it("sends the agent, project and options, and no launcher", async () => {
    const { setupAgentMcp } = await import("../services/aiCliService");
    await setupAgentMcp("claude", "/work/app", true, "/work/app");
    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, args] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe("setup_agent_mcp_cmd");
    expect(args).toEqual({
      id: "claude",
      projectArg: "/work/app",
      force: true,
      projectDir: "/work/app",
    });
    expect(args).not.toHaveProperty("launcher");
  });
});
