import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authHeaderFor, resetAzTokenCache } from "../core/integrations/providers/azure-devops/auth";
import {
  clientIdFrom,
  parseTokenSet,
  refreshTokenSet,
  serializeTokenSet,
  signInWithBrowser,
  type TokenSet,
} from "../core/integrations/providers/azure-devops/oauth";
import type { SecretStore } from "../core/integrations/secretStore";
import { IntegrationError, type IntegrationAccount } from "../core/integrations/types";

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const env = { KAI_AZURE_CLIENT_ID: CLIENT_ID } as NodeJS.ProcessEnv;
const realFetch = globalThis.fetch;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Routes the Microsoft token endpoint and the Azure DevOps profile APIs. */
function fakeNetwork(opts: { orgs?: string[]; tokenReply?: () => Response } = {}) {
  const tokenBodies: URLSearchParams[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/oauth2/v2.0/token")) {
      tokenBodies.push(new URLSearchParams(String(init?.body)));
      return (
        opts.tokenReply?.() ??
        json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 })
      );
    }
    if (url.includes("/profile/profiles/me")) {
      return json({ id: "u1", displayName: "Suraj Chand", emailAddress: "s@contoso.com" });
    }
    if (url.includes("/_apis/accounts")) {
      return json({
        value: (opts.orgs ?? ["contoso", "fabrikam"]).map((accountName) => ({ accountName })),
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, tokenBodies };
}

/** Plays the browser: follows the redirect back to the local listener. */
const browserReturning =
  (query: (state: string) => string) =>
  (authUrl: string): void => {
    const u = new URL(authUrl);
    const redirect = u.searchParams.get("redirect_uri")!;
    const state = u.searchParams.get("state")!;
    void realFetch(`${redirect}?${query(state)}`).catch(() => undefined);
  };

describe("clientIdFrom", () => {
  it("explains how to set the app registration when none is configured", () => {
    expect(() => clientIdFrom({} as NodeJS.ProcessEnv)).toThrowError(IntegrationError);
    try {
      clientIdFrom({ KAI_AZURE_CLIENT_ID: "not-a-guid" } as NodeJS.ProcessEnv);
    } catch (err) {
      expect((err as IntegrationError).code).toBe("config");
      expect((err as IntegrationError).hint).toContain("KAI_AZURE_CLIENT_ID");
    }
  });

  it("accepts an override from the environment", () => {
    expect(clientIdFrom(env)).toBe(CLIENT_ID);
  });
});

describe("signInWithBrowser", () => {
  it("signs in with PKCE, reads the organizations and never types anything", async () => {
    const net = fakeNetwork();
    let shownUrl = "";
    const result = await signInWithBrowser(
      { onUrl: (u) => (shownUrl = u) },
      {
        env,
        fetchImpl: net.fetchImpl,
        http: { fetchImpl: net.fetchImpl },
        openUrl: browserReturning((state) => `code=the-code&state=${state}`),
      }
    );

    const url = new URL(shownUrl);
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
    );
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("499b84ac-1321-427f-aa17-267ca6975798");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/$/);

    // The code is traded using the verifier whose hash was sent in the first step.
    const body = net.tokenBodies[0];
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.has("client_secret")).toBe(false);
    const challenge = crypto
      .createHash("sha256")
      .update(body.get("code_verifier")!)
      .digest("base64url");
    expect(challenge).toBe(url.searchParams.get("code_challenge"));

    expect(result.orgs).toEqual(["contoso", "fabrikam"]);
    expect(result.user).toEqual({ name: "Suraj Chand", email: "s@contoso.com" });
    const tokens = parseTokenSet(result.secret)!;
    expect(tokens.accessToken).toBe("access-1");
    expect(tokens.refreshToken).toBe("refresh-1");
  });

  it("ignores a redirect whose state does not match, then accepts the real one", async () => {
    const net = fakeNetwork();
    const result = await signInWithBrowser(
      {},
      {
        env,
        fetchImpl: net.fetchImpl,
        http: { fetchImpl: net.fetchImpl },
        openUrl: (authUrl) => {
          const u = new URL(authUrl);
          const redirect = u.searchParams.get("redirect_uri")!;
          const state = u.searchParams.get("state")!;
          void (async () => {
            const forged = await realFetch(`${redirect}?code=evil&state=wrong`);
            expect(forged.status).toBe(400);
            await realFetch(`${redirect}?code=good&state=${state}`);
          })();
        },
      }
    );
    expect(net.tokenBodies).toHaveLength(1);
    expect(net.tokenBodies[0].get("code")).toBe("good");
    expect(result.orgs.length).toBeGreaterThan(0);
  });

  it("reports a cancelled sign-in without calling Microsoft", async () => {
    const net = fakeNetwork();
    await expect(
      signInWithBrowser(
        {},
        {
          env,
          fetchImpl: net.fetchImpl,
          http: { fetchImpl: net.fetchImpl },
          openUrl: browserReturning((state) => `error=access_denied&state=${state}`),
        }
      )
    ).rejects.toMatchObject({ code: "auth", message: "Sign-in was cancelled." });
    expect(net.tokenBodies).toHaveLength(0);
  });

  it("gives up with a clear message when the browser never comes back", async () => {
    const net = fakeNetwork();
    await expect(
      signInWithBrowser(
        {},
        {
          env,
          fetchImpl: net.fetchImpl,
          signInTimeoutMs: 40,
          openUrl: () => undefined,
        }
      )
    ).rejects.toMatchObject({ code: "auth", message: expect.stringContaining("timed out") });
  });

  it("fails clearly when the account belongs to no organization", async () => {
    const net = fakeNetwork({ orgs: [] });
    await expect(
      signInWithBrowser(
        {},
        {
          env,
          fetchImpl: net.fetchImpl,
          http: { fetchImpl: net.fetchImpl },
          openUrl: browserReturning((state) => `code=c&state=${state}`),
        }
      )
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("never opens the browser when the app registration is missing", async () => {
    const openUrl = vi.fn();
    await expect(
      signInWithBrowser({}, { env: {} as NodeJS.ProcessEnv, openUrl })
    ).rejects.toMatchObject({ code: "config" });
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe("refreshTokenSet", () => {
  const current: TokenSet = { accessToken: "old-a", refreshToken: "old-r", expiresAt: 0 };

  it("keeps the rotated refresh token", async () => {
    const net = fakeNetwork({
      tokenReply: () => json({ access_token: "new-a", refresh_token: "new-r", expires_in: 100 }),
    });
    const next = await refreshTokenSet(current, { env, fetchImpl: net.fetchImpl, now: () => 1000 });
    expect(next).toEqual({
      accessToken: "new-a",
      refreshToken: "new-r",
      expiresAt: 1000 + 100_000,
    });
    expect(net.tokenBodies[0].get("grant_type")).toBe("refresh_token");
    expect(net.tokenBodies[0].get("refresh_token")).toBe("old-r");
  });

  it("reuses the old refresh token when Microsoft sends none", async () => {
    const net = fakeNetwork({ tokenReply: () => json({ access_token: "new-a", expires_in: 100 }) });
    const next = await refreshTokenSet(current, { env, fetchImpl: net.fetchImpl });
    expect(next.refreshToken).toBe("old-r");
  });

  it("asks the user to connect again when the sign-in has expired", async () => {
    const net = fakeNetwork({
      tokenReply: () =>
        json({ error: "invalid_grant", error_description: "AADSTS70000 expired old-r" }, 400),
    });
    await expect(refreshTokenSet(current, { env, fetchImpl: net.fetchImpl })).rejects.toMatchObject(
      {
        code: "auth",
        message: "Your Azure DevOps sign-in has expired.",
      }
    );
  });
});

describe("authHeaderFor with browser sign-in", () => {
  const account: IntegrationAccount = {
    id: "azure-devops:contoso",
    provider: "azure-devops",
    org: "contoso",
    baseUrl: "https://dev.azure.com/contoso",
    authMethod: "oauth",
    createdAt: "2026-10-30T00:00:00Z",
  };
  const memoryStore = (initial?: string) => {
    const data = new Map<string, string>();
    if (initial) data.set("azure-devops:contoso", initial);
    const store: SecretStore = {
      get: async (k) => data.get(k) ?? null,
      has: async (k) => data.has(k),
      set: async (k, v) => {
        data.set(k, v);
        return "keychain" as never;
      },
      delete: async (k) => void data.delete(k),
    };
    return { store, data };
  };
  // The store keys by account id through secretKeyFor; read whatever it wrote.
  const stored = (data: Map<string, string>) => parseTokenSet([...data.values()][0] ?? null);

  beforeEach(() => resetAzTokenCache());

  it("sends a still-valid access token as a bearer without any refresh", async () => {
    const { store } = memoryStore();
    const tokens: TokenSet = { accessToken: "live", refreshToken: "r", expiresAt: 10_000_000 };
    await store.set(
      (await import("../core/integrations/secretStore")).secretKeyFor(account.id),
      serializeTokenSet(tokens)
    );
    const net = fakeNetwork();
    const auth = await authHeaderFor(account, store, {
      env,
      oauth: { env, fetchImpl: net.fetchImpl, now: () => 0 },
    });
    expect(auth).toEqual({ header: "Bearer live", secret: "live" });
    expect(net.tokenBodies).toHaveLength(0);
  });

  it("refreshes an expiring token once for concurrent calls and saves the new tokens", async () => {
    const { store, data } = memoryStore();
    const { secretKeyFor } = await import("../core/integrations/secretStore");
    await store.set(
      secretKeyFor(account.id),
      serializeTokenSet({ accessToken: "stale", refreshToken: "r1", expiresAt: 1000 })
    );
    const net = fakeNetwork({
      tokenReply: () => json({ access_token: "fresh", refresh_token: "r2", expires_in: 3600 }),
    });
    const deps = { env, oauth: { env, fetchImpl: net.fetchImpl, now: () => 5000 } };
    const [a, b] = await Promise.all([
      authHeaderFor(account, store, deps),
      authHeaderFor(account, store, deps),
    ]);
    expect(a.header).toBe("Bearer fresh");
    expect(b.header).toBe("Bearer fresh");
    expect(net.tokenBodies).toHaveLength(1);
    expect(stored(data)).toMatchObject({ accessToken: "fresh", refreshToken: "r2" });
  });

  it("says to connect again when nothing is stored", async () => {
    const { store } = memoryStore();
    await expect(authHeaderFor(account, store, { env })).rejects.toMatchObject({
      code: "auth",
      message: "Not signed in to contoso.",
    });
  });
});
