import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  serializeTokenSet,
  type TokenSet,
} from "../core/integrations/providers/azure-devops/oauth";
import type { SecretStore } from "../core/integrations/secretStore";
import { IntegrationError } from "../core/integrations/types";
import {
  clearSavedTeamsClientId,
  clearTeamsAccount,
  getSavedTeamsClientId,
  getTeamsAccount,
  saveTeamsAccount,
  saveTeamsClientId,
  teamsSecretKey,
} from "../core/teams/config";
import {
  GraphClient,
  isGraphUrl,
  MAX_FILE_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_CHUNK_BYTES,
  type GraphDeps,
} from "../core/teams/graph";
import {
  CHANNEL_READ_SCOPE,
  scopesFor,
  scopesFromAccessToken,
  signInToTeams,
  teamsApp,
  teamsClientId,
} from "../core/teams/oauth";
import { storeTeamsSignIn, TeamsSession } from "../core/teams/session";

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

function memorySecrets(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    has: async (k) => map.has(k),
    set: async (k, v) => {
      map.set(k, v);
      return "os";
    },
    delete: async (k) => void map.delete(k),
  };
}

describe("isGraphUrl", () => {
  it("accepts only https Graph addresses with no credentials in them", () => {
    expect(isGraphUrl("https://graph.microsoft.com/v1.0/me")).toBe(true);
    expect(isGraphUrl("http://graph.microsoft.com/v1.0/me")).toBe(false);
    expect(isGraphUrl("https://graph.microsoft.com.evil.example/v1.0/me")).toBe(false);
    expect(isGraphUrl("https://user@graph.microsoft.com/v1.0/me")).toBe(false);
    expect(isGraphUrl("https://evil.example/graph.microsoft.com")).toBe(false);
    expect(isGraphUrl("not a url")).toBe(false);
  });
});

describe("GraphClient", () => {
  const make = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init ?? {})
    ) as unknown as typeof fetch;
    const deps: GraphDeps = { fetchImpl, sleep: async () => undefined };
    return {
      graph: new GraphClient(async () => "tok", deps),
      fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>,
    };
  };

  it("lists joined teams across pages, sorted, with the bearer token", async () => {
    const { graph, fetchImpl } = make((url) =>
      url.endsWith("/me/joinedTeams")
        ? json({
            value: [{ id: "2", displayName: "Zeta" }],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/joinedTeams?page=2",
          })
        : json({ value: [{ id: "1", displayName: "Alpha\u001b[2J" }] })
    );
    expect(await graph.joinedTeams()).toEqual([
      { id: "1", name: "Alpha[2J" },
      { id: "2", name: "Zeta" },
    ]);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("never follows a next link that points somewhere else", async () => {
    const { graph, fetchImpl } = make(() =>
      json({ value: [], "@odata.nextLink": "https://evil.example/steal" })
    );
    await graph.joinedTeams();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps messages oldest first, as text, with images, files and the sender id", async () => {
    const { graph } = make(() =>
      json({
        value: [
          {
            id: "m2",
            createdDateTime: "2026-11-04T09:15:00Z",
            messageType: "message",
            from: { user: { id: "u2", displayName: "Priya Nair" } },
            body: {
              contentType: "html",
              content:
                '<div>see <img src="https://graph.microsoft.com/v1.0/chats/c/messages/m2/hostedContents/h1/$value" alt="shot"></div>',
            },
            attachments: [
              { name: "plan.xlsx", contentUrl: "https://contoso.sharepoint.com/plan.xlsx" },
            ],
          },
          {
            id: "m1",
            createdDateTime: "2026-11-04T09:12:00Z",
            from: { user: { id: "u1", displayName: "Marcus" } },
            body: { contentType: "text", content: "hello" },
          },
          {
            id: "gone",
            createdDateTime: "2026-11-04T09:20:00Z",
            deletedDateTime: "2026-11-04T09:21:00Z",
            body: { content: "x" },
          },
        ],
      })
    );
    const msgs = await graph.messages({ kind: "chat", chatId: "c" });
    expect(msgs.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(msgs[0]).toMatchObject({ from: "Marcus", fromId: "u1", text: "hello", system: false });
    expect(msgs[1].text).toBe("see");
    expect(msgs[1].images).toEqual([
      {
        url: "https://graph.microsoft.com/v1.0/chats/c/messages/m2/hostedContents/h1/$value",
        alt: "shot",
        fetchable: true,
      },
    ]);
    expect(msgs[1].files).toEqual([
      { name: "plan.xlsx", url: "https://contoso.sharepoint.com/plan.xlsx" },
    ]);
  });

  it("names chats after the other people in them", async () => {
    const { graph } = make(() =>
      json({
        value: [
          {
            id: "a",
            chatType: "oneOnOne",
            topic: null,
            members: [
              { userId: "me", displayName: "Me" },
              { userId: "p", displayName: "Priya" },
            ],
          },
          { id: "b", chatType: "group", topic: "Release crew", members: [] },
          {
            id: "c",
            chatType: "group",
            topic: null,
            members: ["A", "B", "C", "D", "E"].map((n) => ({ userId: n, displayName: n })),
          },
        ],
      })
    );
    const chats = await graph.chats("me");
    expect(chats.map((c) => c.title)).toEqual(["Priya", "Release crew", "A, B, C +2"]);
  });

  it("reads when each chat was last active, who wrote last, and when you last read it", async () => {
    let asked = "";
    const { graph } = make((url) => {
      asked = url;
      return json({
        value: [
          {
            id: "a",
            chatType: "oneOnOne",
            members: [{ userId: "p", displayName: "Priya" }],
            lastMessagePreview: {
              createdDateTime: "2026-11-04T09:15:00Z",
              from: { user: { id: "p" } },
            },
            viewpoint: { lastMessageReadDateTime: "2026-11-04T09:00:00Z" },
          },
          { id: "b", chatType: "group", topic: "Quiet", members: [] },
        ],
      });
    });
    const chats = await graph.chats("me");
    expect(chats[0]).toMatchObject({
      lastAt: "2026-11-04T09:15:00Z",
      lastFromId: "p",
      lastReadAt: "2026-11-04T09:00:00Z",
    });
    expect(chats[1]).toMatchObject({ lastAt: "", lastFromId: "", lastReadAt: "" });
    expect(asked).toContain("expand=members,lastMessagePreview");
  });

  it("pages back through a conversation, only ever following Graph addresses", async () => {
    const urls: string[] = [];
    const { graph } = make((url) => {
      urls.push(url);
      return url.includes("older")
        ? json({
            value: [
              { id: "m0", createdDateTime: "2026-11-04T08:00:00Z", body: { content: "old" } },
            ],
          })
        : json({
            value: [
              { id: "m1", createdDateTime: "2026-11-04T09:00:00Z", body: { content: "new" } },
            ],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/chats/c/messages?older=1",
          });
    });
    const first = await graph.messagesPage({ kind: "chat", chatId: "c" }, { top: 10 });
    expect(first.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(first.next).toBe("https://graph.microsoft.com/v1.0/chats/c/messages?older=1");
    const second = await graph.messagesPage(
      { kind: "chat", chatId: "c" },
      { pageUrl: first.next! }
    );
    expect(second.messages.map((m) => m.id)).toEqual(["m0"]);
    expect(second.next).toBeNull();
    expect(urls[1]).toBe("https://graph.microsoft.com/v1.0/chats/c/messages?older=1");
    await expect(
      graph.messagesPage({ kind: "chat", chatId: "c" }, { pageUrl: "https://evil.example/steal" })
    ).rejects.toThrow(/not Microsoft Graph/);
    expect(urls).toHaveLength(2);
  });

  it("ignores a next link that points somewhere else", async () => {
    const { graph } = make(() =>
      json({ value: [], "@odata.nextLink": "https://evil.example/next" })
    );
    expect((await graph.messagesPage({ kind: "chat", chatId: "c" })).next).toBeNull();
  });

  it("posts a message with inline images as hosted contents", async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    const { graph } = make((url, init) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return json({ id: "new" }, 201);
    });
    await graph.send(
      { kind: "channel", teamId: "T 1", channelId: "C" },
      {
        text: "hi",
        images: [{ name: "a.png", bytes: Uint8Array.from([1, 2, 3]), contentType: "image/png" }],
        links: [],
      }
    );
    expect(sent!.url).toBe("https://graph.microsoft.com/v1.0/teams/T%201/channels/C/messages");
    expect(sent!.body.hostedContents).toEqual([
      { "@microsoft.graph.temporaryId": "1", contentBytes: "AQID", contentType: "image/png" },
    ]);
    expect(String((sent!.body.body as { content: string }).content)).toContain(
      "hostedContents/1/$value"
    );
  });

  it("refuses to send nothing", async () => {
    const { graph, fetchImpl } = make(() => json({}));
    await expect(
      graph.send({ kind: "chat", chatId: "c" }, { text: "  ", images: [], links: [] })
    ).rejects.toThrow(/nothing to send/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uploads a file to OneDrive and returns an organization link", async () => {
    const seen: string[] = [];
    const { graph } = make((url) => {
      seen.push(url);
      return url.includes("createLink")
        ? json({ link: { webUrl: "https://contoso.sharepoint.com/s/x" } })
        : json({ id: "item1" });
    });
    expect(await graph.uploadFile("my report.pdf", Uint8Array.from([1]))).toBe(
      "https://contoso.sharepoint.com/s/x"
    );
    expect(seen[0]).toBe(
      "https://graph.microsoft.com/v1.0/me/drive/root:/Kai%20Teams/my%20report.pdf:/content"
    );
    expect(seen).toHaveLength(2); // the small-file path: one PUT, one createLink, no session
    expect(seen.some((u) => u.includes("createUploadSession"))).toBe(false);
  });

  it("refuses a file over the upload limit before calling Graph", async () => {
    const { graph, fetchImpl } = make(() => json({}));
    await expect(graph.uploadFile("huge.bin", new Uint8Array(MAX_FILE_BYTES + 1))).rejects.toThrow(
      /larger than 250 MB/
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe("upload sessions (files over 4 MB)", () => {
    const SESSION = "https://contoso-my.sharepoint.com/upload/abc";
    const LINK = "https://contoso.sharepoint.com/s/big";
    /** A fake OneDrive: one session that accepts chunks in order and can be told to misbehave. */
    function drive(
      opts: { failPut?: (n: number, init: RequestInit) => Response | "drop" | null } = {}
    ) {
      const calls: Array<{
        method: string;
        url: string;
        headers: Record<string, string>;
        len: number;
      }> = [];
      let received = 0;
      let puts = 0;
      const { graph, fetchImpl } = make((url, init) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        const method = init.method ?? "GET";
        const body = init.body as Uint8Array | undefined;
        calls.push({ method, url, headers, len: body?.byteLength ?? 0 });
        if (url.endsWith("/createUploadSession")) return json({ uploadUrl: SESSION });
        if (url.includes("createLink")) return json({ link: { webUrl: LINK } });
        if (url !== SESSION) return json({}, 500);
        if (method === "GET") return json({ nextExpectedRanges: [`${received}-`] });
        if (method === "DELETE") return new Response(null, { status: 204 });
        puts++;
        const injected = opts.failPut?.(puts, init);
        if (injected === "drop") throw new Error("socket hang up");
        if (injected) return injected;
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers["content-range"] ?? "");
        const start = Number(range?.[1]);
        const end = Number(range?.[2]);
        const total = Number(range?.[3]);
        if (start !== received) return json({ error: { code: "invalidRange" } }, 416);
        received = end + 1;
        return received >= total
          ? json({ id: "big1" }, 201)
          : json({ nextExpectedRanges: [`${received}-`] }, 202);
      });
      return { graph, fetchImpl, calls, puts: () => puts };
    }
    const size = UPLOAD_CHUNK_BYTES * 2 + 123; // three chunks, the last one short

    it("sends a large file in 320 KiB-aligned chunks and returns the share link", async () => {
      const d = drive();
      const progress: number[] = [];
      const url = await d.graph.uploadFile("big.bin", new Uint8Array(size), (sent) =>
        progress.push(sent)
      );
      expect(url).toBe(LINK);
      const puts = d.calls.filter((c) => c.method === "PUT");
      expect(puts.map((c) => c.headers["content-range"])).toEqual([
        `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${size}`,
        `bytes ${UPLOAD_CHUNK_BYTES}-${UPLOAD_CHUNK_BYTES * 2 - 1}/${size}`,
        `bytes ${UPLOAD_CHUNK_BYTES * 2}-${size - 1}/${size}`,
      ]);
      expect(puts.map((c) => c.len)).toEqual([UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES, 123]);
      expect(UPLOAD_CHUNK_BYTES % (320 * 1024)).toBe(0);
      expect(d.calls[0].url).toBe(
        "https://graph.microsoft.com/v1.0/me/drive/root:/Kai%20Teams/big.bin:/createUploadSession"
      );
      expect(progress[0]).toBe(0);
      expect(progress[progress.length - 1]).toBe(size);
      expect(progress).toEqual([...progress].sort((a, b) => a - b));
    });

    it("never sends the Graph token to the upload address", async () => {
      const d = drive();
      await d.graph.uploadFile("big.bin", new Uint8Array(size));
      const toSession = d.calls.filter((c) => c.url === SESSION);
      expect(toSession.length).toBeGreaterThan(0);
      for (const c of toSession)
        expect(JSON.stringify(c.headers).toLowerCase()).not.toContain("authorization");
      expect(d.calls[0].headers.authorization).toBe("Bearer tok");
    });

    it("retries a chunk after a dropped connection and resumes from what OneDrive has", async () => {
      const d = drive({ failPut: (n) => (n === 2 ? "drop" : null) });
      expect(await d.graph.uploadFile("big.bin", new Uint8Array(size))).toBe(LINK);
      const puts = d.calls.filter((c) => c.method === "PUT");
      expect(puts).toHaveLength(4); // the second chunk was sent twice
      expect(d.calls.some((c) => c.method === "GET" && c.url === SESSION)).toBe(true);
    });

    it("retries a chunk after a server error", async () => {
      const d = drive({ failPut: (n) => (n === 1 ? json({}, 503) : null) });
      expect(await d.graph.uploadFile("big.bin", new Uint8Array(size))).toBe(LINK);
      expect(d.puts()).toBe(4);
    });

    it("gives up after repeated failures and cancels the session", async () => {
      const d = drive({ failPut: () => "drop" });
      await expect(d.graph.uploadFile("big.bin", new Uint8Array(size))).rejects.toThrow(
        /kept failing/
      );
      expect(d.calls.some((c) => c.method === "DELETE" && c.url === SESSION)).toBe(true);
      expect(d.calls.some((c) => c.url.includes("createLink"))).toBe(false);
    });

    it("stops at once on an error that retrying cannot fix", async () => {
      const d = drive({ failPut: () => json({ error: { code: "accessDenied" } }, 403) });
      await expect(d.graph.uploadFile("big.bin", new Uint8Array(size))).rejects.toThrow(
        /refused this request/
      );
      expect(d.puts()).toBe(1);
    });

    it("reports an expired session", async () => {
      const d = drive({ failPut: () => json({}, 404) });
      await expect(d.graph.uploadFile("big.bin", new Uint8Array(size))).rejects.toThrow(/expired/);
    });

    it("refuses an upload address that is not https", async () => {
      const { graph } = make(() => json({ uploadUrl: "http://evil.example/up" }));
      await expect(
        graph.uploadFile("big.bin", new Uint8Array(MAX_UPLOAD_BYTES + 1))
      ).rejects.toThrow(/usable upload address/);
    });
  });

  it("fetches image bytes only from Graph", async () => {
    const { graph, fetchImpl } = make(
      () => new Response(Uint8Array.from([1, 2]), { headers: { "content-type": "image/png" } })
    );
    expect((await graph.image("https://graph.microsoft.com/v1.0/x/$value")).bytes).toEqual(
      Uint8Array.from([1, 2])
    );
    await expect(graph.image("https://evil.example/pic.png")).rejects.toThrow(
      /not Microsoft Graph/
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("turns HTTP failures into clear errors and retries throttling", async () => {
    const status =
      (n: number, code = "") =>
      () =>
        json({ error: { code, message: "details here" } }, n);
    await expect(make(status(401)).graph.joinedTeams()).rejects.toMatchObject({ code: "auth" });
    const forbidden = (await make(status(403, "Forbidden"))
      .graph.joinedTeams()
      .catch((e: unknown) => e)) as IntegrationError;
    expect(forbidden.code).toBe("forbidden");
    expect(forbidden.hint).toContain("administrator");
    await expect(make(status(404)).graph.joinedTeams()).rejects.toMatchObject({
      code: "not_found",
    });

    let calls = 0;
    const { graph } = make(() =>
      ++calls < 3
        ? new Response("slow down", { status: 429, headers: { "retry-after": "1" } })
        : json({ value: [] })
    );
    expect(await graph.joinedTeams()).toEqual([]);
    expect(calls).toBe(3);
  });
});

describe("Teams sign-in", () => {
  let home: string;
  const savedHome = process.env.KAI_HOME;
  beforeEach(() => {
    // The saved app ID lives in config.json: never read the developer's real one.
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-teams-id-"));
    process.env.KAI_HOME = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.KAI_HOME;
    else process.env.KAI_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("needs an app registration and explains how to set it", () => {
    expect(() => teamsClientId({} as NodeJS.ProcessEnv)).toThrowError(IntegrationError);
    expect(teamsClientId({ KAI_TEAMS_CLIENT_ID: CLIENT_ID } as NodeJS.ProcessEnv)).toBe(CLIENT_ID);
    // Falls back to the app Azure DevOps sign-in uses.
    expect(teamsClientId({ KAI_AZURE_CLIENT_ID: CLIENT_ID } as NodeJS.ProcessEnv)).toBe(CLIENT_ID);
  });

  it("uses the app ID saved on this computer, and the environment still wins", () => {
    const OTHER = "99999999-9999-4999-8999-999999999999";
    saveTeamsClientId(CLIENT_ID);
    expect(teamsClientId({} as NodeJS.ProcessEnv)).toBe(CLIENT_ID);
    expect(teamsClientId({ KAI_TEAMS_CLIENT_ID: OTHER } as NodeJS.ProcessEnv)).toBe(OTHER);
    // The saved ID beats the Azure DevOps registration.
    expect(teamsClientId({ KAI_AZURE_CLIENT_ID: OTHER } as NodeJS.ProcessEnv)).toBe(CLIENT_ID);
  });

  it("ignores a damaged saved ID instead of signing in with it", () => {
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ teams: { clientId: "not-a-guid" } })
    );
    expect(() => teamsClientId({} as NodeJS.ProcessEnv)).toThrowError(IntegrationError);
  });

  it("treats an example ID (RFC 4122 / all zeros) as no app, from every source", () => {
    const RFC = "f81d4fae-7dec-11d0-a765-00a0c91e6bf6";
    const NIL = "00000000-0000-0000-0000-000000000000";
    // Saved by an older Kai: ignored, so the person is asked again (the Azure ID still applies).
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ teams: { clientId: RFC } }));
    expect(() => teamsClientId({} as NodeJS.ProcessEnv)).toThrowError(/not set up yet/);
    expect(teamsClientId({ KAI_AZURE_CLIENT_ID: CLIENT_ID } as NodeJS.ProcessEnv)).toBe(CLIENT_ID);
    // From the environment: refused loudly, never used for a sign-in.
    for (const id of [RFC, NIL, RFC.toUpperCase()]) {
      expect(() => teamsClientId({ KAI_TEAMS_CLIENT_ID: id } as NodeJS.ProcessEnv)).toThrowError(
        /KAI_TEAMS_CLIENT_ID is not a valid client ID/
      );
      expect(() => teamsClientId({ KAI_AZURE_CLIENT_ID: id } as NodeJS.ProcessEnv)).toThrowError(
        /KAI_AZURE_CLIENT_ID is not a valid client ID/
      );
    }
  });

  it("keeps the saved app ID when the account signs out and in again", () => {
    saveTeamsClientId(CLIENT_ID);
    saveTeamsAccount({ id: "o", name: "Alex", scopes: [], signedInAt: "now" });
    expect(getSavedTeamsClientId()).toBe(CLIENT_ID);
    clearTeamsAccount();
    expect(getTeamsAccount()).toBeNull();
    expect(getSavedTeamsClientId()).toBe(CLIENT_ID);
    clearSavedTeamsClientId();
    expect(getSavedTeamsClientId()).toBeNull();
  });

  it("keeps channel reading as its own scope, so it can be dropped on its own", () => {
    expect(scopesFor(false)).not.toContain(CHANNEL_READ_SCOPE);
    expect(scopesFor(true)).toContain(CHANNEL_READ_SCOPE);
    const app = teamsApp(false).scope;
    expect(app).toContain("https://graph.microsoft.com/Chat.ReadWrite");
    expect(app).toContain("offline_access");
    expect(app).not.toContain("ChannelMessage.Read.All");
    expect(teamsApp(true).scope).toContain("https://graph.microsoft.com/ChannelMessage.Read.All");
  });

  it("reads the granted permissions from the access token", () => {
    expect(scopesFromAccessToken(jwt({ scp: "User.Read Chat.ReadWrite" }))).toEqual([
      "User.Read",
      "Chat.ReadWrite",
    ]);
    expect(scopesFromAccessToken("garbage")).toEqual([]);
  });

  it("signs in with PKCE, asks Graph for the profile and reports the granted permissions", async () => {
    const forms: URLSearchParams[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth2/v2.0/token")) {
        forms.push(new URLSearchParams(String(init?.body)));
        return json({
          access_token: jwt({ scp: "User.Read Chat.ReadWrite" }),
          refresh_token: "r1",
          expires_in: 3600,
        });
      }
      if (url.endsWith("/me"))
        return json({ id: "oid-1", displayName: "Alex", mail: "alex@contoso.com" });
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    let shown = "";
    const result = await signInToTeams(
      { channelHistory: true, onUrl: (u) => (shown = u) },
      {
        env: { KAI_TEAMS_CLIENT_ID: CLIENT_ID } as NodeJS.ProcessEnv,
        fetchImpl,
        graph: { fetchImpl },
        openUrl: (authUrl) => {
          const u = new URL(authUrl);
          void realFetch(
            `${u.searchParams.get("redirect_uri")}?code=the-code&state=${u.searchParams.get("state")}`
          ).catch(() => undefined);
        },
      }
    );
    const auth = new URL(shown);
    expect(auth.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("scope")).toContain(
      "https://graph.microsoft.com/ChannelMessage.Read.All"
    );
    expect(forms[0].get("grant_type")).toBe("authorization_code");
    expect(forms[0].get("code")).toBe("the-code");
    expect(forms[0].get("code_verifier")).toBeTruthy();
    expect(result.user).toEqual({ id: "oid-1", name: "Alex", email: "alex@contoso.com" });
    expect(result.scopes).toEqual(["User.Read", "Chat.ReadWrite"]);
    expect(JSON.parse(result.secret).refreshToken).toBe("r1");
  });

  describe("channel messages by default", () => {
    const tokenFetch = (scp: string) =>
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/oauth2/v2.0/token")) {
          return json({ access_token: jwt({ scp }), refresh_token: "r1", expires_in: 3600 });
        }
        if (url.endsWith("/me")) return json({ id: "oid-1", displayName: "Alex" });
        return new Response("nope", { status: 404 });
      }) as unknown as typeof fetch;

    /** Answers each opened sign-in page with the next reply: a code, or a Microsoft error. */
    const browser = (replies: string[]) => {
      const scopes: string[] = [];
      return {
        scopes,
        openUrl: (authUrl: string) => {
          const u = new URL(authUrl);
          scopes.push(u.searchParams.get("scope") ?? "");
          const reply = replies[scopes.length - 1] ?? "code=the-code";
          void realFetch(
            `${u.searchParams.get("redirect_uri")}?${reply}&state=${u.searchParams.get("state")}`
          ).catch(() => undefined);
        },
      };
    };
    const env = { KAI_TEAMS_CLIENT_ID: CLIENT_ID } as NodeJS.ProcessEnv;

    it("asks to read channel messages without being told to", async () => {
      const fetchImpl = tokenFetch("User.Read ChannelMessage.Read.All");
      const b = browser(["code=the-code"]);
      const result = await signInToTeams(
        {},
        { env, fetchImpl, graph: { fetchImpl }, openUrl: b.openUrl }
      );
      expect(b.scopes).toHaveLength(1);
      expect(b.scopes[0]).toContain("https://graph.microsoft.com/ChannelMessage.Read.All");
      expect(result.scopes).toContain(CHANNEL_READ_SCOPE);
    });

    it("signs in once more without it when an administrator has to approve it", async () => {
      const fetchImpl = tokenFetch("User.Read Chat.ReadWrite");
      const b = browser([
        "error=access_denied&error_description=AADSTS90094%3A+The+grant+requires+admin+permission",
        "code=the-code",
      ]);
      const result = await signInToTeams(
        {},
        { env, fetchImpl, graph: { fetchImpl }, openUrl: b.openUrl }
      );
      expect(b.scopes).toHaveLength(2);
      expect(b.scopes[0]).toContain("ChannelMessage.Read.All");
      expect(b.scopes[1]).not.toContain("ChannelMessage.Read.All");
      expect(result.scopes).not.toContain(CHANNEL_READ_SCOPE);
      expect(result.user.name).toBe("Alex");
    });

    it("does not ask again when the person simply cancels", async () => {
      const fetchImpl = tokenFetch("User.Read");
      const b = browser(["error=access_denied&error_description=The+user+cancelled"]);
      await expect(
        signInToTeams({}, { env, fetchImpl, graph: { fetchImpl }, openUrl: b.openUrl })
      ).rejects.toMatchObject({ message: "Sign-in was cancelled." });
      expect(b.scopes).toHaveLength(1);
    });

    it("skips channel messages entirely when told to", async () => {
      const fetchImpl = tokenFetch("User.Read");
      const b = browser(["code=the-code"]);
      await signInToTeams(
        { channelHistory: false },
        { env, fetchImpl, graph: { fetchImpl }, openUrl: b.openUrl }
      );
      expect(b.scopes[0]).not.toContain("ChannelMessage.Read.All");
    });
  });
});

describe("Teams config and session", () => {
  let home: string;
  const saved = process.env.KAI_HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-teams-"));
    process.env.KAI_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.KAI_HOME;
    else process.env.KAI_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const account = {
    id: "oid-1",
    name: "Alex",
    email: "alex@contoso.com",
    scopes: ["User.Read"],
    signedInAt: "now",
  };

  it("remembers who is signed in and forgets them on sign-out", () => {
    expect(getTeamsAccount()).toBeNull();
    saveTeamsAccount(account);
    expect(getTeamsAccount()).toEqual(account);
    clearTeamsAccount();
    expect(getTeamsAccount()).toBeNull();
  });

  it("keeps the rest of config.json, including Azure DevOps accounts", () => {
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ other: 1, integrations: { accounts: { x: { id: "x" } } } })
    );
    saveTeamsAccount(account);
    const raw = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    expect(raw.other).toBe(1);
    expect(raw.integrations.accounts.x).toEqual({ id: "x" });
    expect(raw.teams.account.id).toBe("oid-1");
  });

  it("stores no token in the config file", async () => {
    const secrets = memorySecrets();
    await storeTeamsSignIn(
      {
        secret: serializeTokenSet({
          accessToken: "ACCESS-TOKEN",
          refreshToken: "REFRESH-TOKEN",
          expiresAt: 1,
        }),
        user: { id: "oid-1", name: "Alex" },
        scopes: [],
      },
      secrets
    );
    expect(secrets.map.has(teamsSecretKey("oid-1"))).toBe(true);
    const raw = fs.readFileSync(path.join(home, "config.json"), "utf8");
    expect(raw).not.toContain("ACCESS-TOKEN");
    expect(raw).not.toContain("REFRESH-TOKEN");
  });

  const tokens = (over: Partial<TokenSet> = {}): TokenSet => ({
    accessToken: "A1",
    refreshToken: "R1",
    expiresAt: Date.now() + 3_600_000,
    ...over,
  });

  it("returns the stored token while it is fresh and says so when signed out", async () => {
    const secrets = memorySecrets();
    const session = new TeamsSession({ account, secrets });
    await expect(session.accessToken()).rejects.toMatchObject({ code: "auth" });
    secrets.map.set(teamsSecretKey("oid-1"), serializeTokenSet(tokens()));
    expect(await session.accessToken()).toBe("A1");
  });

  it("refreshes an expiring token once for concurrent callers and saves the rotated one", async () => {
    const secrets = memorySecrets();
    secrets.map.set(
      teamsSecretKey("oid-1"),
      serializeTokenSet(tokens({ expiresAt: Date.now() + 1000 }))
    );
    const fetchImpl = vi.fn(async () =>
      json({ access_token: "A2", refresh_token: "R2", expires_in: 3600 })
    ) as unknown as typeof fetch;
    const session = new TeamsSession({
      account,
      secrets,
      oauth: { fetchImpl, env: { KAI_TEAMS_CLIENT_ID: CLIENT_ID } as NodeJS.ProcessEnv },
    });
    const got = await Promise.all([
      session.accessToken(),
      session.accessToken(),
      session.accessToken(),
    ]);
    expect(got).toEqual(["A2", "A2", "A2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(secrets.map.get(teamsSecretKey("oid-1"))!).refreshToken).toBe("R2");
  });

  it("knows whether channel messages may be read", () => {
    expect(new TeamsSession({ account, secrets: memorySecrets() }).canReadChannels).toBe(false);
    expect(
      new TeamsSession({
        account: { ...account, scopes: [CHANNEL_READ_SCOPE] },
        secrets: memorySecrets(),
      }).canReadChannels
    ).toBe(true);
  });
});
