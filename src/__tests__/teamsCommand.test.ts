import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const confirmAnswer = { value: true };
vi.mock("../cli/prompt", () => ({
  ask: vi.fn(async () => ""),
  askHidden: vi.fn(async () => ""),
  confirm: vi.fn(async () => confirmAnswer.value),
  isInteractive: () => false,
  readAllStdin: vi.fn(async () => ""),
}));

import { runIntegration } from "../cli/commands/integration";
import { runTeams, runTeamsSetup, type TeamsDeps } from "../cli/commands/teams";
import { requiresKaiTerminal } from "../cli/index";
import { MCP_TOOLS } from "../core/mcp";
import { serializeTokenSet } from "../core/integrations/providers/azure-devops/oauth";
import type { SecretStore } from "../core/integrations/secretStore";
import { IntegrationError } from "../core/integrations/types";
import { getTeamsAccount, saveTeamsAccount, teamsSecretKey } from "../core/teams/config";
import type { GraphClient } from "../core/teams/graph";
import { agentEnv, agentSessionMarker } from "../core/teams/guard";
import { CHANNEL_READ_SCOPE } from "../core/teams/oauth";
import type { TeamsSession } from "../core/teams/session";

function memorySecrets(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    has: async (k) => map.has(k),
    set: async (k, v) => (map.set(k, v), "os"),
    delete: async (k) => void map.delete(k),
  };
}

const account = {
  id: "oid-1",
  name: "Alex",
  email: "alex@contoso.com",
  scopes: ["User.Read"],
  signedInAt: "now",
};

const ACCESS = "ACCESS-TOKEN-abcdef123456";
const REFRESH = "REFRESH-TOKEN-uvwxyz987654";

describe("kai teams", () => {
  let home: string;
  const savedHome = process.env.KAI_HOME;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-teams-cmd-"));
    process.env.KAI_HOME = home;
    confirmAnswer.value = true;
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.KAI_HOME;
    else process.env.KAI_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const plain = {} as NodeJS.ProcessEnv;

  function deps(over: Partial<TeamsDeps> & { graph?: Record<string, unknown> } = {}) {
    const chat = vi.fn(async (_opts: unknown) => 0);
    const graph = {
      me: vi.fn(async () => ({ id: "oid-1", name: "Alex", email: "alex@contoso.com" })),
      joinedTeams: vi.fn(async () => [
        { id: "t1", name: "Platform Engineering" },
        { id: "t2", name: "Platform Support" },
      ]),
      chats: vi.fn(async () => [{ id: "k1", kind: "oneOnOne", title: "Priya Nair" }]),
      ...over.graph,
    };
    const session = { canReadChannels: false };
    const connect = vi.fn(() => ({
      graph: graph as unknown as GraphClient,
      session: session as unknown as TeamsSession,
    }));
    const d: TeamsDeps = {
      env: plain,
      // A person's terminal: the real process list would be this test run's own ancestors.
      processes: async () => [],
      interactive: () => true,
      chat,
      connect,
      secrets: memorySecrets(),
      ...over,
    };
    return { d, chat, graph, connect };
  }

  describe("the chat", () => {
    it("opens in this tab", async () => {
      saveTeamsAccount(account);
      const { d, chat } = deps();
      expect(await runTeams(["teams"], d)).toBe(0);
      expect(chat).toHaveBeenCalledTimes(1);
      expect(chat.mock.calls[0][0]).toMatchObject({ account, canReadChannels: false });
    });

    it("has no options and no scripted commands: nothing can read or post without a person", async () => {
      saveTeamsAccount(account);
      for (const extra of [
        ["--new-tab"],
        ["--here"],
        ["list"],
        ["send", "a/b", "hi"],
        ["remove"],
      ]) {
        const { d, chat, connect } = deps();
        expect(await runTeams(["teams", ...extra], d)).toBe(1);
        expect(err.join("\n")).toContain("takes no options");
        expect(chat).not.toHaveBeenCalled();
        expect(connect).not.toHaveBeenCalled();
        err.length = 0;
      }
    });

    it("needs a person at an interactive terminal and never touches the account otherwise", async () => {
      saveTeamsAccount(account);
      const { d, chat, connect } = deps({ interactive: () => false });
      expect(await runTeams(["teams"], d)).toBe(1);
      expect(err.join("\n")).toContain("interactive terminal");
      expect(chat).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    });

    it("points to setup when signed out and the person says no", async () => {
      confirmAnswer.value = false;
      const { d, chat } = deps();
      expect(await runTeams(["teams"], d)).toBe(1);
      expect(err.join("\n")).toContain("not signed in");
      expect(err.join("\n")).toContain("kai integration teams");
      expect(chat).not.toHaveBeenCalled();
    });

    it("offers to sign in, then opens the chat", async () => {
      const signIn = vi.fn(async (_opts: unknown, _deps: unknown) => ({
        secret: serializeTokenSet({
          accessToken: ACCESS,
          refreshToken: REFRESH,
          expiresAt: Date.now() + 3_600_000,
        }),
        user: { id: "oid-1", name: "Alex", email: "alex@contoso.com" },
        scopes: ["User.Read"],
      }));
      const { d, chat } = deps({ signIn });
      expect(await runTeams(["teams"], d)).toBe(0);
      expect(signIn).toHaveBeenCalledTimes(1);
      expect(chat).toHaveBeenCalledTimes(1);
      expect(getTeamsAccount()?.id).toBe("oid-1");
    });

    it("is allowed from any shell, like the other integration commands", () => {
      expect(requiresKaiTerminal("teams")).toBe(false);
    });

    it("prints help", async () => {
      expect(await runTeams(["teams", "--help"], deps().d)).toBe(0);
      expect(out.join("\n")).toContain("kai integration teams");
    });
  });

  describe("kai integration teams", () => {
    const signedIn = {
      secret: serializeTokenSet({
        accessToken: ACCESS,
        refreshToken: REFRESH,
        expiresAt: Date.now() + 3_600_000,
      }),
      user: { id: "oid-1", name: "Alex", email: "alex@contoso.com" },
      scopes: ["User.Read"],
    };
    const signInMock = () => vi.fn(async (_opts: unknown, _deps: unknown) => signedIn);

    it("signs in, saves the account and token, and checks access", async () => {
      const secrets = memorySecrets();
      const signIn = signInMock();
      const { d } = deps({ secrets, signIn });
      expect(await runTeamsSetup([], d)).toBe(0);
      expect(signIn).toHaveBeenCalledTimes(1);
      expect(signIn.mock.calls[0][0]).toMatchObject({ channelHistory: false });
      expect(getTeamsAccount()).toMatchObject({ id: "oid-1", name: "Alex" });
      expect(secrets.map.has(teamsSecretKey("oid-1"))).toBe(true);
      const text = out.join("\n");
      expect(text).toContain("Signed in as Alex");
      expect(text).toContain("2 teams");
      expect(text).toContain("kai integration teams --channels");
    });

    it("does not sign in again when the saved sign-in works", async () => {
      saveTeamsAccount(account);
      const signIn = signInMock();
      expect(await runTeamsSetup([], deps({ signIn }).d)).toBe(0);
      expect(signIn).not.toHaveBeenCalled();
    });

    it("signs in again when channel reading is requested and was never granted", async () => {
      saveTeamsAccount(account);
      const signIn = vi.fn(async (_opts: unknown, _deps: unknown) => ({
        ...signedIn,
        scopes: ["User.Read", CHANNEL_READ_SCOPE],
      }));
      expect(await runTeamsSetup(["--channels"], deps({ signIn }).d)).toBe(0);
      expect(signIn.mock.calls[0][0]).toMatchObject({ channelHistory: true });
      expect(getTeamsAccount()?.scopes).toContain(CHANNEL_READ_SCOPE);
    });

    it("signs in again when the saved sign-in has expired", async () => {
      saveTeamsAccount(account);
      const signIn = signInMock();
      const { d } = deps({
        signIn,
        graph: { me: vi.fn(async () => Promise.reject(new IntegrationError("auth", "expired"))) },
      });
      expect(await runTeamsSetup([], d)).toBe(0);
      expect(signIn).toHaveBeenCalledTimes(1);
      expect(out.join("\n")).toContain("no longer works");
    });

    it("rejects unknown options, including the removed new-tab settings", async () => {
      for (const bad of [["--bogus"], ["--open-in", "tab"], ["nonsense"]]) {
        expect(await runTeamsSetup(bad, deps().d)).toBe(1);
      }
      expect(err.join("\n")).toContain("Unknown option");
    });

    it("signs out, forgetting the token and the account", async () => {
      saveTeamsAccount(account);
      const secrets = memorySecrets();
      secrets.map.set(teamsSecretKey("oid-1"), "token");
      expect(await runTeamsSetup(["remove"], deps({ secrets }).d)).toBe(0);
      expect(getTeamsAccount()).toBeNull();
      expect(secrets.map.size).toBe(0);
    });

    it("signing out needs a person and a yes", async () => {
      saveTeamsAccount(account);
      const secrets = memorySecrets();
      secrets.map.set(teamsSecretKey("oid-1"), "token");
      expect(await runTeamsSetup(["remove"], deps({ secrets, interactive: () => false }).d)).toBe(
        1
      );
      confirmAnswer.value = false;
      expect(await runTeamsSetup(["remove"], deps({ secrets }).d)).toBe(1);
      expect(getTeamsAccount()).not.toBeNull();
      expect(secrets.map.size).toBe(1);
    });

    it("shows up in `kai integration list` and is reachable from `kai integration teams`", async () => {
      saveTeamsAccount(account);
      expect(await runIntegration(["integration", "list"])).toBe(0);
      expect(out.join("\n")).toContain("signed in as Alex");
      out.length = 0;
      expect(await runIntegration(["integration", "teams", "--help"])).toBe(0);
      expect(out.join("\n")).toContain("remove");
    });
  });

  describe("your Teams sign-in stays yours", () => {
    it("refuses every Teams command inside an AI agent's session", async () => {
      saveTeamsAccount(account);
      for (const env of [{ KAI_AGENT_SESSION: "1" }, { CLAUDECODE: "1" }] as NodeJS.ProcessEnv[]) {
        const signIn = vi.fn(async (_o: unknown, _d: unknown) => ({
          secret: "x",
          user: { id: "u", name: "n" },
          scopes: [],
        }));
        const t = deps({ env, signIn });
        expect(await runTeams(["teams"], t.d)).toBe(1);
        expect(await runTeamsSetup([], t.d)).toBe(1);
        expect(await runTeamsSetup(["remove"], t.d)).toBe(1);
        expect(await runTeamsSetup(["--channels"], t.d)).toBe(1);
        expect(t.chat).not.toHaveBeenCalled();
        expect(t.connect).not.toHaveBeenCalled();
        expect(signIn).not.toHaveBeenCalled();
        expect(err.join("\n")).toContain("not available inside an AI agent's session");
        err.length = 0;
      }
      expect(getTeamsAccount()).not.toBeNull();
    });

    it("refuses every Teams command when a known agent is a parent process, with no variable set", async () => {
      saveTeamsAccount(account);
      const chain = async () => [
        { pid: 3, ppid: 2, name: "node", cmdline: "node kai.js teams" },
        { pid: 2, ppid: 1, name: "codex", cmdline: "codex" },
      ];
      const t = deps({ processes: chain });
      expect(await runTeams(["teams"], t.d)).toBe(1);
      expect(await runTeamsSetup([], t.d)).toBe(1);
      expect(await runTeamsSetup(["remove"], t.d)).toBe(1);
      expect(err.join("\n")).toContain("Codex is running this command");
      expect(t.chat).not.toHaveBeenCalled();
      expect(t.connect).not.toHaveBeenCalled();
      expect(getTeamsAccount()).not.toBeNull();
    });

    it("recognises the markers, and ignores empty or zero values", () => {
      expect(agentSessionMarker({ KAI_AGENT_SESSION: "1" } as NodeJS.ProcessEnv)).toBe(
        "KAI_AGENT_SESSION"
      );
      expect(agentSessionMarker({ CLAUDECODE: "1" } as NodeJS.ProcessEnv)).toBe("CLAUDECODE");
      expect(
        agentSessionMarker({ CLAUDECODE: "0", KAI_AGENT_SESSION: "" } as NodeJS.ProcessEnv)
      ).toBeNull();
      expect(agentSessionMarker({} as NodeJS.ProcessEnv)).toBeNull();
      expect(agentEnv({ A: "1" } as NodeJS.ProcessEnv)).toEqual({ A: "1", KAI_AGENT_SESSION: "1" });
    });

    it("marks every agent that `kai <agent>` starts", () => {
      const src = fs.readFileSync(
        path.join(process.cwd(), "src", "cli", "agentWorkflow.ts"),
        "utf8"
      );
      expect(src).toMatch(/runExternalAgentCommand\([\s\S]{0,400}env:\s*agentEnv\(\)/);
    });

    it("never prints or exports a token while signing in", async () => {
      const signIn = vi.fn(async (_o: unknown, _d: unknown) => ({
        secret: serializeTokenSet({
          accessToken: ACCESS,
          refreshToken: REFRESH,
          expiresAt: Date.now() + 3_600_000,
        }),
        user: { id: "oid-1", name: "Alex" },
        scopes: [],
      }));
      expect(await runTeamsSetup([], deps({ signIn }).d)).toBe(0);
      const shown = [...out, ...err].join("\n");
      expect(shown).not.toContain(ACCESS);
      expect(shown).not.toContain(REFRESH);
      const env = JSON.stringify(process.env);
      expect(env).not.toContain(ACCESS);
      expect(env).not.toContain(REFRESH);
      const config = fs.readFileSync(path.join(home, "config.json"), "utf8");
      expect(config).not.toContain(ACCESS);
      expect(config).not.toContain(REFRESH);
    });

    it("is not reachable through the MCP server agents talk to", () => {
      expect(MCP_TOOLS.map((t) => t.name).join(" ")).not.toMatch(/teams|chat/i);
      const root = path.join(process.cwd(), "src", "core");
      for (const file of [
        "mcp.ts",
        "mcpTools.ts",
        path.join("integrations", "tools.ts"),
        path.join("integrations", "providers.ts"),
        path.join("integrations", "providerCatalog.ts"),
      ]) {
        const text = fs.readFileSync(path.join(root, file), "utf8");
        expect(text, `${file} must not use the Teams code`).not.toMatch(/teams\//i);
      }
    });
  });
});
