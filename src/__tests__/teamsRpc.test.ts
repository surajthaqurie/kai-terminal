import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleRpc } from "../core/integrations/service";
import type { SecretStore } from "../core/integrations/secretStore";
import { IntegrationError } from "../core/integrations/types";
import { getTeamsAccount, saveTeamsAccount, teamsSecretKey } from "../core/teams/config";
import type { GraphClient } from "../core/teams/graph";
import { CHANNEL_READ_SCOPE } from "../core/teams/oauth";
import { handleTeamsRpc, teamsStatus, type TeamsRpcDeps } from "../core/teams/rpc";
import type { TeamsSession } from "../core/teams/session";

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const ACCESS = "ACCESS-TOKEN-abcdef123456";

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
  signedInAt: "2026-01-01T00:00:00.000Z",
};

describe("Microsoft Teams RPC (the Integrations tab)", () => {
  let home: string;
  const savedHome = process.env.KAI_HOME;
  const configured = { KAI_TEAMS_CLIENT_ID: CLIENT_ID } as NodeJS.ProcessEnv;
  const unconfigured = {} as NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-teams-rpc-"));
    process.env.KAI_HOME = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.KAI_HOME;
    else process.env.KAI_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function deps(over: Partial<TeamsRpcDeps> = {}): TeamsRpcDeps & { secrets: SecretStore } {
    return {
      env: configured,
      secrets: memorySecrets(),
      agentGuard: async () => {},
      ...over,
    } as TeamsRpcDeps & { secrets: SecretStore };
  }

  describe("status", () => {
    it("reports signed out when nobody is signed in", async () => {
      const res = await handleTeamsRpc({ op: "teams_status" }, deps());
      expect(res).toEqual({
        ok: true,
        teams: { configured: true, account: null, channelHistory: false },
      });
    });

    it("says the build is not set up when there is no Microsoft app", () => {
      expect(teamsStatus(unconfigured).configured).toBe(false);
      expect(teamsStatus(configured).configured).toBe(true);
    });

    it("shows who is signed in and whether channels were granted, never a token", async () => {
      saveTeamsAccount({ ...account, scopes: ["User.Read", CHANNEL_READ_SCOPE] });
      const res = await handleTeamsRpc({ op: "teams_status" }, deps());
      expect(res).toMatchObject({
        ok: true,
        teams: { account: { id: "oid-1", name: "Alex" }, channelHistory: true },
      });
      expect(JSON.stringify(res)).not.toMatch(/token|scopes/i);
    });
  });

  describe("login", () => {
    const signedIn = {
      secret: JSON.stringify({ accessToken: ACCESS, refreshToken: "r", expiresAt: 1 }),
      user: { id: "oid-1", name: "Alex", email: "alex@contoso.com" },
      scopes: ["User.Read"],
    };

    it("signs in through the browser and keeps the token in the secret store only", async () => {
      const signIn = vi.fn(async () => signedIn);
      const d = deps({ signIn });
      const res = await handleTeamsRpc({ op: "teams_login" }, d);
      // Channel messages are asked for by default: no flag, nothing to switch on.
      expect(signIn).toHaveBeenCalledWith({}, { env: configured });
      expect(res).toMatchObject({ ok: true, teams: { account: { name: "Alex" } } });
      expect(getTeamsAccount()?.id).toBe("oid-1");
      expect((d.secrets as ReturnType<typeof memorySecrets>).map.has(teamsSecretKey("oid-1"))).toBe(
        true
      );
      expect(JSON.stringify(res)).not.toContain(ACCESS);
      // Nothing secret reaches the config file either.
      const config = fs.readFileSync(path.join(home, "config.json"), "utf8");
      expect(config).not.toContain(ACCESS);
    });

    it("reports channel messages as on when the sign-in granted them", async () => {
      const signIn = vi.fn(async () => ({
        ...signedIn,
        scopes: ["User.Read", "ChannelMessage.Read.All"],
      }));
      const res = await handleTeamsRpc({ op: "teams_login" }, deps({ signIn }));
      expect(res).toMatchObject({ ok: true, teams: { channelHistory: true } });
    });

    it("stops before opening a browser when the build has no Microsoft app", async () => {
      // No `signIn` seam: this is the real path, which must fail on the missing app
      // before it starts a listener or opens the browser.
      await expect(
        handleTeamsRpc({ op: "teams_login" }, deps({ env: unconfigured }))
      ).rejects.toMatchObject({ code: "config" });
      expect(getTeamsAccount()).toBeNull();
    });

    it("leaves nothing behind when the person cancels", async () => {
      const signIn = vi.fn(async () => {
        throw new IntegrationError("auth", "Sign-in was cancelled.", "Connect again.");
      });
      await expect(handleTeamsRpc({ op: "teams_login" }, deps({ signIn }))).rejects.toMatchObject({
        code: "auth",
      });
      expect(getTeamsAccount()).toBeNull();
    });
  });

  describe("verify", () => {
    function graphDeps(over: Record<string, unknown> = {}, canReadChannels = false) {
      const graph = {
        me: vi.fn(async () => ({ id: "oid-1", name: "Alex", email: "alex@contoso.com" })),
        joinedTeams: vi.fn(async () => [{ id: "t1", name: "Platform" }]),
        chats: vi.fn(async () => [{ id: "c1" }, { id: "c2" }]),
        ...over,
      };
      return deps({
        connect: () => ({
          graph: graph as unknown as GraphClient,
          session: { canReadChannels } as unknown as TeamsSession,
        }),
      });
    }

    it("needs a signed-in account", async () => {
      await expect(handleTeamsRpc({ op: "teams_verify" }, graphDeps())).rejects.toMatchObject({
        code: "no_account",
      });
    });

    it("counts teams and chats", async () => {
      saveTeamsAccount(account);
      const res = await handleTeamsRpc({ op: "teams_verify" }, graphDeps());
      expect(res).toEqual({
        ok: true,
        access: {
          user: { name: "Alex", email: "alex@contoso.com" },
          teams: 1,
          chats: 2,
          channelHistory: false,
        },
      });
    });

    it("still reports teams when chats cannot be read", async () => {
      saveTeamsAccount(account);
      const chats = vi.fn(async () => {
        throw new IntegrationError("forbidden", "Chats are not allowed.");
      });
      const res = await handleTeamsRpc({ op: "teams_verify" }, graphDeps({ chats }));
      expect(res).toMatchObject({
        ok: true,
        access: { teams: 1, chats: null, chatsError: "Chats are not allowed." },
      });
    });

    it("surfaces an expired sign-in as an error", async () => {
      saveTeamsAccount(account);
      const me = vi.fn(async () => {
        throw new IntegrationError("auth", "Your Microsoft Teams sign-in has expired.");
      });
      await expect(handleTeamsRpc({ op: "teams_verify" }, graphDeps({ me }))).rejects.toMatchObject(
        { code: "auth" }
      );
    });
  });

  describe("logout", () => {
    it("deletes the token and forgets the account", async () => {
      const d = deps();
      saveTeamsAccount(account);
      await d.secrets.set(teamsSecretKey("oid-1"), "secret");
      const res = await handleTeamsRpc({ op: "teams_logout" }, d);
      expect(res).toMatchObject({ ok: true, teams: { account: null } });
      expect(getTeamsAccount()).toBeNull();
      expect(await d.secrets.has(teamsSecretKey("oid-1"))).toBe(false);
    });

    it("is harmless when nobody is signed in", async () => {
      await expect(handleTeamsRpc({ op: "teams_logout" }, deps())).resolves.toMatchObject({
        ok: true,
      });
    });
  });

  describe("an AI agent's session", () => {
    const refused = async () => {
      throw new IntegrationError("forbidden", "Microsoft Teams is not available in an agent.");
    };

    it.each(["teams_status", "teams_login", "teams_verify", "teams_logout"] as const)(
      "is refused for %s before anything happens",
      async (op) => {
        const signIn = vi.fn();
        saveTeamsAccount(account);
        await expect(
          handleTeamsRpc({ op }, deps({ agentGuard: refused, signIn }))
        ).rejects.toMatchObject({ code: "forbidden" });
        expect(signIn).not.toHaveBeenCalled();
        // Signing out was refused too: the account is still there.
        expect(getTeamsAccount()?.id).toBe("oid-1");
      }
    );

    it("is refused through the integration RPC the app uses", async () => {
      await expect(
        handleRpc("azure-devops", { op: "teams_status" }, { agentGuard: refused })
      ).rejects.toMatchObject({ code: "forbidden" });
    });

    it("uses the real process and environment check by default", async () => {
      await expect(
        handleTeamsRpc({ op: "teams_status" }, { env: { KAI_AGENT_SESSION: "1" } as never })
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  it("is reachable through the integration RPC dispatch", async () => {
    const res = await handleRpc(
      "azure-devops",
      { op: "teams_status" },
      { agentGuard: async () => {} }
    );
    expect(res).toMatchObject({ ok: true, teams: { account: null } });
  });
});
