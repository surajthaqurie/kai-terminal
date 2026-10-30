import { beforeEach, describe, expect, it } from "vitest";
import { createAzureDevOpsProvider } from "../core/integrations/providers/azure-devops";
import { resetAzTokenCache } from "../core/integrations/providers/azure-devops/auth";
import type { ProviderContext } from "../core/integrations/types";
import { MemorySecrets, azAccount, fakeFetch, type FakeRoute } from "./helpers/integrationsEnv";

const PAT = "pat-secret-123";

function setup(routes: FakeRoute[], opts: { az?: boolean } = {}) {
  const { fetchImpl, calls } = fakeFetch(routes);
  const secrets = new MemorySecrets();
  const account = azAccount("contoso", opts.az ? "az" : "pat");
  if (!opts.az) secrets.data.set("kai/azure-devops/contoso", PAT);
  const provider = createAzureDevOpsProvider({
    http: { fetchImpl, sleep: async () => {} },
    auth: {
      env: {},
      run: async () => ({
        code: 0,
        stdout: JSON.stringify({ accessToken: "entra-token", expires_on: 4102444800 }),
        stderr: "",
      }),
    },
  });
  const ctx: ProviderContext = {
    account,
    secrets,
    binding: {
      provider: "azure-devops",
      account: account.id,
      project: "My Project",
      repo: "api",
      boundAt: "2026-10-29T00:00:00.000Z",
    },
  };
  return { provider, ctx, calls, secrets, account };
}

beforeEach(() => resetAzTokenCache());

describe("account building", () => {
  const { provider } = setup([]);

  it("normalizes a cloud organization", () => {
    expect(provider.buildAccount({ org: "Contoso", authMethod: "az" })).toMatchObject({
      id: "azure-devops:contoso",
      org: "Contoso",
      baseUrl: "https://dev.azure.com/Contoso",
      apiVersion: "7.1",
    });
  });

  it("accepts an Azure DevOps Server URL and uses an older api-version", () => {
    expect(
      provider.buildAccount({
        baseUrl: "https://tfs.corp.local/tfs/DefaultCollection/",
        authMethod: "pat",
      })
    ).toMatchObject({
      id: "azure-devops:tfs.corp.local/tfs/defaultcollection",
      org: "DefaultCollection",
      baseUrl: "https://tfs.corp.local/tfs/DefaultCollection",
      apiVersion: "7.0",
    });
  });

  it.each([
    "https://dev.azure.com/Contoso",
    "https://dev.azure.com/Contoso/",
    "https://dev.azure.com/Contoso/Payments/_git/api",
    "https://contoso.visualstudio.com/",
    "https://contoso.visualstudio.com/DefaultCollection",
  ])("treats the cloud address %s as the cloud account for that organization", (baseUrl) => {
    expect(provider.buildAccount({ baseUrl, authMethod: "az" })).toMatchObject({
      id: "azure-devops:contoso",
      baseUrl: expect.stringMatching(/^https:\/\/dev\.azure\.com\/contoso$/i),
      apiVersion: "7.1",
    });
  });

  it("keeps a server address a separate account even when its collection is named like a cloud org", () => {
    const server = provider.buildAccount({
      baseUrl: "https://tfs.corp.local/tfs/Contoso",
      authMethod: "az",
    });
    expect(server.id).toBe("azure-devops:tfs.corp.local/tfs/contoso");
    expect(server.id).not.toBe("azure-devops:contoso");
  });

  it.each(["", "has space", "../etc", "a/b"])("rejects the organization %j", (org) => {
    expect(() => provider.buildAccount({ org, authMethod: "az" })).toThrow(/organization/i);
  });

  it("rejects non-http server URLs", () => {
    expect(() =>
      provider.buildAccount({ baseUrl: "file:///etc/passwd", authMethod: "pat" })
    ).toThrow();
    expect(() => provider.buildAccount({ baseUrl: "nonsense", authMethod: "pat" })).toThrow();
  });
});

describe("authentication", () => {
  it("sends a PAT as Basic auth and verifies the user", async () => {
    const { provider, account, secrets, calls } = setup([
      {
        match: "GET https://dev.azure.com/contoso/_apis/connectionData",
        body: {
          authenticatedUser: {
            providerDisplayName: "Suraj Chand",
            properties: { Account: { $value: "suraj@contoso.com" } },
          },
        },
      },
    ]);
    const user = await provider.verify(account, secrets);
    expect(user).toEqual({ name: "Suraj Chand", email: "suraj@contoso.com" });
    expect(calls[0].headers.authorization).toBe(
      `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`
    );
    expect(calls[0].url).toContain("api-version=7.1-preview");
  });

  it("uses an explicit token at login, before anything is stored", async () => {
    const { provider, account, calls } = setup([
      { match: "connectionData", body: { authenticatedUser: {} } },
    ]);
    await provider.verify(account, new MemorySecrets(), "fresh-token");
    expect(calls[0].headers.authorization).toBe(
      `Basic ${Buffer.from(":fresh-token").toString("base64")}`
    );
  });

  it("asks for a new login when a PAT account has no stored token", async () => {
    const { provider, account } = setup([]);
    await expect(provider.verify(account, new MemorySecrets())).rejects.toMatchObject({
      code: "auth",
      hint: expect.stringContaining("--pat-stdin"),
    });
  });

  it("uses an Azure CLI bearer token and caches it", async () => {
    let runs = 0;
    const { fetchImpl, calls } = fakeFetch([
      { match: "connectionData", body: { authenticatedUser: {} } },
    ]);
    const provider = createAzureDevOpsProvider({
      http: { fetchImpl },
      auth: {
        run: async () => {
          runs++;
          return {
            code: 0,
            stdout: JSON.stringify({ accessToken: "entra-token", expires_on: 4102444800 }),
            stderr: "",
          };
        },
      },
    });
    const account = azAccount("contoso", "az");
    await provider.verify(account, new MemorySecrets());
    await provider.verify(account, new MemorySecrets());
    expect(calls.every((c) => c.headers.authorization === "Bearer entra-token")).toBe(true);
    expect(runs).toBe(1);
  });

  it("deduplicates concurrent in-flight Azure CLI token requests", async () => {
    let runs = 0;
    const { fetchImpl } = fakeFetch([{ match: "connectionData", body: { authenticatedUser: {} } }]);
    const provider = createAzureDevOpsProvider({
      http: { fetchImpl },
      auth: {
        run: async () => {
          runs++;
          // Add a short delay to simulate slow CLI spawn
          await new Promise((r) => setTimeout(r, 20));
          return {
            code: 0,
            stdout: JSON.stringify({ accessToken: "concurrent-token", expires_on: 4102444800 }),
            stderr: "",
          };
        },
      },
    });
    const account = azAccount("contoso", "az");
    const results = await Promise.all([
      provider.verify(account, new MemorySecrets()),
      provider.verify(account, new MemorySecrets()),
      provider.verify(account, new MemorySecrets()),
    ]);
    expect(results).toHaveLength(3);
    expect(runs).toBe(1);
  });

  it("explains a signed-out Azure CLI", async () => {
    const provider = createAzureDevOpsProvider({
      auth: { run: async () => ({ code: 1, stdout: "", stderr: "Please run 'az login'" }) },
    });
    await expect(
      provider.verify(azAccount("contoso", "az"), new MemorySecrets())
    ).rejects.toMatchObject({
      code: "auth",
      hint: expect.stringContaining("az login"),
    });
  });
});

describe("work items", () => {
  it("searches with WIQL, pages with one extra row, and keeps the id order", async () => {
    const { provider, ctx, calls } = setup([
      {
        match: "POST https://dev.azure.com/contoso/My Project/_apis/wit/wiql",
        body: { workItems: [{ id: 3 }, { id: 1 }, { id: 2 }, { id: 9 }] },
      },
      {
        match: "workitemsbatch",
        body: {
          value: [1, 2, 3, 9].map((id) => ({
            id,
            fields: {
              "System.Title": `Item ${id}`,
              "System.WorkItemType": "Bug",
              "System.State": "Active",
            },
          })),
        },
      },
    ]);
    const page = await provider.workItems!.search(ctx, { text: "o'brien", limit: 3, offset: 0 });
    expect(page.items.map((i) => i.id)).toEqual([3, 1, 2]);
    expect(page).toMatchObject({ hasMore: true, nextOffset: 3 });
    const wiql = calls.find((c) => c.url.includes("/wiql"))!;
    expect(wiql.url).toContain("%24top=4");
    expect((wiql.body as { query: string }).query).toContain("CONTAINS 'o''brien'");
    expect(
      (calls.find((c) => c.url.includes("workitemsbatch"))!.body as { ids: number[] }).ids
    ).toEqual([3, 1, 2]);
  });

  it("refuses non-SELECT WIQL", async () => {
    const { provider, ctx } = setup([]);
    await expect(
      provider.workItems!.search(ctx, { wiql: "DELETE FROM WorkItems", limit: 5, offset: 0 })
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("accepts custom WIQL scoped with @project", async () => {
    const { provider, ctx } = setup([{ match: "/wiql", body: { workItems: [] } }]);
    const page = await provider.workItems!.search(ctx, {
      wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] = 'Active'",
      limit: 5,
      offset: 0,
    });
    expect(page).toEqual({ items: [], hasMore: false });
  });

  it("accepts custom WIQL scoped with matching literal project name", async () => {
    const { provider, ctx } = setup([{ match: "/wiql", body: { workItems: [] } }]);
    const page = await provider.workItems!.search(ctx, {
      wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'My Project' AND [System.State] = 'Active'",
      limit: 5,
      offset: 0,
    });
    expect(page).toEqual({ items: [], hasMore: false });
  });

  it("rejects custom WIQL without project scope", async () => {
    const { provider, ctx } = setup([]);
    await expect(
      provider.workItems!.search(ctx, {
        wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'",
        limit: 5,
        offset: 0,
      })
    ).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("must be scoped to the bound project"),
    });
  });

  it("rejects custom WIQL targeting a different project", async () => {
    const { provider, ctx } = setup([]);
    await expect(
      provider.workItems!.search(ctx, {
        wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'OtherSecretProject'",
        limit: 5,
        offset: 0,
      })
    ).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining('targets project "OtherSecretProject"'),
    });
  });

  it("rejects custom WIQL negating the project boundary", async () => {
    const { provider, ctx } = setup([]);
    await expect(
      provider.workItems!.search(ctx, {
        wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] <> @project",
        limit: 5,
        offset: 0,
      })
    ).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("cannot negate the project boundary"),
    });

    await expect(
      provider.workItems!.search(ctx, {
        wiql: "SELECT [System.Id] FROM WorkItems WHERE NOT ([System.TeamProject] = @project)",
        limit: 5,
        offset: 0,
      })
    ).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("cannot negate the project boundary"),
    });
  });

  it("rejects custom WIQL with top-level OR disjunctions that could bypass project scope", async () => {
    const { provider, ctx } = setup([]);
    await expect(
      provider.workItems!.search(ctx, {
        wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project OR [System.State] = 'Active'",
        limit: 5,
        offset: 0,
      })
    ).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("cannot use top-level OR clauses"),
    });
  });

  it("returns an empty page without calling the batch endpoint", async () => {
    const { provider, ctx, calls } = setup([{ match: "/wiql", body: { workItems: [] } }]);
    const page = await provider.workItems!.search(ctx, { limit: 5, offset: 0 });
    expect(page).toEqual({ items: [], hasMore: false });
    expect(calls.some((c) => c.url.includes("workitemsbatch"))).toBe(false);
  });

  it("gets a work item and degrades gracefully when comments are unavailable", async () => {
    const { provider, ctx } = setup([
      {
        match: "/wit/workitems/42",
        body: {
          id: 42,
          fields: {
            "System.TeamProject": "My Project",
            "System.Title": "Crash",
            "System.WorkItemType": "Bug",
            "System.State": "New",
            "System.Description": "<p>Boom</p>",
          },
          relations: [],
        },
      },
      { match: "/comments", status: 404, body: { message: "preview api missing" } },
    ]);
    const item = await provider.workItems!.get(ctx, 42);
    expect(item).toMatchObject({ id: 42, description: "Boom", comments: [] });
    expect(item.commentsError).toMatch(/Not found/);
  });

  it("reads comments newest first", async () => {
    const { provider, ctx, calls } = setup([
      {
        match: "/wit/workitems/7",
        body: {
          id: 7,
          fields: { "System.TeamProject": "My Project", "System.Title": "T" },
        },
      },
      {
        match: "/comments",
        body: {
          comments: [
            {
              createdBy: { displayName: "Ana" },
              createdDate: "2026-10-28",
              text: "<p>Looks <b>fixed</b></p>",
            },
          ],
        },
      },
    ]);
    const item = await provider.workItems!.get(ctx, 7);
    expect(item.comments).toEqual([{ author: "Ana", at: "2026-10-28", text: "Looks fixed" }]);
    expect(calls.find((c) => c.url.includes("/comments"))!.url).toContain(
      "api-version=7.1-preview.4"
    );
  });

  it("asks an Azure DevOps Server (api 7.0) for the 7.0 comments preview", async () => {
    const { provider, ctx, calls } = setup([
      {
        match: "/wit/workitems/7",
        body: { id: 7, fields: { "System.TeamProject": "My Project", "System.Title": "T" } },
      },
      { match: "/comments", body: { comments: [] } },
    ]);
    const server = { ...ctx.account, baseUrl: "https://tfs.corp.local/tfs/Col", apiVersion: "7.0" };
    await provider.workItems!.get({ ...ctx, account: server }, 7);
    expect(calls.find((c) => c.url.includes("/comments"))!.url).toContain(
      "api-version=7.0-preview.3"
    );
  });

  it("retrieves work item belonging to active project (case-insensitive)", async () => {
    const { provider, ctx } = setup([
      {
        match: "/wit/workitems/50",
        body: {
          id: 50,
          fields: {
            "System.TeamProject": "my project",
            "System.Title": "Bound Project Task",
            "System.WorkItemType": "Task",
            "System.State": "Active",
            "System.Description": "<p>Task details</p>",
          },
          relations: [],
        },
      },
      { match: "/comments", body: { comments: [] } },
    ]);
    const item = await provider.workItems!.get(ctx, 50);
    expect(item).toMatchObject({
      id: 50,
      title: "Bound Project Task",
      description: "Task details",
      comments: [],
    });
  });

  it("rejects work item belonging to another project with not_found and suppresses foreign comments and details", async () => {
    const { provider, ctx, calls } = setup([
      {
        match: "/wit/workitems/99",
        body: {
          id: 99,
          fields: {
            "System.TeamProject": "SecretOtherProject",
            "System.Title": "Highly Confidential Data",
            "System.WorkItemType": "Bug",
            "System.State": "Active",
            "System.Description": "Confidential foreign project content",
          },
          relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://secret/child" }],
        },
      },
      {
        match: "/comments",
        body: {
          comments: [{ text: "Secret foreign comment" }],
        },
      },
    ]);

    await expect(provider.workItems!.get(ctx, 99)).rejects.toMatchObject({
      code: "not_found",
      message: "Work item 99 was not found.",
    });

    // Verify comments were never fetched
    expect(calls.some((c) => c.url.includes("/comments"))).toBe(false);
  });

  it("fails closed when work item response is missing project identity", async () => {
    const { provider, ctx, calls } = setup([
      {
        match: "/wit/workitems/100",
        body: {
          id: 100,
          fields: {
            "System.Title": "Item without project field",
            "System.WorkItemType": "Task",
          },
        },
      },
    ]);

    await expect(provider.workItems!.get(ctx, 100)).rejects.toMatchObject({
      code: "not_found",
      message: "Work item 100 was not found.",
    });
    expect(calls.some((c) => c.url.includes("/comments"))).toBe(false);
  });

  it("fails closed when work item response contains malformed project information", async () => {
    const { provider, ctx, calls } = setup([
      {
        match: "/wit/workitems/101",
        body: {
          id: 101,
          fields: {
            "System.TeamProject": "   ",
            "System.Title": "Item with whitespace project field",
          },
        },
      },
    ]);

    await expect(provider.workItems!.get(ctx, 101)).rejects.toMatchObject({
      code: "not_found",
      message: "Work item 101 was not found.",
    });
    expect(calls.some((c) => c.url.includes("/comments"))).toBe(false);
  });
});

describe("sign-in hints", () => {
  it("point a server account without a token at --server-url, not --org", async () => {
    const { provider, ctx } = setup([]);
    const server = {
      ...ctx.account,
      id: "azure-devops:tfs.corp.local/tfs/col",
      org: "Col",
      baseUrl: "https://tfs.corp.local/tfs/Col",
      apiVersion: "7.0",
    };
    await expect(provider.workItems!.get({ ...ctx, account: server }, 7)).rejects.toMatchObject({
      code: "auth",
      hint: "Run `kai integration azure --server-url https://tfs.corp.local/tfs/Col --pat-stdin`.",
    });
  });
});

describe("pull requests", () => {
  const pr = {
    pullRequestId: 7,
    title: "Add login",
    status: "active",
    createdBy: { displayName: "Bo" },
    repository: { id: "repo-1", name: "api" },
    sourceRefName: "refs/heads/feature/login",
    targetRefName: "refs/heads/main",
    reviewers: [{ displayName: "Ana", vote: 10, isRequired: true }],
  };

  it("lists the project's PRs when no repository is bound, the repository's when one is", async () => {
    const { provider, ctx, calls } = setup([
      {
        match: "/git/",
        body: { value: [pr, { ...pr, pullRequestId: 8 }, { ...pr, pullRequestId: 9 }] },
      },
    ]);
    const page = await provider.pullRequests!.list(
      { ...ctx, binding: { ...ctx.binding, repo: null } },
      { limit: 2, offset: 0 }
    );
    expect(page.items.map((p) => p.id)).toEqual([7, 8]);
    expect(page).toMatchObject({ hasMore: true, nextOffset: 2 });
    expect(calls[0].url).toContain("/My%20Project/_apis/git/pullrequests?");
    expect(calls[0].url).toContain("searchCriteria.status=active");

    await provider.pullRequests!.list(ctx, { limit: 2, offset: 0 });
    expect(calls[1].url).toContain("/_apis/git/repositories/api/pullrequests?");
  });

  it("reads one PR with its latest iteration's files and human threads", async () => {
    const { provider, ctx, calls } = setup([
      {
        match: "/pullrequests/7/iterations/2/changes",
        body: {
          changeEntries: [
            { changeType: "edit", item: { path: "/src/a.ts" } },
            { changeType: "add", item: { path: "/src/b.ts" } },
          ],
        },
      },
      { match: "/pullrequests/7/iterations", body: { value: [{ id: 1 }, { id: 2 }] } },
      {
        match: "/pullrequests/7/threads",
        body: {
          value: [
            {
              id: 1,
              status: "active",
              comments: [{ content: "Please rename", author: { displayName: "Ana" } }],
            },
            { id: 2, comments: [{ commentType: "system", content: "joined" }] },
          ],
        },
      },
      { match: "/pullrequests/7", body: pr },
    ]);
    const detail = await provider.pullRequests!.get(ctx, 7);
    expect(detail).toMatchObject({
      id: 7,
      sourceBranch: "feature/login",
      targetBranch: "main",
      changedFiles: [
        { path: "src/a.ts", change: "edit" },
        { path: "src/b.ts", change: "add" },
      ],
      changedFilesTotal: 2,
      threadsTotal: 1,
      reviewers: [{ name: "Ana", vote: "approved", required: true }],
    });
    expect(detail.threads[0].comments[0].text).toBe("Please rename");
    expect(
      calls.some((c) => c.url.includes("/repositories/repo-1/pullrequests/7/iterations/2/changes"))
    ).toBe(true);
  });
});

describe("discovery", () => {
  it("lists every project across pages, sorted, with short descriptions", async () => {
    const page = (names: string[]) => ({
      value: names.map((name) => ({ name, description: name === "B" ? "Back end" : "" })),
    });
    const first = Array.from({ length: 100 }, (_, i) => `P${String(i).padStart(3, "0")}`);
    const { fetchImpl, calls } = fakeFetch([
      { match: "skip=100", body: page(["B"]) },
      { match: "skip=0", body: page(first) },
    ]);
    const provider = createAzureDevOpsProvider({
      http: { fetchImpl },
      auth: { env: {} },
    });
    const secrets = new MemorySecrets();
    secrets.data.set("kai/azure-devops/contoso", PAT);
    const projects = await provider.discovery!.listProjects(azAccount("contoso", "pat"), secrets);
    expect(projects).toHaveLength(101);
    expect(projects[0].name).toBe("B");
    expect(projects[0].description).toBe("Back end");
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("%24top=100");
  });

  it("stops after one page when the first page is short", async () => {
    const { provider, account, secrets, calls } = setup([
      { match: "/_apis/projects", body: { value: [{ name: "Only" }] } },
    ]);
    expect(await provider.discovery!.listProjects(account, secrets)).toEqual([{ name: "Only" }]);
    expect(calls).toHaveLength(1);
  });

  it("lists repositories, skipping disabled ones and trimming the default branch", async () => {
    const { provider, account, secrets, calls } = setup([
      {
        match: "/git/repositories",
        body: {
          value: [
            { name: "web", defaultBranch: "refs/heads/main" },
            { name: "api" },
            { name: "old", isDisabled: true },
          ],
        },
      },
    ]);
    const repos = await provider.discovery!.listRepos(account, secrets, "My Project");
    expect(repos).toEqual([{ name: "api" }, { name: "web", defaultBranch: "main" }]);
    expect(calls[0].url).toContain("/My%20Project/_apis/git/repositories");
  });

  it("reports an unreachable project as not found", async () => {
    const { provider, account, secrets } = setup([
      { match: "/git/repositories", status: 404, body: { message: "gone" } },
    ]);
    await expect(provider.discovery!.listRepos(account, secrets, "Nope")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("builds", () => {
  const build = {
    id: 9,
    buildNumber: "1.2",
    status: "completed",
    result: "failed",
    sourceBranch: "refs/heads/main",
  };

  it("filters by branch (adding refs/heads/) and result", async () => {
    const { provider, ctx, calls } = setup([{ match: "/build/builds", body: { value: [build] } }]);
    const page = await provider.builds!.list(ctx, {
      branch: "main",
      result: "failed",
      limit: 5,
      offset: 0,
    });
    expect(page.items[0]).toMatchObject({ id: 9, result: "failed" });
    expect(calls[0].url).toContain("branchName=refs%2Fheads%2Fmain");
    expect(calls[0].url).toContain("resultFilter=failed");
  });

  it("without a logId returns failed steps and the log list", async () => {
    const { provider, ctx } = setup([
      {
        match: "/builds/9/timeline",
        body: {
          records: [
            {
              type: "Task",
              name: "npm test",
              result: "failed",
              log: { id: 12 },
              issues: [{ type: "error", message: "2 failed" }],
            },
          ],
        },
      },
      { match: "/builds/9/logs", body: { value: [{ id: 12, lineCount: 500, type: "Container" }] } },
      { match: "/builds/9", body: build },
    ]);
    const result = await provider.builds!.log(ctx, 9, {});
    expect(result.failures).toEqual([{ step: "npm test", logId: 12, issues: ["2 failed"] }]);
    expect(result.logs).toEqual([{ id: 12, lineCount: 500, type: "Container" }]);
  });

  it("with a logId reads the last 150 lines by default", async () => {
    const { provider, ctx, calls } = setup([
      { match: "/builds/9/logs/12", text: "line\n".repeat(150) },
      { match: "/builds/9/logs", body: { value: [{ id: 12, lineCount: 500 }] } },
      { match: "/builds/9", body: build },
    ]);
    const result = await provider.builds!.log(ctx, 9, { logId: 12 });
    expect(result.log).toMatchObject({ id: 12, startLine: 351, endLine: 500, lineCount: 500 });
    expect(calls.find((c) => c.url.includes("/logs/12"))!.url).toContain(
      "startLine=351&endLine=500"
    );
  });

  it("caps an explicit window at 400 lines", async () => {
    const { provider, ctx } = setup([
      { match: "/builds/9/logs/12", text: "x" },
      { match: "/builds/9/logs", body: { value: [{ id: 12, lineCount: 5000 }] } },
      { match: "/builds/9", body: build },
    ]);
    const result = await provider.builds!.log(ctx, 9, { logId: 12, startLine: 1, endLine: 5000 });
    expect(result.log!.endLine - result.log!.startLine + 1).toBe(400);
  });
});
