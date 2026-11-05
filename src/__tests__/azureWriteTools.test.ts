import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_TOOLS, handleMcpMessage } from "../core/mcp";
import { findBinding, saveAccount } from "../core/integrations/config";
import {
  commentHtml,
  createAzureDevOpsProvider,
} from "../core/integrations/providers/azure-devops";
import { resetAzTokenCache } from "../core/integrations/providers/azure-devops/auth";
import { setProviderForTests } from "../core/integrations/providers";
import { resetDefaultSecretStore } from "../core/integrations/secretStore";
import { bind, getStatus, handleRpc, setRules, setWriteTools } from "../core/integrations/service";
import type { ProviderContext } from "../core/integrations/types";
import { callTool } from "./helpers/mcpCall";
import {
  MemorySecrets,
  azAccount,
  fakeFetch,
  makeRepo,
  useTempKaiHome,
  type FakeRoute,
} from "./helpers/integrationsEnv";

const REMOTE = "https://dev.azure.com/Contoso/Payments/_git/api";
const WRITE_TOOLS = [
  "kai_work_item_comment",
  "kai_work_item_set_state",
  "kai_work_item_create",
  "kai_work_item_update",
  "kai_pr_create",
  "kai_pr_comment",
];
const personGuard = async () => {};
const agentGuard = async () => {
  throw new Error("an agent is running this");
};

const azRunner = async () => ({
  code: 0,
  stdout: JSON.stringify({ accessToken: "entra-token", expires_on: 4102444800 }),
  stderr: "",
});

const WORK_ITEM = {
  id: 7,
  rev: 4,
  fields: { "System.TeamProject": "Payments", "System.State": "Active" },
};
const PR = {
  pullRequestId: 12,
  title: "Add login",
  status: "active",
  repository: { id: "repo-1", name: "api", project: { name: "Payments" } },
  sourceRefName: "refs/heads/feature/login",
  targetRefName: "refs/heads/main",
};

const WRITE_ROUTES: FakeRoute[] = [
  { match: "GET https://dev.azure.com/Contoso/Payments/_apis/wit/workitems/7?", body: WORK_ITEM },
  {
    match: "GET https://dev.azure.com/Contoso/Payments/_apis/wit/workitems/9?",
    body: { id: 9, fields: { "System.TeamProject": "Other", "System.State": "New" } },
  },
  {
    match: "POST https://dev.azure.com/Contoso/Payments/_apis/wit/workItems/7/comments",
    body: { id: 99 },
  },
  {
    match: "PATCH https://dev.azure.com/Contoso/Payments/_apis/wit/workitems/7",
    body: {
      id: 7,
      fields: { "System.State": "Resolved", "System.WorkItemType": "Task", "System.Title": "New" },
    },
  },
  {
    match:
      "GET https://dev.azure.com/Contoso/_apis/identities?searchFilter=General&filterValue=ann@contoso.com",
    body: { value: [{ id: "guid-ann", providerDisplayName: "Ann Lee" }] },
  },
  {
    match:
      "GET https://dev.azure.com/Contoso/_apis/identities?searchFilter=General&filterValue=bob@contoso.com",
    body: { value: [{ id: "guid-bob", providerDisplayName: "Bob Ray" }] },
  },
  {
    match:
      "GET https://dev.azure.com/Contoso/_apis/identities?searchFilter=General&filterValue=Sam",
    body: {
      value: [
        { id: "guid-s1", providerDisplayName: "Sam A" },
        { id: "guid-s2", providerDisplayName: "Sam B" },
      ],
    },
  },
  {
    match:
      "GET https://dev.azure.com/Contoso/_apis/identities?searchFilter=General&filterValue=nobody",
    body: { value: [] },
  },
  {
    match: "POST https://dev.azure.com/Contoso/Payments/_apis/wit/workitems/$Task",
    body: {
      id: 21,
      fields: {
        "System.WorkItemType": "Task",
        "System.Title": "Add retry",
        "System.State": "To Do",
      },
    },
  },
  {
    // The branches that exist. The provider asks for one name and picks the exact match.
    match: "GET https://dev.azure.com/Contoso/Payments/_apis/git/repositories/api/refs?",
    body: {
      value: ["main", "trunk", "feature/login", "feature/x", "release/1.0"].map((name) => ({
        name: `refs/heads/${name}`,
      })),
    },
  },
  {
    match: "POST https://dev.azure.com/Contoso/Payments/_apis/git/repositories/api/pullrequests?",
    body: PR,
  },
  { match: "GET https://dev.azure.com/Contoso/Payments/_apis/git/pullrequests/12", body: PR },
  {
    match: "GET https://dev.azure.com/Contoso/Payments/_apis/git/pullrequests/13",
    body: {
      ...PR,
      pullRequestId: 13,
      repository: { id: "r2", name: "x", project: { name: "Other" } },
    },
  },
  {
    match: "GET https://dev.azure.com/Contoso/Payments/_apis/git/pullrequests/14",
    body: { ...PR, pullRequestId: 14, repository: { id: "r3", name: "y" } },
  },
  {
    match:
      "POST https://dev.azure.com/Contoso/Payments/_apis/git/repositories/repo-1/pullrequests/12/threads/5/comments",
    body: { id: 2 },
  },
  {
    match:
      "POST https://dev.azure.com/Contoso/Payments/_apis/git/repositories/repo-1/pullrequests/12/threads",
    body: { id: 5 },
  },
];

beforeEach(() => resetAzTokenCache());

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

function providerSetup(routes: FakeRoute[] = WRITE_ROUTES, method: "az" | "pat" = "az") {
  const { fetchImpl, calls } = fakeFetch(routes);
  const secrets = new MemorySecrets();
  const account = azAccount("Contoso", method);
  if (method === "pat") secrets.data.set("kai/azure-devops/contoso", "pat-secret-123");
  const provider = createAzureDevOpsProvider({
    http: { fetchImpl, sleep: async () => {} },
    auth: { env: {}, run: azRunner },
  });
  const ctx: ProviderContext = {
    account,
    secrets,
    binding: {
      provider: "azure-devops",
      account: account.id,
      project: "Payments",
      repo: "api",
      boundAt: "2026-11-01T00:00:00.000Z",
    },
  };
  return { provider, ctx, calls };
}

describe("azure write methods", () => {
  it("adds a work item comment after checking the item is in the project, escaping markup", async () => {
    const { provider, ctx, calls } = providerSetup();
    const done = await provider.workItems!.addComment!(ctx, 7, "Fixed <b>it</b> & done\nLine 2");
    expect(done).toEqual({
      workItemId: 7,
      commentId: 99,
      url: "https://dev.azure.com/Contoso/Payments/_workitems/edit/7",
    });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(calls[1].url).toContain(
      "/Payments/_apis/wit/workItems/7/comments?api-version=7.1-preview.4"
    );
    expect(calls[1].body).toEqual({ text: "Fixed &lt;b&gt;it&lt;/b&gt; &amp; done<br>Line 2" });
  });

  it("escapes comment html the same way on its own", () => {
    expect(commentHtml("<script>alert(1)</script>\r\nx")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;<br>x"
    );
  });

  it("uses the 7.0 comments preview on a server", async () => {
    const server = {
      ...azAccount("Contoso", "az"),
      baseUrl: "https://tfs.corp/tfs/Col",
      apiVersion: "7.0",
    };
    const routes: FakeRoute[] = [
      { match: "GET https://tfs.corp/tfs/Col/Payments/_apis/wit/workitems/7?", body: WORK_ITEM },
      {
        match: "POST https://tfs.corp/tfs/Col/Payments/_apis/wit/workItems/7/comments",
        body: { id: 1 },
      },
    ];
    const s = providerSetup(routes);
    await s.provider.workItems!.addComment!({ ...s.ctx, account: server }, 7, "hi");
    expect(s.calls[1].url).toContain("api-version=7.0-preview.3");
  });

  it("fails closed on a work item from another project, before writing anything", async () => {
    const { provider, ctx, calls } = providerSetup();
    await expect(provider.workItems!.addComment!(ctx, 9, "hi")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(provider.workItems!.setState!(ctx, 9, "Closed")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("fails closed when the work item has no project field", async () => {
    const { provider, ctx, calls } = providerSetup([
      {
        match: "GET https://dev.azure.com/Contoso/Payments/_apis/wit/workitems/7?",
        body: { id: 7 },
      },
    ]);
    await expect(provider.workItems!.setState!(ctx, 7, "Closed")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(calls).toHaveLength(1);
  });

  it("changes a state with a JSON patch that tests the revision it read", async () => {
    const { provider, ctx, calls } = providerSetup();
    const done = await provider.workItems!.setState!(ctx, 7, "Resolved");
    expect(done).toMatchObject({ workItemId: 7, previousState: "Active", state: "Resolved" });
    const patch = calls[1];
    expect(patch.method).toBe("PATCH");
    expect(patch.headers["content-type"]).toBe("application/json-patch+json");
    expect(patch.body).toEqual([
      { op: "test", path: "/rev", value: 4 },
      { op: "add", path: "/fields/System.State", value: "Resolved" },
    ]);
  });

  it("opens a pull request between two refs and creates no branch", async () => {
    const { provider, ctx, calls } = providerSetup();
    const pr = await provider.pullRequests!.create!(ctx, {
      sourceBranch: "feature/login",
      targetBranch: "main",
      title: "Add login",
      description: "Why",
      isDraft: true,
    });
    expect(pr).toMatchObject({ id: 12, sourceBranch: "feature/login", targetBranch: "main" });
    // Each branch is looked up by its own name (never listed), then the pull request is opened.
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
    expect(calls[0].url).toContain("filter=heads%2Ffeature%2Flogin");
    expect(calls[1].url).toContain("filter=heads%2Fmain");
    const post = calls[2];
    expect(post.url).toContain("/Payments/_apis/git/repositories/api/pullrequests?");
    expect(post.body).toEqual({
      sourceRefName: "refs/heads/feature/login",
      targetRefName: "refs/heads/main",
      title: "Add login",
      description: "Why",
      isDraft: true,
    });
    // The refs endpoint is only ever read: no branch is created.
    expect(calls.filter((c) => c.url.includes("/refs")).every((c) => c.method === "GET")).toBe(
      true
    );
  });

  it("refuses a source branch that does not exist, by name, and opens nothing", async () => {
    const { provider, ctx, calls } = providerSetup();
    await expect(
      provider.pullRequests!.create!(ctx, {
        sourceBranch: "feature/typo",
        targetBranch: "main",
        title: "Add login",
      })
    ).rejects.toMatchObject({
      code: "not_found",
      message: 'The source branch "feature/typo" does not exist in api.',
      hint: expect.stringContaining("Push the branch"),
    });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("refuses a target branch that does not exist, by name, and opens nothing", async () => {
    const { provider, ctx, calls } = providerSetup();
    await expect(
      provider.pullRequests!.create!(ctx, {
        sourceBranch: "feature/login",
        targetBranch: "develop",
        title: "Add login",
      })
    ).rejects.toMatchObject({
      code: "not_found",
      message: 'The target branch "develop" does not exist in api.',
    });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("checks a single branch by its exact name, not by prefix", async () => {
    const { provider, ctx } = providerSetup();
    const exists = (branch: string) =>
      provider.discovery!.branchExists(ctx.account, ctx.secrets, "Payments", "api", branch);
    expect(await exists("main")).toBe(true);
    expect(await exists("feature/login")).toBe(true);
    expect(await exists("feature")).toBe(false); // a prefix of one is not a branch
    expect(await exists("Main")).toBe(false); // names are case-sensitive
  });

  it("needs a bound repository to open a pull request", async () => {
    const { provider, ctx, calls } = providerSetup();
    await expect(
      provider.pullRequests!.create!(
        { ...ctx, binding: { ...ctx.binding, repo: null } },
        { sourceBranch: "a", targetBranch: "b", title: "t" }
      )
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(calls).toHaveLength(0);
  });

  it("creates a task with escaped description, a joined tag list and a parent link", async () => {
    const { provider, ctx, calls } = providerSetup();
    const made = await provider.workItems!.create!(ctx, {
      type: "Task",
      title: "Add retry",
      description: "Use <b>backoff</b>\nthen stop",
      assignedTo: "dev@contoso.com",
      parentId: 7,
      tags: ["api", "retry"],
      priority: 2,
      remainingWork: 3,
      iterationPath: "Payments\\Sprint 4",
    });
    expect(made).toEqual({
      workItemId: 21,
      type: "Task",
      title: "Add retry",
      state: "To Do",
      fields: [
        "System.Title",
        "System.Description",
        "System.AssignedTo",
        "System.Tags",
        "System.IterationPath",
        "Microsoft.VSTS.Common.Priority",
        "Microsoft.VSTS.Scheduling.RemainingWork",
        "parent",
      ],
      url: "https://dev.azure.com/Contoso/Payments/_workitems/edit/21",
    });
    // The parent is read first (project check), then the item is created.
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    const post = calls[1];
    expect(post.url).toContain("/Payments/_apis/wit/workitems/$Task?");
    expect(post.headers["content-type"]).toBe("application/json-patch+json");
    expect(post.body).toEqual([
      { op: "add", path: "/fields/System.Title", value: "Add retry" },
      {
        op: "add",
        path: "/fields/System.Description",
        value: "Use &lt;b&gt;backoff&lt;/b&gt;<br>then stop",
      },
      { op: "add", path: "/fields/System.AssignedTo", value: "dev@contoso.com" },
      { op: "add", path: "/fields/System.Tags", value: "api; retry" },
      { op: "add", path: "/fields/System.IterationPath", value: "Payments\\Sprint 4" },
      { op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: 2 },
      { op: "add", path: "/fields/Microsoft.VSTS.Scheduling.RemainingWork", value: 3 },
      {
        op: "add",
        path: "/relations/-",
        value: {
          rel: "System.LinkTypes.Hierarchy-Reverse",
          url: "https://dev.azure.com/Contoso/_apis/wit/workItems/7",
        },
      },
    ]);
  });

  it("does not create anything when the parent is in another project", async () => {
    const { provider, ctx, calls } = providerSetup();
    await expect(
      provider.workItems!.create!(ctx, { type: "Task", title: "x", parentId: 9 })
    ).rejects.toMatchObject({ code: "not_found" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("updates only the fields given, with a patch that tests the revision it read", async () => {
    const { provider, ctx, calls } = providerSetup();
    const done = await provider.workItems!.update!(ctx, {
      id: 7,
      title: "New",
      remainingWork: 0,
      completedWork: 5,
    });
    expect(done).toMatchObject({
      workItemId: 7,
      type: "Task",
      title: "New",
      fields: [
        "System.Title",
        "Microsoft.VSTS.Scheduling.RemainingWork",
        "Microsoft.VSTS.Scheduling.CompletedWork",
      ],
    });
    expect(calls[1].method).toBe("PATCH");
    expect(calls[1].body).toEqual([
      { op: "test", path: "/rev", value: 4 },
      { op: "add", path: "/fields/System.Title", value: "New" },
      { op: "add", path: "/fields/Microsoft.VSTS.Scheduling.RemainingWork", value: 0 },
      { op: "add", path: "/fields/Microsoft.VSTS.Scheduling.CompletedWork", value: 5 },
    ]);
  });

  it("fails closed when updating a work item of another project", async () => {
    const { provider, ctx, calls } = providerSetup();
    await expect(provider.workItems!.update!(ctx, { id: 9, title: "x" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("links work items when opening a pull request, after checking each is in the project", async () => {
    const { provider, ctx, calls } = providerSetup();
    await provider.pullRequests!.create!(ctx, {
      sourceBranch: "feature/login",
      targetBranch: "main",
      title: "Add login",
      workItemIds: [7],
    });
    // The work item, then the two branches, then the pull request.
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "POST"]);
    expect((calls[3].body as { workItemRefs: unknown }).workItemRefs).toEqual([{ id: "7" }]);

    const other = providerSetup();
    await expect(
      other.provider.pullRequests!.create!(other.ctx, {
        sourceBranch: "a",
        targetBranch: "b",
        title: "t",
        workItemIds: [7, 9],
      })
    ).rejects.toMatchObject({ code: "not_found" });
    expect(other.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("asks for reviews and labels when opening a pull request", async () => {
    const { provider, ctx, calls } = providerSetup();
    await provider.pullRequests!.create!(ctx, {
      sourceBranch: "feature/login",
      targetBranch: "main",
      title: "Add login",
      reviewers: ["ann@contoso.com"],
      requiredReviewers: ["bob@contoso.com", "ann@contoso.com"],
      labels: ["backend"],
    });
    // Two branch checks, two reviewer lookups, then the pull request.
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "GET", "POST"]);
    const body = calls[4].body as { reviewers: unknown; labels: unknown };
    // Ann is asked once, and required because she is also listed as required.
    expect(body.reviewers).toEqual([
      { id: "guid-ann", isRequired: true },
      { id: "guid-bob", isRequired: true },
    ]);
    expect(body.labels).toEqual([{ name: "backend" }]);
  });

  it("opens no pull request when a reviewer matches nobody or several people", async () => {
    for (const who of ["nobody", "Sam"]) {
      const { provider, ctx, calls } = providerSetup();
      await expect(
        provider.pullRequests!.create!(ctx, {
          sourceBranch: "feature/login",
          targetBranch: "main",
          title: "t",
          reviewers: [who],
        })
      ).rejects.toMatchObject({ code: who === "nobody" ? "not_found" : "bad_request" });
      expect(calls.some((c) => c.method === "POST")).toBe(false);
    }
  });

  it("starts a pull request thread, optionally on a file line", async () => {
    const { provider, ctx, calls } = providerSetup();
    const plain = await provider.pullRequests!.addComment!(ctx, { id: 12, text: "LGTM" });
    expect(plain).toMatchObject({ pullRequestId: 12, threadId: 5 });
    expect(plain.url).toBe("https://dev.azure.com/Contoso/Payments/_git/api/pullrequest/12");
    expect(calls[1].url).toContain("/repositories/repo-1/pullrequests/12/threads?");
    expect(calls[1].body).toEqual({
      comments: [{ parentCommentId: 0, content: "LGTM", commentType: 1 }],
      status: 1,
    });

    await provider.pullRequests!.addComment!(ctx, {
      id: 12,
      text: "rename",
      filePath: "/src/a.ts",
      line: 8,
    });
    expect((calls[3].body as { threadContext: unknown }).threadContext).toEqual({
      filePath: "/src/a.ts",
      rightFileStart: { line: 8, offset: 1 },
      rightFileEnd: { line: 8, offset: 1 },
    });
  });

  it("replies to an existing thread", async () => {
    const { provider, ctx, calls } = providerSetup();
    const done = await provider.pullRequests!.addComment!(ctx, {
      id: 12,
      text: "done",
      threadId: 5,
    });
    expect(done).toMatchObject({ pullRequestId: 12, threadId: 5, commentId: 2 });
    expect(calls[1].url).toContain("/pullrequests/12/threads/5/comments?");
    expect(calls[1].body).toEqual({ content: "done", parentCommentId: 1, commentType: 1 });
  });

  it("fails closed on a pull request of another project or with no project identity", async () => {
    const { provider, ctx, calls } = providerSetup();
    await expect(
      provider.pullRequests!.addComment!(ctx, { id: 13, text: "x" })
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      provider.pullRequests!.addComment!(ctx, { id: 14, text: "x" })
    ).rejects.toMatchObject({
      code: "not_found",
    });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("tells a token account which scopes writing needs, and never echoes the token", async () => {
    const { provider, ctx } = providerSetup(
      [
        { match: "GET ", body: WORK_ITEM },
        { match: "POST ", status: 403, body: { message: "denied for pat-secret-123" } },
      ],
      "pat"
    );
    const err = await provider.workItems!.addComment!(ctx, 7, "hi").catch((e) => e);
    expect(err).toMatchObject({ code: "forbidden" });
    expect(err.hint).toContain("Work Items (Read & write) and Code (Read & write)");
    expect(JSON.stringify([err.message, err.hint])).not.toContain("pat-secret-123");
  });

  it("says a signed-in account may lack permission when the server refuses a write", async () => {
    const { provider, ctx } = providerSetup([
      { match: "GET ", body: WORK_ITEM },
      { match: "PATCH ", status: 403, body: { message: "no" } },
    ]);
    const err = await provider.workItems!.setState!(ctx, 7, "Closed").catch((e) => e);
    expect(err.hint).toContain("may not be allowed");
  });
});

// ---------------------------------------------------------------------------
// service: the switch
// ---------------------------------------------------------------------------

let env: ReturnType<typeof useTempKaiHome>;
let repoDir: string;
let cleanupRepo: () => void;
let calls: ReturnType<typeof fakeFetch>["calls"];
const savedMarker = process.env.KAI_AGENT_SESSION;

function useFakeAzure(routes: FakeRoute[] = WRITE_ROUTES) {
  const fake = fakeFetch(routes);
  calls = fake.calls;
  setProviderForTests(
    "azure-devops",
    createAzureDevOpsProvider({
      http: { fetchImpl: fake.fetchImpl, sleep: async () => {} },
      auth: { env: {}, run: azRunner },
    })
  );
}

async function listTools(root: string): Promise<string[]> {
  const res = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, root);
  return (res!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
}

beforeEach(() => {
  env = useTempKaiHome();
  resetDefaultSecretStore();
  const repo = makeRepo(REMOTE);
  repoDir = repo.dir;
  cleanupRepo = repo.cleanup;
  saveAccount(azAccount("Contoso", "az"));
  bind("azure-devops", repoDir);
  useFakeAzure();
  delete process.env.KAI_AGENT_SESSION;
});

afterEach(() => {
  setProviderForTests("azure-devops", null);
  if (savedMarker === undefined) delete process.env.KAI_AGENT_SESSION;
  else process.env.KAI_AGENT_SESSION = savedMarker;
  cleanupRepo();
  env.restore();
});

describe("write tools switch", () => {
  it("is off by default: no write tool is listed", async () => {
    const names = await listTools(repoDir);
    for (const t of WRITE_TOOLS) expect(names).not.toContain(t);
    expect(findBinding(repoDir)!.binding.writeTools).toBeUndefined();
    const status = await getStatus("azure-devops", repoDir);
    expect(status.project.binding?.writeTools).toBe(false);
  });

  it("lists the write tools only after it is turned on, and removes them when turned off", async () => {
    await setWriteTools("azure-devops", repoDir, true, { agentGuard: personGuard });
    expect(findBinding(repoDir)!.binding.writeTools).toBe(true);
    const on = await listTools(repoDir);
    expect(on).toEqual([
      ...MCP_TOOLS.map((t) => t.name),
      "kai_integration_status",
      "kai_workflow_rules",
      "kai_work_item_search",
      "kai_work_item_get",
      "kai_pr_list",
      "kai_pr_get",
      "kai_build_list",
      "kai_build_log",
      ...WRITE_TOOLS,
    ]);
    await setWriteTools("azure-devops", repoDir, false);
    const off = await listTools(repoDir);
    for (const t of WRITE_TOOLS) expect(off).not.toContain(t);
    expect(findBinding(repoDir)!.binding.writeTools).toBeUndefined();
  });

  it("every write tool says it changes remote data", async () => {
    await setWriteTools("azure-devops", repoDir, true, { agentGuard: personGuard });
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, repoDir);
    const tools = (res!.result as { tools: Array<{ name: string; description: string }> }).tools;
    for (const name of WRITE_TOOLS) {
      expect(tools.find((t) => t.name === name)!.description).toMatch(
        /^WRITES to the remote service/
      );
    }
  });

  it("is refused inside an AI agent's session, and nothing is stored", async () => {
    await expect(setWriteTools("azure-devops", repoDir, true, { agentGuard })).rejects.toThrow(
      "an agent is running this"
    );
    expect(findBinding(repoDir)!.binding.writeTools).toBeUndefined();
  });

  it("uses the real agent check by default: Kai's own session marker is enough to refuse", async () => {
    process.env.KAI_AGENT_SESSION = "1";
    await expect(setWriteTools("azure-devops", repoDir, true)).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining(
        "Turning on write tools is not available inside an AI agent's session"
      ),
    });
    expect(findBinding(repoDir)!.binding.writeTools).toBeUndefined();
  });

  it("turning it off always works, even from an agent session", async () => {
    await setWriteTools("azure-devops", repoDir, true, { agentGuard: personGuard });
    process.env.KAI_AGENT_SESSION = "1";
    await setWriteTools("azure-devops", repoDir, false);
    expect(findBinding(repoDir)!.binding.writeTools).toBeUndefined();
  });

  it("needs a connected project", async () => {
    const other = makeRepo();
    try {
      await expect(
        setWriteTools("azure-devops", other.dir, true, { agentGuard: personGuard })
      ).rejects.toMatchObject({ code: "no_account" });
    } finally {
      other.cleanup();
    }
  });

  it("is a desktop RPC op that validates its input", async () => {
    const on = await handleRpc(
      "azure-devops",
      { op: "set_write_tools", projectDir: repoDir, enabled: true },
      { agentGuard: personGuard }
    );
    expect(on).toMatchObject({ ok: true, binding: { writeTools: true } });
    const off = await handleRpc("azure-devops", {
      op: "set_write_tools",
      projectDir: repoDir,
      enabled: false,
    });
    expect(off).toMatchObject({ ok: true, binding: { writeTools: false } });
    await expect(
      handleRpc("azure-devops", {
        op: "set_write_tools",
        projectDir: repoDir,
        enabled: "yes" as unknown as boolean,
      })
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("survives rules changes and re-connecting the same project, but not another project", async () => {
    await setWriteTools("azure-devops", repoDir, true, { agentGuard: personGuard });
    await setRules("azure-devops", repoDir, { branchPattern: "^feature/[a-z]+$" });
    expect(findBinding(repoDir)!.binding.writeTools).toBe(true);
    bind("azure-devops", repoDir, { repo: null });
    expect(findBinding(repoDir)!.binding.writeTools).toBe(true);
    bind("azure-devops", repoDir, { project: "Platform" });
    expect(findBinding(repoDir)!.binding.writeTools).toBeUndefined();
  });

  it("ignores a hand-edited value that is not exactly true", async () => {
    const projects = path.join(env.home, "projects");
    for (const id of fs.readdirSync(projects)) {
      const file = path.join(projects, id, "integration.json");
      if (!fs.existsSync(file)) continue;
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...v, writeTools: "true" }));
    }
    expect(findBinding(repoDir)!.binding.writeTools).toBeUndefined();
    expect(await listTools(repoDir)).not.toContain("kai_pr_create");
  });
});

// ---------------------------------------------------------------------------
// MCP: the tools
// ---------------------------------------------------------------------------

describe("write tools over MCP", () => {
  it("refuses a call when write tools are off, even if the agent still knows the name", async () => {
    for (const name of WRITE_TOOLS) {
      const res = await callTool(repoDir, name, {
        id: 7,
        text: "x",
        state: "Closed",
        sourceBranch: "a",
        title: "t",
      });
      expect(res.error?.message).toContain("write tools are off for this project");
      expect(res.error?.message).toContain("Only the user can turn them on");
    }
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("re-checks at call time: turning writes off stops a tool list the agent cached", async () => {
    await setWriteTools("azure-devops", repoDir, true, { agentGuard: personGuard });
    expect(
      (await callTool(repoDir, "kai_work_item_comment", { id: 7, text: "hi" })).error
    ).toBeUndefined();
    await setWriteTools("azure-devops", repoDir, false);
    const res = await callTool(repoDir, "kai_work_item_comment", { id: 7, text: "hi again" });
    expect(res.error?.message).toContain("write tools are off");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  describe("with writes on", () => {
    beforeEach(async () => {
      await setWriteTools("azure-devops", repoDir, true, { agentGuard: personGuard });
    });

    it("adds a work item comment", async () => {
      const res = await callTool(repoDir, "kai_work_item_comment", {
        id: 7,
        text: "Done in PR 12",
      });
      expect(res.json).toMatchObject({ ok: true, workItemId: 7, commentId: 99 });
      expect(res.json!.changed).toContain("comment");
    });

    it("changes a work item state", async () => {
      const res = await callTool(repoDir, "kai_work_item_set_state", { id: 7, state: "Resolved" });
      expect(res.json).toMatchObject({ ok: true, previousState: "Active", state: "Resolved" });
    });

    it("answers a work item from another project with not_found and writes nothing", async () => {
      const res = await callTool(repoDir, "kai_work_item_comment", { id: 9, text: "leak" });
      expect(res.error?.message).toContain("not found");
      expect(calls.filter((c) => c.method === "POST" || c.method === "PATCH")).toHaveLength(0);
    });

    it("opens a pull request into the explicit target", async () => {
      const res = await callTool(repoDir, "kai_pr_create", {
        sourceBranch: "refs/heads/feature/login",
        targetBranch: "main",
        title: "Add login",
        description: "Because",
      });
      expect(res.json).toMatchObject({ ok: true, pullRequest: { id: 12 } });
      const post = calls.find((c) => c.method === "POST")!;
      expect(post.body).toMatchObject({
        sourceRefName: "refs/heads/feature/login",
        targetRefName: "refs/heads/main",
      });
    });

    it("targets the merge branch rule when no target is given", async () => {
      await setRules("azure-devops", repoDir, { mergeBranch: "release/1.0" });
      await callTool(repoDir, "kai_pr_create", { sourceBranch: "feature/x", title: "T" });
      const post = calls.find((c) => c.method === "POST")!;
      expect((post.body as { targetRefName: string }).targetRefName).toBe("refs/heads/release/1.0");
    });

    it("falls back to the repository's default branch, and asks for a target when there is none", async () => {
      useFakeAzure([
        ...WRITE_ROUTES,
        {
          match: "GET https://dev.azure.com/Contoso/Payments/_apis/git/repositories?",
          body: { value: [{ name: "api", defaultBranch: "refs/heads/trunk" }] },
        },
      ]);
      await callTool(repoDir, "kai_pr_create", { sourceBranch: "feature/x", title: "T" });
      const post = calls.find((c) => c.method === "POST")!;
      expect((post.body as { targetRefName: string }).targetRefName).toBe("refs/heads/trunk");

      useFakeAzure([
        ...WRITE_ROUTES,
        {
          match: "GET https://dev.azure.com/Contoso/Payments/_apis/git/repositories?",
          body: { value: [{ name: "api" }] },
        },
      ]);
      const none = await callTool(repoDir, "kai_pr_create", {
        sourceBranch: "feature/x",
        title: "T",
      });
      expect(none.error?.message).toContain("targetBranch is required");
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    });

    it("comments on a pull request, as a thread and as a reply", async () => {
      const thread = await callTool(repoDir, "kai_pr_comment", { id: 12, text: "Looks good" });
      expect(thread.json).toMatchObject({ ok: true, pullRequestId: 12, threadId: 5 });
      const reply = await callTool(repoDir, "kai_pr_comment", { id: 12, text: "ok", threadId: 5 });
      expect(reply.json).toMatchObject({ ok: true, commentId: 2 });
      const onLine = await callTool(repoDir, "kai_pr_comment", {
        id: 12,
        text: "rename",
        filePath: "src\\a.ts",
        line: 3,
      });
      expect(onLine.error).toBeUndefined();
      const posts = calls.filter((c) => c.method === "POST");
      const lastPost = posts[posts.length - 1];
      expect(
        (lastPost.body as { threadContext: { filePath: string } }).threadContext.filePath
      ).toBe("/src/a.ts");
    });

    it("creates a task, defaulting the type", async () => {
      const res = await callTool(repoDir, "kai_work_item_create", {
        title: "Add retry",
        assignedTo: "dev@contoso.com",
        parentId: 7,
        tags: ["api", "API", "retry"],
        priority: 2,
      });
      expect(res.json).toMatchObject({ ok: true, workItemId: 21, type: "Task", state: "To Do" });
      expect(res.json!.changed).toContain("created");
      const post = calls.find((c) => c.method === "POST")!;
      expect(post.url).toContain("/workitems/$Task?");
      const ops = post.body as Array<{ path: string; value: unknown }>;
      expect(ops.find((o) => o.path === "/fields/System.Tags")!.value).toBe("api; retry");
    });

    it("assigns me to the signed-in user, and refuses when that user is unknown", async () => {
      const unknown = await callTool(repoDir, "kai_work_item_create", {
        title: "t",
        assignedTo: "me",
      });
      expect(unknown.error?.message).toContain('"me" is not known');
      expect(calls).toHaveLength(0);

      saveAccount({ ...azAccount("Contoso", "az"), user: "Dev User" });
      const known = await callTool(repoDir, "kai_work_item_update", { id: 7, assignedTo: "Me" });
      expect(known.error).toBeUndefined();
      const patch = calls.find((c) => c.method === "PATCH")!;
      expect(patch.body).toContainEqual({
        op: "add",
        path: "/fields/System.AssignedTo",
        value: "Dev User",
      });
    });

    it("updates a task and says which fields changed, never their values", async () => {
      const res = await callTool(repoDir, "kai_work_item_update", {
        id: 7,
        title: "New",
        description: "secret-ish body",
      });
      expect(res.json).toMatchObject({
        ok: true,
        workItemId: 7,
        fields: ["System.Title", "System.Description"],
      });
      expect(JSON.stringify(res.json)).not.toContain("secret-ish body");
    });

    it("links work items when opening a pull request", async () => {
      const res = await callTool(repoDir, "kai_pr_create", {
        sourceBranch: "feature/login",
        targetBranch: "main",
        title: "Add login",
        workItemIds: [7, 7],
      });
      expect(res.error).toBeUndefined();
      const post = calls.find((c) => c.method === "POST")!;
      expect((post.body as { workItemRefs: unknown }).workItemRefs).toEqual([{ id: "7" }]);
    });

    it("answers a pull request link to a work item of another project with not_found", async () => {
      const res = await callTool(repoDir, "kai_pr_create", {
        sourceBranch: "feature/login",
        targetBranch: "main",
        title: "Add login",
        workItemIds: [9],
      });
      expect(res.error?.message).toContain("not found");
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    });

    it("answers a work item update of another project with not_found and writes nothing", async () => {
      const res = await callTool(repoDir, "kai_work_item_update", { id: 9, title: "x" });
      expect(res.error?.message).toContain("not found");
      expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    });

    it("opens a pull request that links the task, asks for reviews and labels it", async () => {
      const res = await callTool(repoDir, "kai_pr_create", {
        sourceBranch: "feature/login",
        targetBranch: "main",
        title: "Add login",
        workItemIds: [7],
        reviewers: ["ann@contoso.com"],
        requiredReviewers: ["bob@contoso.com"],
        labels: ["backend", "Backend"],
      });
      expect(res.error).toBeUndefined();
      expect(res.json).toMatchObject({
        ok: true,
        attached: {
          workItemIds: [7],
          reviewers: ["ann@contoso.com"],
          requiredReviewers: ["bob@contoso.com"],
          labels: ["backend"],
        },
      });
      const post = calls.find((c) => c.method === "POST")!;
      expect(post.body).toMatchObject({
        workItemRefs: [{ id: "7" }],
        reviewers: [{ id: "guid-ann" }, { id: "guid-bob", isRequired: true }],
        labels: [{ name: "backend" }],
      });
    });

    it("answers a pull request of another project with not_found", async () => {
      const res = await callTool(repoDir, "kai_pr_comment", { id: 13, text: "leak" });
      expect(res.error?.message).toContain("not found");
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    });

    it.each([
      ["kai_work_item_comment", { id: 0, text: "x" }, "id must be a positive integer"],
      ["kai_work_item_comment", { id: 7 }, "text is required"],
      ["kai_work_item_comment", { id: 7, text: "   " }, "text is required"],
      ["kai_work_item_comment", { id: 7, text: "x".repeat(8001) }, "at most 8000"],
      ["kai_work_item_comment", { id: 7, text: "bad\u0000byte" }, "text is required"],
      ["kai_work_item_set_state", { id: 7, state: "" }, "state is required"],
      ["kai_work_item_set_state", { id: 7, state: "a\nb" }, "one line"],
      ["kai_work_item_set_state", { id: 7, state: "s".repeat(61) }, "at most 60"],
      [
        "kai_pr_create",
        { sourceBranch: "bad branch", title: "t", targetBranch: "main" },
        "sourceBranch",
      ],
      ["kai_pr_create", { sourceBranch: "a", targetBranch: "-x", title: "t" }, "targetBranch"],
      [
        "kai_pr_create",
        { sourceBranch: "main", targetBranch: "refs/heads/main", title: "t" },
        "must differ",
      ],
      ["kai_pr_create", { sourceBranch: "a", targetBranch: "b" }, "title is required"],
      [
        "kai_pr_create",
        { sourceBranch: "a", targetBranch: "b", title: "x".repeat(401) },
        "at most 400",
      ],
      ["kai_pr_create", { sourceBranch: "a", targetBranch: "b", title: "a\nb" }, "one line"],
      [
        "kai_pr_create",
        { sourceBranch: "a", targetBranch: "b", title: "t", description: "d".repeat(4001) },
        "at most 4000",
      ],
      [
        "kai_pr_create",
        { sourceBranch: "a", targetBranch: "b", title: "t", isDraft: "yes" },
        "isDraft",
      ],
      ["kai_work_item_create", {}, "title is required"],
      ["kai_work_item_create", { title: "a\nb" }, "one line"],
      ["kai_work_item_create", { title: "t".repeat(256) }, "at most 255"],
      ["kai_work_item_create", { title: "t", type: "Task/../x" }, "type must be"],
      ["kai_work_item_create", { title: "t", parentId: 0 }, "parentId"],
      ["kai_work_item_create", { title: "t", priority: 5 }, "priority"],
      ["kai_work_item_create", { title: "t", priority: 1.5 }, "priority"],
      ["kai_work_item_create", { title: "t", tags: ["a;b"] }, "each tag"],
      ["kai_work_item_create", { title: "t", tags: "api" }, "tags must be"],
      ["kai_work_item_create", { title: "t", remainingWork: -1 }, "remainingWork"],
      ["kai_work_item_create", { title: "t", description: "d".repeat(8001) }, "description"],
      ["kai_work_item_create", { title: "t", assignedTo: "a\nb" }, "assignedTo"],
      ["kai_work_item_update", { id: 0, title: "t" }, "id must be a positive integer"],
      ["kai_work_item_update", { id: 7 }, "give at least one field"],
      ["kai_work_item_update", { id: 7, title: "" }, "title must be"],
      ["kai_work_item_update", { id: 7, completedWork: "3" }, "completedWork"],
      [
        "kai_pr_create",
        { sourceBranch: "a", targetBranch: "b", title: "t", workItemIds: ["x"] },
        "workItemIds",
      ],
      [
        "kai_pr_create",
        { sourceBranch: "a", targetBranch: "b", title: "t", workItemIds: 7 },
        "workItemIds",
      ],
      [
        "kai_pr_create",
        { sourceBranch: "a", targetBranch: "b", title: "t", reviewers: "ann@contoso.com" },
        "reviewers",
      ],
      [
        "kai_pr_create",
        { sourceBranch: "a", targetBranch: "b", title: "t", requiredReviewers: [1] },
        "reviewers",
      ],
      [
        "kai_pr_create",
        { sourceBranch: "a", targetBranch: "b", title: "t", labels: ["a\nb"] },
        "labels",
      ],
      [
        "kai_pr_create",
        { sourceBranch: "a", targetBranch: "b", title: "t", labels: Array(11).fill("x") },
        "labels",
      ],
      ["kai_pr_comment", { id: 12, text: "x", filePath: "/a.ts" }, "give both or neither"],
      ["kai_pr_comment", { id: 12, text: "x", line: 3 }, "give both or neither"],
      ["kai_pr_comment", { id: 12, text: "x", filePath: "../../etc/passwd", line: 1 }, "filePath"],
      [
        "kai_pr_comment",
        { id: 12, text: "x", threadId: 5, filePath: "/a.ts", line: 1 },
        "cannot also start",
      ],
      ["kai_pr_comment", { id: 12, text: "x", threadId: -1 }, "threadId"],
    ])("validates %s %j before any network call", async (name, args, message) => {
      const res = await callTool(repoDir, name as string, args as Record<string, unknown>);
      expect(res.error?.message).toContain(message as string);
      expect(calls).toHaveLength(0);
    });

    it("reports a refused write as an error that says what to do, without the token", async () => {
      useFakeAzure([
        { match: "GET ", body: WORK_ITEM },
        { match: "POST ", status: 403, body: { message: "denied" } },
      ]);
      const res = await callTool(repoDir, "kai_work_item_comment", { id: 7, text: "x" });
      expect(res.error?.message).toContain("Access denied");
      expect(res.error?.message).not.toContain("entra-token");
    });

    it("shows in kai_integration_status that writes are on", async () => {
      const res = await callTool(repoDir, "kai_integration_status");
      expect(res.json!.writeTools).toBe(true);
      await setWriteTools("azure-devops", repoDir, false);
      expect((await callTool(repoDir, "kai_integration_status")).json!.writeTools).toBe(false);
    });
  });

  it("never lists a write tool for a provider that cannot write", async () => {
    const real = createAzureDevOpsProvider();
    setProviderForTests("azure-devops", {
      ...real,
      workItems: { search: real.workItems!.search, get: real.workItems!.get },
      pullRequests: { list: real.pullRequests!.list, get: real.pullRequests!.get },
    });
    await expect(
      setWriteTools("azure-devops", repoDir, true, { agentGuard: personGuard })
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});
