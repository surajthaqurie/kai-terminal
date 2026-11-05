import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findBinding, saveAccount } from "../core/integrations/config";
import { createAzureDevOpsProvider } from "../core/integrations/providers/azure-devops";
import { setProviderForTests } from "../core/integrations/providers";
import { resetDefaultSecretStore } from "../core/integrations/secretStore";
import { bind, branchExists, getStatus, handleRpc, setRules } from "../core/integrations/service";
import { DEFAULT_RULES } from "../core/integrations/workflowRules";
import { callTool } from "./helpers/mcpCall";
import { azAccount, fakeFetch, makeRepo, useTempKaiHome } from "./helpers/integrationsEnv";

const REMOTE = "https://dev.azure.com/Contoso/Payments/_git/api";

let env: ReturnType<typeof useTempKaiHome>;
let repoDir: string;
let cleanupRepo: () => void;

function useFakeAzure(routes: Parameters<typeof fakeFetch>[0]) {
  setProviderForTests(
    "azure-devops",
    createAzureDevOpsProvider({
      http: { fetchImpl: fakeFetch(routes).fetchImpl, sleep: async () => {} },
      auth: {
        env: {},
        run: async () => ({
          code: 0,
          stdout: JSON.stringify({ accessToken: "t", expires_on: 4102444800 }),
          stderr: "",
        }),
      },
    })
  );
}

const REPOS = {
  match: "/git/repositories?",
  body: { value: [{ name: "api", defaultBranch: "refs/heads/trunk" }] },
};
const BRANCHES = {
  match: "/git/repositories/api/refs",
  body: {
    value: [
      { name: "refs/heads/trunk" },
      { name: "refs/heads/develop" },
      { name: "refs/heads/release/1.2" },
      { name: "refs/tags/v1" },
    ],
  },
};

beforeEach(() => {
  env = useTempKaiHome();
  resetDefaultSecretStore();
  const repo = makeRepo(REMOTE);
  repoDir = repo.dir;
  cleanupRepo = repo.cleanup;
  saveAccount(azAccount("Contoso", "az"));
  bind("azure-devops", repoDir);
});

afterEach(() => {
  setProviderForTests("azure-devops", null);
  cleanupRepo();
  env.restore();
});

describe("merge branch: storage", () => {
  it("starts with the default and reports it in the status view", async () => {
    const status = await getStatus("azure-devops", repoDir);
    expect(status.project.binding?.rules).toEqual(DEFAULT_RULES);
    expect(findBinding(repoDir)?.binding.rules).toBeUndefined();
  });

  it("saves a branch of the repository and reads it back", async () => {
    useFakeAzure([BRANCHES]);
    const res = await handleRpc("azure-devops", {
      op: "set_rules",
      projectDir: repoDir,
      rules: { mergeBranch: "develop" },
    });
    expect(res).toMatchObject({ ok: true, binding: { rules: { mergeBranch: "develop" } } });
    expect(findBinding(repoDir)?.binding.rules).toEqual({ mergeBranch: "develop" });
  });

  it("clears back to the default when rules is empty", async () => {
    useFakeAzure([BRANCHES]);
    await setRules("azure-devops", repoDir, { mergeBranch: "develop" });
    await setRules("azure-devops", repoDir, {});
    expect(findBinding(repoDir)?.binding.rules).toBeUndefined();
  });

  it("rejects a branch the repository does not have, and names it", async () => {
    useFakeAzure([BRANCHES]);
    await setRules("azure-devops", repoDir, { mergeBranch: "develop" });
    const err = await handleRpc("azure-devops", {
      op: "set_rules",
      projectDir: repoDir,
      rules: { mergeBranch: "nope" },
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "not_found",
      message: expect.stringContaining('"nope"'),
      hint: expect.stringContaining("case-sensitive"),
    });
    expect(findBinding(repoDir)?.binding.rules).toEqual({ mergeBranch: "develop" });
  });

  it("still saves when the repository cannot be reached (offline)", async () => {
    useFakeAzure([{ match: "/git/repositories/api/refs", status: 503, body: {} }]);
    await setRules("azure-devops", repoDir, { mergeBranch: "develop" });
    expect(findBinding(repoDir)?.binding.rules).toEqual({ mergeBranch: "develop" });
  });

  it("rejects an invalid value and a non-object", async () => {
    await expect(setRules("azure-devops", repoDir, { mergeBranch: "bad branch" })).rejects.toThrow(
      /not a valid branch name/
    );
    await expect(setRules("azure-devops", repoDir, "nope")).rejects.toThrow(/must be an object/);
  });

  it("saves, reads back and removes a branch naming pattern", async () => {
    useFakeAzure([BRANCHES]);
    const pattern = String.raw`^(feature|bugfix)/\d+-[a-z0-9-]+$`;
    await setRules("azure-devops", repoDir, { mergeBranch: "", branchPattern: pattern });
    expect(findBinding(repoDir)?.binding.rules).toEqual({ branchPattern: pattern });
    const status = await getStatus("azure-devops", repoDir);
    expect(status.project.binding?.rules).toEqual({ ...DEFAULT_RULES, branchPattern: pattern });

    // Removing it (empty) stores nothing again.
    await setRules("azure-devops", repoDir, { mergeBranch: "", branchPattern: "" });
    expect(findBinding(repoDir)?.binding.rules).toBeUndefined();
  });

  it("removes one rule and keeps the other", async () => {
    useFakeAzure([BRANCHES]);
    const pattern = String.raw`^feature/\d+$`;
    await setRules("azure-devops", repoDir, { mergeBranch: "develop", branchPattern: pattern });
    await setRules("azure-devops", repoDir, { mergeBranch: "", branchPattern: pattern });
    expect(findBinding(repoDir)?.binding.rules).toEqual({ branchPattern: pattern });
  });

  it("rejects a bad pattern with the reason and writes nothing", async () => {
    await expect(
      setRules("azure-devops", repoDir, { branchPattern: "^feature/(" })
    ).rejects.toThrow(/Not a valid regular expression/);
    await expect(setRules("azure-devops", repoDir, { branchPattern: ".*" })).rejects.toThrow(
      /matches an empty name/
    );
    await expect(setRules("azure-devops", repoDir, { branchPattern: 5 })).rejects.toThrow(
      /Branch naming must be text/
    );
    expect(findBinding(repoDir)?.binding.rules).toBeUndefined();
  });

  it("refuses a folder that is not connected", async () => {
    const other = makeRepo("https://example.com/x.git");
    try {
      await expect(setRules("azure-devops", other.dir, {})).rejects.toThrow(/not connected/);
    } finally {
      other.cleanup();
    }
  });
});

describe("merge branch: checking one name", () => {
  it("asks about the typed name only; the branch list is never requested", async () => {
    const fake = fakeFetch([BRANCHES]);
    setProviderForTests(
      "azure-devops",
      createAzureDevOpsProvider({
        http: { fetchImpl: fake.fetchImpl, sleep: async () => {} },
        auth: {
          env: {},
          run: async () => ({
            code: 0,
            stdout: JSON.stringify({ accessToken: "t", expires_on: 4102444800 }),
            stderr: "",
          }),
        },
      })
    );
    expect(await branchExists(repoDir, "release/1.2")).toBe(true);
    expect(await branchExists(repoDir, "release")).toBe(false); // exact name, not a prefix
    expect(await branchExists(repoDir, "refs-only")).toBe(false);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[0].url).toContain("filter=heads%2Frelease%2F1.2");
    // No "branches" request exists any more.
    const res = await handleRpc("azure-devops", {
      op: "branches",
      projectDir: repoDir,
    } as never).catch((e: unknown) => e);
    expect(res).not.toMatchObject({ ok: true });
  });

  it("needs a repository", async () => {
    bind("azure-devops", repoDir, { repo: null });
    await expect(branchExists(repoDir, "main")).rejects.toThrow(/not bound to a repository/);
  });
});

describe("kai_workflow_rules tool", () => {
  it("returns the configured merge branch and nothing else", async () => {
    useFakeAzure([BRANCHES]);
    await setRules("azure-devops", repoDir, { mergeBranch: "develop" });
    const res = await callTool(repoDir, "kai_workflow_rules");
    expect(res.error).toBeUndefined();
    expect(res.json).toMatchObject({ baseBranch: "develop" });
    expect(res.json!.note).toContain("origin/develop");
    expect(Object.keys(res.json!).sort()).toEqual(["baseBranch", "note"]);
  });

  it("adds the branch naming pattern only when one is set", async () => {
    useFakeAzure([BRANCHES]);
    const pattern = String.raw`^(feature|bugfix)/\d+-[a-z0-9-]+$`;
    await setRules("azure-devops", repoDir, { mergeBranch: "develop", branchPattern: pattern });
    const res = await callTool(repoDir, "kai_workflow_rules");
    expect(res.json).toMatchObject({ baseBranch: "develop", branchPattern: pattern });
    expect(res.json!.branchPatternNote).toContain(pattern);
    expect(Object.keys(res.json!).sort()).toEqual([
      "baseBranch",
      "branchPattern",
      "branchPatternNote",
      "note",
    ]);
  });

  it("falls back to the repository default when none is configured", async () => {
    useFakeAzure([REPOS]);
    const res = await callTool(repoDir, "kai_workflow_rules");
    expect(res.json).toMatchObject({ baseBranch: "trunk" });
    expect(res.json!.note).toMatch(/No merge branch is configured/);
  });

  it("still answers when the default branch cannot be looked up", async () => {
    useFakeAzure([{ match: "/git/repositories", status: 503, body: {} }]);
    const res = await callTool(repoDir, "kai_workflow_rules");
    expect(res.error).toBeUndefined();
    expect(res.json).toMatchObject({ baseBranch: null });
  });
});
