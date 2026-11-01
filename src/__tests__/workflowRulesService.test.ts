import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findBinding, saveAccount } from "../core/integrations/config";
import { createAzureDevOpsProvider } from "../core/integrations/providers/azure-devops";
import { setProviderForTests } from "../core/integrations/providers";
import { resetDefaultSecretStore } from "../core/integrations/secretStore";
import { bind, getStatus, handleRpc, listBranches, setRules } from "../core/integrations/service";
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

  it("rejects a branch the repository does not have, and says which exist", async () => {
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
      hint: expect.stringContaining("develop"),
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

  it("refuses a folder that is not connected", async () => {
    const other = makeRepo("https://example.com/x.git");
    try {
      await expect(setRules("azure-devops", other.dir, {})).rejects.toThrow(/not connected/);
    } finally {
      other.cleanup();
    }
  });
});

describe("merge branch: listing", () => {
  it("lists only branches, sorted, without the refs/heads prefix", async () => {
    useFakeAzure([BRANCHES]);
    expect(await listBranches(repoDir)).toEqual(["develop", "release/1.2", "trunk"]);
    const res = await handleRpc("azure-devops", { op: "branches", projectDir: repoDir });
    expect(res).toEqual({ ok: true, branches: ["develop", "release/1.2", "trunk"] });
  });

  it("needs a repository", async () => {
    bind("azure-devops", repoDir, { repo: null });
    await expect(listBranches(repoDir)).rejects.toThrow(/not bound to a repository/);
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
