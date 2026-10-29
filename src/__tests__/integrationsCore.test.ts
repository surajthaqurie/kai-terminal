import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findBinding,
  getAccount,
  listAccounts,
  projectRootFor,
  projectsUsingAccount,
  saveAccount,
  writeBinding,
} from "../core/integrations/config";
import { createAzureDevOpsProvider } from "../core/integrations/providers/azure-devops";
import { setProviderForTests } from "../core/integrations/providers";
import {
  bind,
  checkAccess,
  findAccounts,
  getStatus,
  handleRpc,
  listProjects,
  listRepos,
  login,
  logout,
  removeAccountEverywhere,
  resolveReady,
  switchActive,
  unbind,
} from "../core/integrations/service";
import { IntegrationError, type IntegrationProvider } from "../core/integrations/types";
import {
  MemorySecrets,
  azAccount,
  fakeDiscovery,
  makeRepo,
  offlineAzure,
  useTempKaiHome,
} from "./helpers/integrationsEnv";

const REMOTE = "https://dev.azure.com/Contoso/My%20Project/_git/api";

/** The real Azure provider with `verify` replaced, so no network is needed. */
function offlineProvider(): IntegrationProvider {
  const real = createAzureDevOpsProvider();
  return {
    ...real,
    discovery: fakeDiscovery,
    async verify(_account, _secrets, secret) {
      if (secret === "bad-token") throw new IntegrationError("auth", "rejected");
      return { name: "Test User", email: "test@contoso.com" };
    },
  };
}

let env: ReturnType<typeof useTempKaiHome>;
let secrets: MemorySecrets;
const cleanups: Array<() => void> = [];

function repo(remote?: string) {
  const r = makeRepo(remote);
  cleanups.push(r.cleanup);
  return r.dir;
}

beforeEach(() => {
  env = useTempKaiHome();
  secrets = new MemorySecrets();
  setProviderForTests("azure-devops", offlineProvider());
});

afterEach(() => {
  setProviderForTests("azure-devops", null);
  cleanups.splice(0).forEach((c) => c());
  env.restore();
});

describe("login", () => {
  it("verifies, stores the token in the secret store, and keeps it out of config.json", async () => {
    const result = await login(
      "azure-devops",
      { org: "Contoso", authMethod: "pat", pat: "tok-123456" },
      { secrets }
    );
    expect(result.account).toMatchObject({
      id: "azure-devops:contoso",
      user: "test@contoso.com",
      hasCredential: true,
    });
    expect(result.storedIn).toBe("os");
    expect(secrets.data.get("kai/azure-devops/contoso")).toBe("tok-123456");
    const raw = fs.readFileSync(path.join(env.home, "config.json"), "utf8");
    expect(raw).not.toContain("tok-123456");
    expect(getAccount("azure-devops:contoso")?.authMethod).toBe("pat");
  });

  it("saves nothing when the credential is rejected", async () => {
    await expect(
      login("azure-devops", { org: "Contoso", authMethod: "pat", pat: "bad-token" }, { secrets })
    ).rejects.toMatchObject({ code: "auth" });
    expect(listAccounts()).toEqual([]);
    expect(secrets.data.size).toBe(0);
  });

  it("requires a token for pat auth", async () => {
    await expect(
      login("azure-devops", { org: "Contoso", authMethod: "pat" }, { secrets })
    ).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("switching to Azure CLI auth deletes the old token", async () => {
    await login(
      "azure-devops",
      { org: "Contoso", authMethod: "pat", pat: "tok-123456" },
      { secrets }
    );
    await login("azure-devops", { org: "Contoso", authMethod: "az" }, { secrets });
    expect(secrets.data.size).toBe(0);
    expect(getAccount("azure-devops:contoso")?.authMethod).toBe("az");
  });

  it("preserves unrelated keys in config.json", async () => {
    fs.writeFileSync(
      path.join(env.home, "config.json"),
      JSON.stringify({ defaultTokenBudget: 1234 })
    );
    await login("azure-devops", { org: "Contoso", authMethod: "az" }, { secrets });
    const saved = JSON.parse(fs.readFileSync(path.join(env.home, "config.json"), "utf8"));
    expect(saved.defaultTokenBudget).toBe(1234);
    expect(Object.keys(saved.integrations.accounts)).toEqual(["azure-devops:contoso"]);
  });

  it("refuses to overwrite a corrupt config.json", async () => {
    const file = path.join(env.home, "config.json");
    fs.writeFileSync(file, "{ not json");
    await expect(
      login("azure-devops", { org: "Contoso", authMethod: "az" }, { secrets })
    ).rejects.toMatchObject({
      code: "config",
    });
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });
});

describe("binding a project", () => {
  it("connects from the git remote: account by org, project and repo decoded", () => {
    saveAccount(azAccount("Contoso", "az"));
    const dir = repo(REMOTE);
    const binding = bind("azure-devops", dir);
    expect(binding).toMatchObject({
      account: "azure-devops:contoso",
      project: "My Project",
      repo: "api",
    });
    expect(findBinding(dir)?.binding).toMatchObject({ project: "My Project" });
  });

  it("asks for the right login when the remote's organization is not signed in", () => {
    saveAccount(azAccount("other", "az"));
    expect(() => bind("azure-devops", repo(REMOTE))).toThrowError(
      expect.objectContaining({
        code: "no_account",
        hint: expect.stringContaining("--org Contoso"),
      })
    );
  });

  it("needs --project outside an Azure DevOps repository", () => {
    saveAccount(azAccount("Contoso", "az"));
    expect(() => bind("azure-devops", repo("https://github.com/a/b.git"))).toThrowError(
      expect.objectContaining({ code: "no_remote" })
    );
  });

  it("takes an explicit account and project when there is no remote", () => {
    saveAccount(azAccount("Contoso", "az"));
    const binding = bind("azure-devops", repo(), { project: "Payments", repo: "svc" });
    expect(binding).toMatchObject({
      account: "azure-devops:contoso",
      project: "Payments",
      repo: "svc",
    });
  });

  it("a project has ONE binding: re-binding replaces it rather than adding", () => {
    saveAccount(azAccount("Contoso", "az"));
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    bind("azure-devops", dir, { project: "Other", repo: null });
    expect(findBinding(dir)?.binding).toMatchObject({ project: "Other", repo: null });
    const files = fs
      .readdirSync(path.join(env.home, "projects"), { recursive: true })
      .filter((f) => String(f).endsWith("integration.json"));
    expect(files).toHaveLength(1);
  });

  it("will not silently replace a different integration", () => {
    saveAccount(azAccount("Contoso", "az"));
    const dir = repo(REMOTE);
    writeBinding(projectRootFor(dir), {
      provider: "jira",
      account: "jira:acme",
      project: "ACME",
      repo: null,
      boundAt: "2026-10-29T00:00:00.000Z",
    });
    expect(() => bind("azure-devops", dir)).toThrowError(
      expect.objectContaining({ code: "needs_confirmation" })
    );
    expect(findBinding(dir)?.binding.provider).toBe("jira");
    bind("azure-devops", dir, { replace: true });
    expect(findBinding(dir)?.binding.provider).toBe("azure-devops");
  });

  it("finds the repository's binding from a sub-folder", () => {
    saveAccount(azAccount("Contoso", "az"));
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const sub = path.join(dir, "packages", "web");
    fs.mkdirSync(sub, { recursive: true });
    expect(findBinding(sub)?.binding.account).toBe("azure-devops:contoso");
  });

  it("two projects stay independent", () => {
    saveAccount(azAccount("Contoso", "az"));
    const a = repo(REMOTE);
    const b = repo();
    bind("azure-devops", a);
    expect(findBinding(b)).toBeNull();
  });
});

describe("status", () => {
  it("walks none, ready, signed out and account missing", async () => {
    const dir = repo(REMOTE);
    expect((await getStatus("azure-devops", dir, { secrets })).project.state).toBe("none");

    await login(
      "azure-devops",
      { org: "Contoso", authMethod: "pat", pat: "tok-123456" },
      { secrets }
    );
    bind("azure-devops", dir);
    const ready = await getStatus("azure-devops", dir, { secrets });
    expect(ready.project).toMatchObject({
      state: "ready",
      detected: { org: "Contoso", repo: "api" },
    });
    expect(ready.accounts[0].usedByThisProject).toBe(true);

    secrets.data.clear();
    expect((await getStatus("azure-devops", dir, { secrets })).project.state).toBe("signed_out");

    await logout("azure-devops:contoso", { secrets });
    expect((await getStatus("azure-devops", dir, { secrets })).project.state).toBe(
      "account_missing"
    );
  });

  it("reports a different integration instead of claiming this one", async () => {
    const dir = repo(REMOTE);
    writeBinding(projectRootFor(dir), {
      provider: "jira",
      account: "jira:acme",
      project: "ACME",
      repo: null,
      boundAt: "",
    });
    const status = await getStatus("azure-devops", dir, { secrets });
    expect(status.project).toMatchObject({ state: "none", binding: null, otherProvider: "jira" });
  });
});

describe("unbind and logout", () => {
  it("unbind keeps the account signed in", async () => {
    await login("azure-devops", { org: "Contoso", authMethod: "az" }, { secrets });
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const result = await unbind("azure-devops", dir, {}, { secrets });
    expect(result).toMatchObject({ removed: true, loggedOut: false });
    expect(findBinding(dir)).toBeNull();
    expect(getAccount("azure-devops:contoso")).not.toBeNull();
  });

  it("unbind --logout also signs out", async () => {
    await login(
      "azure-devops",
      { org: "Contoso", authMethod: "pat", pat: "tok-123456" },
      { secrets }
    );
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const result = await unbind("azure-devops", dir, { logout: true }, { secrets });
    expect(result.loggedOut).toBe(true);
    expect(getAccount("azure-devops:contoso")).toBeNull();
    expect(secrets.data.size).toBe(0);
  });

  it("reports the other projects still using the account", async () => {
    await login("azure-devops", { org: "Contoso", authMethod: "az" }, { secrets });
    const a = repo(REMOTE);
    const b = repo(REMOTE);
    bind("azure-devops", a);
    bind("azure-devops", b);
    expect(projectsUsingAccount("azure-devops:contoso")).toHaveLength(2);
    const result = await unbind("azure-devops", a, {}, { secrets });
    expect(result.stillUsedBy).toHaveLength(1);
  });

  it("unbinding a project that is not connected is a no-op", async () => {
    expect(await unbind("azure-devops", repo(), {}, { secrets })).toMatchObject({ removed: false });
  });

  it("leaves another integration's binding alone", async () => {
    const dir = repo();
    writeBinding(projectRootFor(dir), {
      provider: "jira",
      account: "jira:acme",
      project: "A",
      repo: null,
      boundAt: "",
    });
    expect((await unbind("azure-devops", dir, {}, { secrets })).removed).toBe(false);
    expect(findBinding(dir)?.binding.provider).toBe("jira");
  });
});

describe("resolveReady (what the MCP tools call)", () => {
  it("names the command to run when nothing is connected", async () => {
    await expect(resolveReady(repo(), { secrets })).rejects.toMatchObject({
      code: "no_account",
      hint: expect.stringContaining("kai integration azure"),
    });
  });

  it("never falls back to another account when the bound one is gone", async () => {
    await login("azure-devops", { org: "Contoso", authMethod: "az" }, { secrets });
    await login("azure-devops", { org: "Fabrikam", authMethod: "az" }, { secrets });
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    await logout("azure-devops:contoso", { secrets });
    await expect(resolveReady(dir, { secrets })).rejects.toMatchObject({
      code: "no_account",
      message: expect.stringContaining("azure-devops:contoso"),
    });
  });

  it("returns the provider and context when ready", async () => {
    await login("azure-devops", { org: "Contoso", authMethod: "az" }, { secrets });
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const { ctx } = await resolveReady(dir, { secrets });
    expect(ctx.binding.project).toBe("My Project");
    expect(ctx.account.id).toBe("azure-devops:contoso");
  });
});

describe("rpc", () => {
  it("drives login, status, bind and unbind with the shapes the app expects", async () => {
    const dir = repo(REMOTE);
    const deps = { secrets };
    const loggedIn = await handleRpc(
      "azure-devops",
      { op: "login", org: "Contoso", authMethod: "pat", pat: "tok-123456" },
      deps
    );
    expect(loggedIn).toMatchObject({
      ok: true,
      account: { id: "azure-devops:contoso" },
      user: { name: "Test User" },
    });
    expect(JSON.stringify(loggedIn)).not.toContain("tok-123456");

    expect(
      await handleRpc(
        "azure-devops",
        { op: "bind", projectDir: dir, account: "azure-devops:contoso" },
        deps
      )
    ).toMatchObject({
      ok: true,
      binding: { project: "My Project", repo: "api" },
    });
    const status = await handleRpc("azure-devops", { op: "status", projectDir: dir }, deps);
    expect(status).toMatchObject({ ok: true, status: { project: { state: "ready" } } });
    expect(
      await handleRpc("azure-devops", { op: "verify", account: "azure-devops:contoso" }, deps)
    ).toMatchObject({ ok: true, user: { name: "Test User" } });
    expect(await handleRpc("azure-devops", { op: "unbind", projectDir: dir }, deps)).toEqual({
      ok: true,
      done: true,
    });
    expect(
      await handleRpc("azure-devops", { op: "logout", account: "azure-devops:contoso" }, deps)
    ).toEqual({ ok: true, done: true });
  });

  it("rejects an absurdly long token and an unknown op", async () => {
    await expect(
      handleRpc(
        "azure-devops",
        { op: "login", org: "o", authMethod: "pat", pat: "x".repeat(5000) },
        { secrets }
      )
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      handleRpc("azure-devops", { op: "nope" } as never, { secrets })
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("switching the active project", () => {
  beforeEach(() => {
    saveAccount(azAccount("Contoso", "az"));
  });

  it("stores the real spelling of a project typed in any case, and keeps the repo when it exists there", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const binding = await switchActive("azure-devops", dir, { project: "payments" }, { secrets });
    expect(binding).toMatchObject({ project: "Payments", repo: "api" });
    expect(findBinding(dir)?.binding).toMatchObject({ project: "Payments", repo: "api" });
  });

  it("drops a repo the new project does not have", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const binding = await switchActive("azure-devops", dir, { project: "Platform" }, { secrets });
    expect(binding).toMatchObject({ project: "Platform", repo: null });
  });

  it("takes an explicit repository, `null` to clear it, and checks the spelling", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    expect(
      (
        await switchActive(
          "azure-devops",
          dir,
          { project: "Payments", repo: "LEDGER" },
          { secrets }
        )
      ).repo
    ).toBe("ledger");
    expect(
      (await switchActive("azure-devops", dir, { project: "Payments", repo: null }, { secrets }))
        .repo
    ).toBeNull();
    await expect(
      switchActive("azure-devops", dir, { project: "Payments", repo: "nope" }, { secrets })
    ).rejects.toMatchObject({ code: "not_found", hint: expect.stringContaining("api, ledger") });
  });

  it("rejects a typo, lists what exists, and leaves the binding alone", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    await expect(
      switchActive("azure-devops", dir, { project: "Paymnts" }, { secrets })
    ).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("Paymnts"),
      hint: expect.stringContaining("Payments"),
    });
    expect(findBinding(dir)?.binding.project).toBe("My Project");
  });

  it("keeps exactly one binding for the folder across switches", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    await switchActive("azure-devops", dir, { project: "Payments" }, { secrets });
    await switchActive("azure-devops", dir, { project: "Platform" }, { secrets });
    const files = fs
      .readdirSync(path.join(env.home, "projects"), { recursive: true })
      .filter((f) => String(f).endsWith("integration.json"));
    expect(files).toHaveLength(1);
    expect(findBinding(dir)?.binding.project).toBe("Platform");
  });

  it("changes only this folder, not another project on the same account", async () => {
    const a = repo(REMOTE);
    const b = repo(REMOTE);
    bind("azure-devops", a);
    bind("azure-devops", b);
    await switchActive("azure-devops", a, { project: "Payments" }, { secrets });
    expect(findBinding(a)?.binding.project).toBe("Payments");
    expect(findBinding(b)?.binding.project).toBe("My Project");
  });

  it("works on a folder with no remote when the account is unambiguous", async () => {
    const dir = repo();
    const binding = await switchActive("azure-devops", dir, { project: "Mobile" }, { secrets });
    expect(binding).toMatchObject({
      project: "Mobile",
      repo: null,
      account: "azure-devops:contoso",
    });
  });

  it("asks which account when several are signed in and none is bound", async () => {
    saveAccount(azAccount("Fabrikam", "az"));
    await expect(
      switchActive("azure-devops", repo(), { project: "Payments" }, { secrets })
    ).rejects.toMatchObject({ code: "no_account" });
    const ok = await switchActive(
      "azure-devops",
      repo(),
      { project: "Payments", account: "azure-devops:fabrikam" },
      { secrets }
    );
    expect(ok.account).toBe("azure-devops:fabrikam");
  });

  it("will not silently replace a different integration", async () => {
    const dir = repo(REMOTE);
    writeBinding(projectRootFor(dir), {
      provider: "jira",
      account: "jira:acme",
      project: "A",
      repo: null,
      boundAt: "",
    });
    await expect(
      switchActive("azure-devops", dir, { project: "Payments" }, { secrets })
    ).rejects.toMatchObject({ code: "needs_confirmation" });
    expect(
      (await switchActive("azure-devops", dir, { project: "Payments", replace: true }, { secrets }))
        .provider
    ).toBe("azure-devops");
  });

  it("lists projects and repositories, and refuses an unknown account", async () => {
    expect((await listProjects("azure-devops:contoso", { secrets })).map((p) => p.name)).toEqual([
      "Mobile",
      "My Project",
      "Payments",
      "Platform",
    ]);
    expect(
      (await listRepos("azure-devops:contoso", "Payments", { secrets })).map((r) => r.name)
    ).toEqual(["api", "ledger"]);
    await expect(listProjects("azure-devops:nobody", { secrets })).rejects.toMatchObject({
      code: "no_account",
    });
  });

  it("is reachable through the desktop RPC, including the project and repo lists", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    expect(
      await handleRpc(
        "azure-devops",
        { op: "projects", account: "azure-devops:contoso" },
        { secrets }
      )
    ).toMatchObject({
      ok: true,
      projects: expect.arrayContaining([{ name: "Payments" }]),
    });
    expect(
      await handleRpc(
        "azure-devops",
        { op: "repos", account: "azure-devops:contoso", project: "Payments" },
        { secrets }
      )
    ).toMatchObject({
      ok: true,
      repos: [{ name: "api" }, { name: "ledger" }],
    });
    expect(
      await handleRpc(
        "azure-devops",
        {
          op: "bind",
          projectDir: dir,
          account: "azure-devops:contoso",
          project: "payments",
          repo: "ledger",
        },
        { secrets }
      )
    ).toMatchObject({ ok: true, binding: { project: "Payments", repo: "ledger" } });
    // Without a project, bind still follows the git remote.
    expect(
      await handleRpc(
        "azure-devops",
        { op: "bind", projectDir: dir, account: "azure-devops:contoso" },
        { secrets }
      )
    ).toMatchObject({ ok: true, binding: { project: "My Project", repo: "api" } });
  });
});

describe("accounts by name, removal everywhere, access checks", () => {
  it("finds an account by id or by organization, ignoring case", async () => {
    await login("azure-devops", { org: "Contoso", authMethod: "az" }, { secrets });
    expect(findAccounts("AZURE-DEVOPS:contoso").map((a) => a.id)).toEqual(["azure-devops:contoso"]);
    expect(findAccounts("CONTOSO").map((a) => a.id)).toEqual(["azure-devops:contoso"]);
    expect(findAccounts("nobody")).toEqual([]);
    expect(findAccounts("   ")).toEqual([]);
  });

  it("removes the token, the account and every folder's connection, and touches no repository", async () => {
    await login(
      "azure-devops",
      { org: "Contoso", authMethod: "pat", pat: "tok-123456" },
      { secrets }
    );
    const a = repo(REMOTE);
    const b = repo(REMOTE);
    bind("azure-devops", a);
    bind("azure-devops", b);
    const result = await removeAccountEverywhere("azure-devops:contoso", { secrets });
    expect(result.folders).toHaveLength(2);
    expect(secrets.data.size).toBe(0);
    expect(getAccount("azure-devops:contoso")).toBeNull();
    expect(findBinding(a)).toBeNull();
    expect(findBinding(b)).toBeNull();
    expect(fs.readdirSync(a).filter((f) => f !== ".git")).toEqual([]);
  });

  it("leaves other accounts' connections alone", async () => {
    await login("azure-devops", { org: "Contoso", authMethod: "az" }, { secrets });
    await login("azure-devops", { org: "Fabrikam", authMethod: "az" }, { secrets });
    const a = repo(REMOTE);
    const b = repo();
    bind("azure-devops", a);
    bind("azure-devops", b, { account: "azure-devops:fabrikam", project: "Payments" });
    await removeAccountEverywhere("azure-devops:contoso", { secrets });
    expect(findBinding(a)).toBeNull();
    expect(findBinding(b)?.binding.account).toBe("azure-devops:fabrikam");
  });

  it("refuses to remove an account that does not exist", async () => {
    await expect(removeAccountEverywhere("azure-devops:nobody", { secrets })).rejects.toMatchObject(
      {
        code: "no_account",
      }
    );
  });

  it("checks each capability with a real call and reports the one that fails", async () => {
    await login("azure-devops", { org: "Contoso", authMethod: "az" }, { secrets });
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    setProviderForTests(
      "azure-devops",
      offlineAzure({
        builds: {
          list: async () => {
            throw new IntegrationError("forbidden", "Access denied.");
          },
          log: async () => {
            throw new Error("unused");
          },
        },
      })
    );
    const checks = await checkAccess(dir, { secrets });
    expect(checks.map((c) => [c.capability, c.ok])).toEqual([
      ["work-items", true],
      ["pull-requests", true],
      ["builds", false],
    ]);
    expect(checks[2].error).toMatchObject({ code: "forbidden" });
  });

  it("refuses to check a folder that is not connected", async () => {
    await expect(checkAccess(repo(), { secrets })).rejects.toMatchObject({ code: "no_account" });
  });
});

describe("auto-detection of the account and project from the remote", () => {
  it("names the sign-in command that fits the remote: --org for the cloud, --server-url for a server", () => {
    saveAccount(azAccount("Other", "az"));
    expect(() => bind("azure-devops", repo(REMOTE))).toThrowError(
      expect.objectContaining({
        code: "no_account",
        hint: expect.stringContaining("kai integration azure --org Contoso"),
      })
    );
    expect(() =>
      bind("azure-devops", repo("https://tfs.corp.local/tfs/DefaultCollection/Billing/_git/ledger"))
    ).toThrowError(
      expect.objectContaining({
        hint: expect.stringContaining(
          "kai integration azure --server-url https://tfs.corp.local/tfs/DefaultCollection"
        ),
      })
    );
  });

  it("matches a server remote to a server account, and a cloud remote to a cloud account", () => {
    saveAccount({
      ...azAccount("DefaultCollection", "az"),
      id: "azure-devops:tfs.corp.local/tfs/defaultcollection",
      baseUrl: "https://tfs.corp.local/tfs/DefaultCollection",
    });
    saveAccount(azAccount("Contoso", "az"));
    const server = bind(
      "azure-devops",
      repo("https://tfs.corp.local/tfs/DefaultCollection/Billing/_git/ledger")
    );
    expect(server).toMatchObject({
      account: "azure-devops:tfs.corp.local/tfs/defaultcollection",
      project: "Billing",
      repo: "ledger",
    });
    const cloud = bind("azure-devops", repo(REMOTE));
    expect(cloud.account).toBe("azure-devops:contoso");
  });

  it("does not use the remote's project with an account that is not the remote's own", () => {
    saveAccount(azAccount("Contoso", "az"));
    saveAccount(azAccount("Fabrikam", "az"));
    expect(() =>
      bind("azure-devops", repo(REMOTE), { account: "azure-devops:fabrikam" })
    ).toThrowError(
      expect.objectContaining({
        code: "no_remote",
        message: expect.stringContaining('remote is in "Contoso"'),
      })
    );
    // An explicit project is fine with any account.
    expect(
      bind("azure-devops", repo(REMOTE), { account: "azure-devops:fabrikam", project: "Payments" })
        .account
    ).toBe("azure-devops:fabrikam");
  });

  it("does not carry the remote's repository into a different project", async () => {
    saveAccount(azAccount("Contoso", "az"));
    const dir = repo(REMOTE); // remote: Contoso / My Project / api
    const binding = await switchActive("azure-devops", dir, { project: "Payments" }, { secrets });
    // `api` exists in Payments too, but the remote's own project is "My Project", so the
    // remote's repository must not be assumed for Payments.
    expect(binding.repo).toBeNull();
  });
});

describe("storage safety", () => {
  it("writes nothing into the repository", async () => {
    await login("azure-devops", { org: "Contoso", authMethod: "az" }, { secrets });
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const inRepo = fs.readdirSync(dir).filter((f) => f !== ".git");
    expect(inRepo).toEqual([]);
  });
});
