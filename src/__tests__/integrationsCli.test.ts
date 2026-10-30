import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../cli/index";
import { wireAgents } from "../cli/commands/integration";
import {
  findBinding,
  getAccount,
  listAccounts,
  projectRootFor,
  saveAccount,
  writeBinding,
} from "../core/integrations/config";
import { setProviderForTests } from "../core/integrations/providers";
import { bind } from "../core/integrations/service";
import { IntegrationError } from "../core/integrations/types";
import {
  azAccount,
  fakeDiscovery,
  makeRepo,
  offlineAzure,
  useFakeAgents,
  useTempKaiHome,
} from "./helpers/integrationsEnv";

const REMOTE = "https://dev.azure.com/Contoso/Payments/_git/api";

let env: ReturnType<typeof useTempKaiHome>;
let agents: ReturnType<typeof useFakeAgents>;
let out: string[];
let err: string[];
const cleanups: Array<() => void> = [];

async function kai(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  out = [];
  err = [];
  const code = await runCli(["node", "kai", ...args]);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function repo(remote?: string) {
  const r = makeRepo(remote);
  cleanups.push(r.cleanup);
  return r.dir;
}

beforeEach(() => {
  env = useTempKaiHome();
  // Agent wiring must never reach the developer's real configs.
  agents = useFakeAgents(["claude"]);
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  setProviderForTests("azure-devops", offlineAzure());
});

afterEach(() => {
  vi.restoreAllMocks();
  setProviderForTests("azure-devops", null);
  cleanups.splice(0).forEach((c) => c());
  agents.restore();
  env.restore();
});

const claudeConfig = () => path.join(agents.home, ".claude.json");

describe("kai integration list", () => {
  it("says nothing is set up and points at the command, with the folder's remote", async () => {
    const dir = repo(REMOTE);
    const res = await kai("integration", "list", dir);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/azure\s+Azure DevOps\s+○ not set up/);
    expect(res.out).toContain("kai integration azure");
    expect(res.out).toContain("remote: Contoso / Payments");
  });

  it("shows a signed-in account that this folder does not use", async () => {
    saveAccount(azAccount("Contoso", "az"));
    const res = await kai("integration", "list", repo(REMOTE));
    expect(res.out).toMatch(/○ signed in, not used here/);
    expect(res.out).toContain("account Contoso · Azure CLI");
  });

  it("shows the active connection", async () => {
    saveAccount(azAccount("Contoso", "az"));
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const res = await kai("integration", "list", dir);
    expect(res.out).toMatch(/azure\s+Azure DevOps\s+● active here/);
    expect(res.out).toContain("azure-devops:contoso · Payments / api");
  });

  it("flags a connection whose account is gone", async () => {
    saveAccount(azAccount("Contoso", "az"));
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    fs.writeFileSync(path.join(env.home, "config.json"), "{}");
    expect((await kai("integration", "list", dir)).out).toContain("! sign-in needed");
  });

  it("reports another integration that is active here", async () => {
    const dir = repo(REMOTE);
    writeBinding(projectRootFor(dir), {
      provider: "jira",
      account: "jira:acme",
      project: "A",
      repo: null,
      boundAt: "",
    });
    expect((await kai("integration", "list", dir)).out).toContain(
      "another integration is active here"
    );
  });

  it("prints machine-readable output", async () => {
    saveAccount(azAccount("Contoso", "az"));
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const body = JSON.parse((await kai("integration", "list", "--json", dir)).out);
    expect(body[0]).toMatchObject({ id: "azure-devops", state: "active" });
  });

  it("prints help for a bare `kai integration`, and rejects an unknown name", async () => {
    expect((await kai("integration")).out).toContain("kai integration list");
    const unknown = await kai("integration", "jira");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('Unknown integration "jira"');
    expect(unknown.err).toContain("azure");
  });

  it("tells anyone typing the old `kai init` where it went", async () => {
    const res = await kai("init", "azure");
    expect(res.code).toBe(1);
    expect(res.err).toContain("kai integration azure");
  });
});

describe("kai integration azure (setup)", () => {
  beforeEach(() => {
    saveAccount(azAccount("Contoso", "az"));
  });

  it("signs in, connects from the git remote, wires the agent and verifies, in one command", async () => {
    const dir = repo(REMOTE);
    const res = await kai("integration", "azure", dir, "--yes");
    expect(res.code).toBe(0);
    expect(res.out).toContain("Azure DevOps setup");
    expect(res.out).toMatch(/✔ Signed in to Contoso as test@contoso\.com \(Azure CLI\)/);
    expect(res.out).toContain("Contoso / Payments / api   (from the git remote, verified)");
    expect(res.out).toContain("✔ Connected");
    expect(res.out).toMatch(/✔ claude\s+wired/);
    expect(res.out).toMatch(/✔ Work items\s+readable/);
    expect(res.out).toMatch(/✔ Pull requests\s+readable/);
    expect(res.out).toMatch(/✔ Builds\s+readable/);
    expect(res.out).toContain("Agents now get 7 Azure DevOps tools");

    expect(findBinding(dir)?.binding).toMatchObject({ project: "Payments", repo: "api" });
    const cfg = JSON.parse(fs.readFileSync(claudeConfig(), "utf8"));
    expect(cfg.mcpServers["kai-terminal"]).toBeDefined();
  });

  it("is safe to run again: nothing is re-asked and nothing is wired twice", async () => {
    const dir = repo(REMOTE);
    await kai("integration", "azure", dir, "--yes");
    const before = fs.readFileSync(claudeConfig(), "utf8");
    const res = await kai("integration", "azure", dir, "--yes");
    expect(res.code).toBe(0);
    expect(res.out).toContain("✔ Already connected");
    expect(res.out).toMatch(/= claude\s+already wired/);
    expect(fs.readFileSync(claudeConfig(), "utf8")).toBe(before);
  });

  it("leaves every agent config alone with --no-agents", async () => {
    const res = await kai("integration", "azure", repo(REMOTE), "--yes", "--no-agents");
    expect(res.code).toBe(0);
    expect(res.out).toContain("Skipped (--no-agents)");
    expect(fs.existsSync(claudeConfig())).toBe(false);
  });

  it("keeps unrelated keys when it wires an agent", async () => {
    fs.writeFileSync(
      claudeConfig(),
      JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } })
    );
    await kai("integration", "azure", repo(REMOTE), "--yes");
    const cfg = JSON.parse(fs.readFileSync(claudeConfig(), "utf8"));
    expect(cfg.theme).toBe("dark");
    expect(cfg.mcpServers.other).toEqual({ command: "x" });
    expect(cfg.mcpServers["kai-terminal"]).toBeDefined();
  });

  it("explains an agent-less machine instead of failing", async () => {
    const dir = repo(); // created while git is still on PATH
    const saved = process.env.PATH;
    process.env.PATH = path.join(agents.home, "empty-path");
    try {
      const res = await kai(
        "integration",
        "azure",
        dir,
        "--yes",
        "--org",
        "Contoso",
        "--project",
        "Payments"
      );
      expect(res.code).toBe(0);
      expect(res.out).toContain("No supported AI agent was found on PATH");
      expect(res.out).toContain("kai mcp <agent>");
    } finally {
      process.env.PATH = saved;
    }
  });

  it("reports a capability the token cannot read, and still finishes", async () => {
    setProviderForTests(
      "azure-devops",
      offlineAzure({
        builds: {
          list: async () => {
            throw new IntegrationError(
              "forbidden",
              "Access denied.",
              "The token may lack Build (read)."
            );
          },
          log: async () => {
            throw new Error("unused");
          },
        },
      })
    );
    const res = await kai("integration", "azure", repo(REMOTE), "--yes", "--no-agents");
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/✔ Work items\s+readable/);
    expect(res.out).toMatch(/✖ Builds\s+Access denied\./);
    expect(res.out).toContain("The token may lack Build (read).");
    expect(res.out).toContain("run `kai integration azure` again to re-check");
  });

  it("checks the project against Azure and refuses one that does not exist", async () => {
    const dir = repo(REMOTE);
    const res = await kai(
      "integration",
      "azure",
      dir,
      "--yes",
      "--project",
      "Paymnts",
      "--no-agents"
    );
    expect(res.code).toBe(1);
    expect(res.err).toContain('No project named "Paymnts"');
    expect(res.err).toContain("Payments");
    expect(findBinding(dir)).toBeNull();
  });

  it("takes --project and --repo when there is no Azure remote", async () => {
    const dir = repo();
    const res = await kai(
      "integration",
      "azure",
      dir,
      "--yes",
      "--org",
      "Contoso",
      "--project",
      "payments",
      "--repo",
      "ledger",
      "--no-agents"
    );
    expect(res.code).toBe(0);
    expect(findBinding(dir)?.binding).toMatchObject({ project: "Payments", repo: "ledger" });
  });

  it("needs a project when the folder has no remote and nobody can be asked", async () => {
    const res = await kai("integration", "azure", repo("https://github.com/a/b.git"), "--yes");
    expect(res.code).toBe(1);
    expect(res.err).toContain("No Azure DevOps remote was found");
    expect(res.err).toContain("--project");
  });

  it("will not connect without --yes when it cannot ask", async () => {
    const dir = repo(REMOTE);
    const res = await kai("integration", "azure", dir, "--no-agents");
    expect(res.code).toBe(1);
    expect(res.err).toContain("--yes");
    expect(findBinding(dir)).toBeNull();
  });

  it("replaces a different integration only with --yes", async () => {
    const dir = repo(REMOTE);
    writeBinding(projectRootFor(dir), {
      provider: "jira",
      account: "jira:acme",
      project: "A",
      repo: null,
      boundAt: "",
    });
    const res = await kai("integration", "azure", dir, "--yes", "--no-agents");
    expect(res.code).toBe(0);
    expect(findBinding(dir)?.binding.provider).toBe("azure-devops");
  });

  it("rejects a mistyped option instead of ignoring it", async () => {
    const res = await kai("integration", "azure", repo(REMOTE), "--yess");
    expect(res.code).toBe(1);
    expect(res.err).toContain("Unknown option --yess");
  });

  it("asks for a way to sign in when there is no Azure CLI and no token", async () => {
    const dir = repo(); // git needs PATH, so create the repository first
    const saved = process.env.PATH;
    process.env.PATH = path.join(agents.home, "empty-path");
    fs.rmSync(path.join(env.home, "config.json"));
    try {
      const res = await kai(
        "integration",
        "azure",
        dir,
        "--yes",
        "--org",
        "Contoso",
        "--no-agents"
      );
      expect(res.code).toBe(1);
      expect(res.err).toContain("No Azure CLI was found and no token was provided");
      expect(res.err).toContain("--pat-stdin");
    } finally {
      process.env.PATH = saved;
    }
    expect(listAccounts()).toEqual([]);
  });

  it("asks an Azure DevOps Server for a token even when the Azure CLI is installed", async () => {
    const dir = repo();
    const bin = path.join(agents.home, "fake-bin");
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ["az", "az.cmd"]) fs.writeFileSync(path.join(bin, name), "");
    const saved = process.env.PATH;
    process.env.PATH = bin;
    fs.rmSync(path.join(env.home, "config.json"));
    try {
      const res = await kai(
        "integration",
        "azure",
        dir,
        "--yes",
        "--server-url",
        "https://tfs.corp.local/tfs/Col",
        "--no-agents"
      );
      expect(res.code).toBe(1);
      expect(res.err).toContain("Azure DevOps Server needs an access token");
      expect(res.err).toContain("--server-url <url> --pat-stdin");
    } finally {
      process.env.PATH = saved;
    }
    expect(listAccounts()).toEqual([]);
  });
});

describe("wireAgents", () => {
  it("wires an installed agent once, and says so the second time", async () => {
    const opts = {
      dir: repo(),
      yes: true,
      interactive: false,
      homeDir: agents.home,
      kaiBin: "/x/kai.js",
    };
    const first = await wireAgents(opts);
    // Other agents installed on the developer's machine may be wired too (into the temp home).
    expect(first.wired).toContain("claude");
    expect(first.failed).toEqual([]);
    expect(first.noneInstalled).toBe(false);
    const second = await wireAgents(opts);
    expect(second.wired).toEqual([]);
    expect(second.already).toContain("claude");
  });

  it("asks nothing and writes nothing when no agent is installed", async () => {
    const dir = repo();
    const saved = process.env.PATH;
    process.env.PATH = path.join(agents.home, "empty-path");
    try {
      const outcome = await wireAgents({
        dir,
        yes: true,
        interactive: false,
        homeDir: agents.home,
      });
      expect(outcome.noneInstalled).toBe(true);
    } finally {
      process.env.PATH = saved;
    }
    expect(fs.existsSync(claudeConfig())).toBe(false);
  });
});

describe("kai azure list", () => {
  beforeEach(() => {
    saveAccount({ ...azAccount("Contoso", "az"), user: "suraj@contoso.com" });
  });

  it("lists projects, marks the active one, and shows its repositories", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const res = await kai("azure", "list", dir);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Contoso · Azure CLI · suraj@contoso.com");
    const active = res.out.split("\n").filter((l) => /^\s*\* Payments/.test(l));
    expect(active).toHaveLength(1);
    expect(active[0]).toContain("api, ledger");
    expect(res.out).toContain("* = active for this folder (Payments / api)");
    // Other projects' repositories are not fetched unless asked.
    expect(res.out).not.toContain("infra");
  });

  it("expands every project's repositories with --repos", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const res = await kai("azure", "list", "--repos", dir);
    expect(res.out).toContain("infra");
    expect(res.out).toContain("(no repositories)");
  });

  it("prints JSON, with exactly one active project", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const body = JSON.parse((await kai("azure", "list", "--json", dir)).out);
    const projects = body.accounts[0].projects as Array<{
      name: string;
      active: boolean;
      repos?: string[];
    }>;
    expect(projects.filter((p) => p.active).map((p) => p.name)).toEqual(["Payments"]);
    expect(projects.find((p) => p.active)?.repos).toEqual(["api", "ledger"]);
  });

  it("keeps listing other accounts when one cannot be reached, and exits non-zero", async () => {
    saveAccount(azAccount("Fabrikam", "az"));
    setProviderForTests(
      "azure-devops",
      offlineAzure({
        discovery: {
          listProjects: async (account, secrets) => {
            if (account.org === "Fabrikam")
              throw new IntegrationError("auth", "The sign-in expired.");
            return fakeDiscovery.listProjects(account, secrets);
          },
          listRepos: fakeDiscovery.listRepos,
        },
      })
    );
    const res = await kai("azure", "list", repo(REMOTE));
    expect(res.code).toBe(1);
    expect(res.out).toContain("Could not list projects: The sign-in expired.");
    expect(res.out).toContain("Platform");
  });

  it("points at setup when nothing is signed in, and rejects an unknown --org", async () => {
    fs.writeFileSync(path.join(env.home, "config.json"), "{}");
    const none = await kai("azure", "list", repo());
    expect(none.code).toBe(0);
    expect(none.err).toContain("kai integration azure");
    saveAccount(azAccount("Contoso", "az"));
    expect((await kai("azure", "list", "--org", "nobody", repo())).code).toBe(1);
  });
});

describe("kai azure active", () => {
  beforeEach(() => {
    saveAccount(azAccount("Contoso", "az"));
  });

  it("switches by name, fixing the spelling, and keeps the repo that exists there", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const res = await kai("azure", "active", "--name", "platform", "--repo", "none", dir);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Active project is now Platform (Contoso).");
    expect(findBinding(dir)?.binding).toMatchObject({ project: "Platform", repo: null });
    const back = await kai("azure", "active", "--name", "PAYMENTS", dir);
    expect(back.out).toContain("Payments");
    expect(findBinding(dir)?.binding.project).toBe("Payments");
  });

  it("still accepts --project as another spelling of --name", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    expect((await kai("azure", "active", "--project", "Platform", dir)).code).toBe(0);
    expect(findBinding(dir)?.binding.project).toBe("Platform");
  });

  it("rejects a project that does not exist and keeps the active one", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const res = await kai("azure", "active", "--name", "Paymnts", dir);
    expect(res.code).toBe(1);
    expect(res.err).toContain('No project named "Paymnts"');
    expect(findBinding(dir)?.binding.project).toBe("Payments");
  });

  it("without a name and without a terminal, shows what is active and how to switch", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const res = await kai("azure", "active", dir);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Active for this folder: Payments / api (Contoso)");
    expect(res.out).toContain("kai azure active --name <project>");
    expect(res.out).toContain("kai azure list");
  });

  it("needs a sign-in, and an --org when several accounts are signed in", async () => {
    fs.writeFileSync(path.join(env.home, "config.json"), "{}");
    expect((await kai("azure", "active", repo())).err).toContain("kai integration azure");
    saveAccount(azAccount("Contoso", "az"));
    saveAccount(azAccount("Fabrikam", "az"));
    const ambiguous = await kai("azure", "active", "--name", "Payments", repo());
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain("Pass --org");
    const dir = repo();
    expect(
      (await kai("azure", "active", "--name", "Payments", "--org", "fabrikam", dir)).code
    ).toBe(0);
    expect(findBinding(dir)?.binding.account).toBe("azure-devops:fabrikam");
  });

  it("rejects a mistyped option", async () => {
    expect((await kai("azure", "active", "--nmae", "x", repo())).err).toContain(
      "Unknown option --nmae"
    );
  });
});

describe("kai azure remove / kai remove --name", () => {
  beforeEach(() => {
    saveAccount(azAccount("Contoso", "az"));
  });

  it("`kai azure remove` disconnects this folder and keeps the sign-in", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const res = await kai("azure", "remove", dir);
    expect(res.code).toBe(0);
    expect(res.out).toContain("stays signed in");
    expect(res.out).toContain("kai azure remove --name azure-devops:contoso");
    expect(findBinding(dir)).toBeNull();
    expect(getAccount("azure-devops:contoso")).not.toBeNull();
  });

  it("`kai remove azure` is the same disconnect", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    expect((await kai("remove", "azure", dir)).code).toBe(0);
    expect(findBinding(dir)).toBeNull();
  });

  it("removing from a folder that is not connected is harmless", async () => {
    const res = await kai("azure", "remove", repo());
    expect(res.code).toBe(0);
    expect(res.out).toContain("not connected");
  });

  it("`kai remove --name <id>` removes the account everywhere and disconnects every folder", async () => {
    const a = repo(REMOTE);
    const b = repo(REMOTE);
    bind("azure-devops", a);
    bind("azure-devops", b);

    // Without --yes and without a terminal it only shows what would go, then refuses.
    const preview = await kai("remove", "--name", "azure-devops:contoso");
    expect(preview.code).toBe(1);
    expect(preview.err).toContain("--yes");
    expect(preview.out).toContain("2 will be disconnected");
    // The folders are named by path, even though neither was ever indexed.
    expect(preview.out).toContain(a);
    expect(preview.out).toContain(b);
    expect(getAccount("azure-devops:contoso")).not.toBeNull();
    expect(findBinding(a)).not.toBeNull();

    const res = await kai("remove", "--name", "azure-devops:contoso", "--yes");
    expect(res.code).toBe(0);
    expect(res.out).toContain("disconnected 2 folders");
    expect(getAccount("azure-devops:contoso")).toBeNull();
    expect(findBinding(a)).toBeNull();
    expect(findBinding(b)).toBeNull();
  });

  it("accepts the organization name, and `kai azure remove --name` is the same thing", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    const res = await kai("azure", "remove", "--name", "contoso", "--yes");
    expect(res.code).toBe(0);
    expect(getAccount("azure-devops:contoso")).toBeNull();
    expect(findBinding(dir)).toBeNull();
  });

  it("will not remove an account without --yes when it cannot ask", async () => {
    const res = await kai("remove", "--name", "contoso");
    expect(res.code).toBe(1);
    expect(res.err).toContain("--yes");
    expect(getAccount("azure-devops:contoso")).not.toBeNull();
  });

  it("refuses an ambiguous name and lists the candidates", async () => {
    saveAccount({
      ...azAccount("contoso", "pat"),
      id: "azure-devops:tfs.corp/contoso",
      baseUrl: "https://tfs.corp/contoso",
    });
    const res = await kai("remove", "--name", "contoso", "--yes");
    expect(res.code).toBe(1);
    expect(res.err).toContain("more than one account");
    expect(res.err).toContain("azure-devops:tfs.corp/contoso");
    expect(listAccounts()).toHaveLength(2);
  });

  it("names the accounts that exist when the name matches nothing", async () => {
    const res = await kai("remove", "--name", "nobody", "--yes");
    expect(res.code).toBe(1);
    expect(res.err).toContain('No account or integration named "nobody"');
    expect(res.err).toContain("azure-devops:contoso");
  });

  it("`kai remove --name azure` (an integration, not an account) disconnects this folder", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    // No account is called "azure", so the integration's name disconnects the folder.
    expect((await kai("remove", "--name", "azure", dir)).code).toBe(0);
    expect(findBinding(dir)).toBeNull();
    expect(getAccount("azure-devops:contoso")).not.toBeNull();
  });

  it("does not disturb the existing remove flags", async () => {
    expect((await kai("remove", "-m")).err).toContain("Please specify an agent name");
    const usage = await kai("remove");
    expect(usage.code).toBe(1);
    expect(usage.err).toContain("kai remove --name <account-id>");
  });
});

describe("kai azure --help", () => {
  it("documents the whole command set", async () => {
    const res = await kai("azure", "--help");
    for (const line of [
      "kai integration azure",
      "kai azure list",
      "kai azure active --name",
      "kai azure remove",
      "kai remove --name",
    ]) {
      expect(res.out).toContain(line);
    }
    expect(res.out).not.toContain("login");
  });

  it("rejects commands that no longer exist", async () => {
    for (const sub of ["login", "logout", "status"]) {
      const res = await kai("azure", sub);
      expect(res.code, sub).toBe(1);
      expect(res.err).toContain("Unknown command");
    }
  });
});

describe("kai azure: --dry-run is gone", () => {
  beforeEach(() => {
    saveAccount(azAccount("Contoso", "az"));
  });

  it("is rejected rather than silently ignored, and nothing is removed", async () => {
    const dir = repo(REMOTE);
    bind("azure-devops", dir);
    for (const args of [
      ["azure", "remove", "--dry-run", dir],
      ["remove", "azure", "--dry-run", dir],
      ["remove", "--name", "contoso", "--dry-run"],
    ]) {
      const res = await kai(...args);
      expect(res.code, args.join(" ")).toBe(1);
      expect(res.err).toContain("Unknown option --dry-run");
    }
    expect(findBinding(dir)).not.toBeNull();
    expect(getAccount("azure-devops:contoso")).not.toBeNull();
  });

  it("is not advertised", async () => {
    expect((await kai("azure", "--help")).out).not.toContain("dry-run");
    expect((await kai("remove")).err).not.toMatch(/azure[^\n]*dry-run/);
  });
});

describe("project auto-detection", () => {
  const ONPREM = "https://tfs.corp.local/tfs/DefaultCollection/Billing/_git/ledger";

  it("sets up a folder cloned from an Azure DevOps Server, from its https remote alone", async () => {
    saveAccount({
      ...azAccount("DefaultCollection", "az"),
      id: "azure-devops:tfs.corp.local/tfs/defaultcollection",
      baseUrl: "https://tfs.corp.local/tfs/DefaultCollection",
    });
    setProviderForTests(
      "azure-devops",
      offlineAzure({
        discovery: {
          listProjects: async () => [{ name: "Billing" }, { name: "Other" }],
          listRepos: async () => [{ name: "ledger" }],
        },
      })
    );
    const dir = repo(ONPREM);
    const res = await kai("integration", "azure", dir, "--yes", "--no-agents");
    expect(res.code).toBe(0);
    expect(res.out).toContain(
      "DefaultCollection / Billing / ledger   (from the git remote, verified)"
    );
    expect(findBinding(dir)?.binding).toMatchObject({
      account: "azure-devops:tfs.corp.local/tfs/defaultcollection",
      project: "Billing",
      repo: "ledger",
    });
  });

  it("treats the same organization spelled four ways as one account", async () => {
    saveAccount(azAccount("Contoso", "az"));
    for (const remote of [
      "https://dev.azure.com/Contoso/Payments/_git/api",
      "https://Contoso@dev.azure.com/contoso/Payments/_git/api",
      "https://contoso.visualstudio.com/Payments/_git/api",
      "git@ssh.dev.azure.com:v3/Contoso/Payments/api",
    ]) {
      const dir = repo(remote);
      const res = await kai("integration", "azure", dir, "--yes", "--no-agents");
      expect(res.code, remote).toBe(0);
      expect(findBinding(dir)?.binding.account, remote).toBe("azure-devops:contoso");
    }
    expect(listAccounts()).toHaveLength(1);
  });

  it("tolerates a trailing .git on the remote", async () => {
    saveAccount(azAccount("Contoso", "az"));
    const dir = repo("https://dev.azure.com/Contoso/Payments/_git/api.git");
    expect((await kai("integration", "azure", dir, "--yes", "--no-agents")).code).toBe(0);
    expect(findBinding(dir)?.binding.repo).toBe("api");
  });

  it("with several Azure remotes uses origin's, says so, and lets --project choose another", async () => {
    saveAccount(azAccount("Contoso", "az"));
    const dir = repo(REMOTE);
    execFileSync(
      "git",
      ["-C", dir, "remote", "add", "mirror", "https://dev.azure.com/Contoso/Platform/_git/infra"],
      {
        stdio: "ignore",
      }
    );
    const res = await kai("integration", "azure", dir, "--yes", "--no-agents");
    expect(res.code).toBe(0);
    expect(res.out).toContain(
      "this folder has 2 Azure DevOps remotes; using Contoso / Payments / api"
    );
    expect(res.out).toContain("Contoso / Platform / infra");
    expect(findBinding(dir)?.binding.project).toBe("Payments");
  });

  it("finds the project from a sub-folder of the repository", async () => {
    saveAccount(azAccount("Contoso", "az"));
    const dir = repo(REMOTE);
    const sub = path.join(dir, "packages", "web");
    fs.mkdirSync(sub, { recursive: true });
    const res = await kai("integration", "azure", sub, "--yes", "--no-agents");
    expect(res.code).toBe(0);
    // The connection belongs to the repository, so the whole repo is connected.
    expect(findBinding(dir)?.binding.project).toBe("Payments");
  });

  it("does not pair the remote's project with a different --org", async () => {
    saveAccount(azAccount("Contoso", "az"));
    saveAccount(azAccount("Fabrikam", "az"));
    const dir = repo(REMOTE); // the remote is in Contoso
    const res = await kai("integration", "azure", dir, "--yes", "--no-agents", "--org", "Fabrikam");
    // Fabrikam has no project taken from a Contoso remote: nothing to go on, and nobody to ask.
    expect(res.code).toBe(1);
    expect(res.err).toContain("--project");
    expect(findBinding(dir)).toBeNull();
  });
});
