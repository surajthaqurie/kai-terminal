import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../cli/index";
import { findBinding, listAccounts, saveAccount } from "../core/integrations/config";
import { setProviderForTests } from "../core/integrations/providers";
import { bind } from "../core/integrations/service";
import { IntegrationError, type IntegrationProvider } from "../core/integrations/types";
import {
  azAccount,
  makeRepo,
  offlineAzure,
  useFakeAgents,
  useTempKaiHome,
} from "./helpers/integrationsEnv";

// The agent check and the terminal are the two things a test cannot be: stand in for both.
const hoisted = vi.hoisted(() => ({
  agent: { refuse: false },
  term: {
    interactive: false,
    answers: [] as boolean[],
    typed: [] as string[],
    hidden: null as string | null,
  },
}));

vi.mock("../core/teams/guard", async (original) => {
  const real = await original<typeof import("../core/teams/guard")>();
  return {
    ...real,
    assertNotAgentSessionFor: async () => {
      if (hoisted.agent.refuse) {
        throw new IntegrationError(
          "forbidden",
          "Turning on write tools is not available inside an AI agent's session (Claude Code is running this command).",
          "Open a normal terminal tab."
        );
      }
    },
  };
});

vi.mock("../cli/prompt", async (original) => {
  const real = await original<typeof import("../cli/prompt")>();
  return {
    ...real,
    isInteractive: () => hoisted.term.interactive,
    confirm: async () => hoisted.term.answers.shift() ?? false,
    ask: async () => hoisted.term.typed.shift() ?? "",
    askHidden: async () => hoisted.term.hidden,
  };
});

const REMOTE = "https://dev.azure.com/Contoso/Payments/_git/api";
const SSH_REMOTE = "alice@tfs.corp.local:tfs/DefaultCollection/Billing/_git/ledger";
const SERVER_ACCOUNT_ID = "azure-devops:tfs.corp.local/tfs/defaultcollection";

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

/** The offline provider, plus write methods that only record what they were asked. */
function writableAzure(over: Partial<IntegrationProvider> = {}): IntegrationProvider {
  const base = offlineAzure();
  return offlineAzure({
    workItems: {
      ...base.workItems!,
      addComment: async (_c, id) => ({ workItemId: id, url: "u" }),
      setState: async (_c, id, state) => ({ workItemId: id, state, url: "u" }),
    },
    pullRequests: {
      ...base.pullRequests!,
      create: async () => {
        throw new Error("not used");
      },
      addComment: async (_c, i) => ({ pullRequestId: i.id, url: "u" }),
    },
    ...over,
  });
}

beforeEach(() => {
  env = useTempKaiHome();
  agents = useFakeAgents(["claude"]);
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  setProviderForTests("azure-devops", writableAzure());
  hoisted.agent.refuse = false;
  hoisted.term.interactive = false;
  hoisted.term.answers = [];
  hoisted.term.typed = [];
  hoisted.term.hidden = null;
  saveAccount(azAccount("Contoso", "az"));
});

afterEach(() => {
  vi.restoreAllMocks();
  setProviderForTests("azure-devops", null);
  cleanups.splice(0).forEach((c) => c());
  agents.restore();
  env.restore();
});

function connected(): string {
  const dir = repo(REMOTE);
  bind("azure-devops", dir);
  return dir;
}

describe("kai integration azure: merge branch and branch naming", () => {
  it("sets both, stores only what differs from the default, and says it is guidance", async () => {
    const dir = connected();
    const res = await kai(
      "integration",
      "azure",
      dir,
      "--merge-branch",
      "main",
      "--branch-pattern",
      "^feature/[0-9]+-[a-z-]+$"
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain("Merge branch: main");
    expect(res.out).toContain("Branch naming: ^feature/[0-9]+-[a-z-]+$");
    expect(res.out).toContain("Kai does not enforce it");
    expect(res.out).not.toContain("Tip:");
    expect(findBinding(dir)!.binding.rules).toEqual({
      mergeBranch: "main",
      branchPattern: "^feature/[0-9]+-[a-z-]+$",
    });
  });

  it("changes one setting without touching the other, and clears each on its own", async () => {
    const dir = connected();
    await kai(
      "integration",
      "azure",
      dir,
      "--merge-branch",
      "main",
      "--branch-pattern",
      "^fix/[a-z]+$"
    );
    await kai("integration", "azure", dir, "--branch-pattern", "^bug/[a-z]+$");
    expect(findBinding(dir)!.binding.rules).toEqual({
      mergeBranch: "main",
      branchPattern: "^bug/[a-z]+$",
    });
    const cleared = await kai("integration", "azure", dir, "--clear-branch-pattern");
    expect(cleared.out).toContain("Branch naming: none");
    expect(findBinding(dir)!.binding.rules).toEqual({ mergeBranch: "main" });
    await kai("integration", "azure", dir, "--clear-merge-branch");
    expect(findBinding(dir)!.binding.rules).toBeUndefined();
  });

  it("gives the same plain reason as the desktop for a bad pattern, and stores nothing", async () => {
    const dir = connected();
    const res = await kai("integration", "azure", dir, "--branch-pattern", "^feature/(a+)+$");
    expect(res.code).toBe(1);
    expect(res.err).toContain("repeats a repeat");
    const slashes = await kai("integration", "azure", dir, "--branch-pattern", "/^feature$/i");
    expect(slashes.err).toContain("without the slashes");
    expect(findBinding(dir)!.binding.rules).toBeUndefined();
  });

  it("only tips about a pattern with no anchors", async () => {
    const dir = connected();
    const res = await kai("integration", "azure", dir, "--branch-pattern", "feature/[a-z]+");
    expect(res.code).toBe(0);
    expect(res.out).toContain("Tip: start with ^ and end with $");
    expect(findBinding(dir)!.binding.rules?.branchPattern).toBe("feature/[a-z]+");
  });

  it("refuses a merge branch the repository does not have", async () => {
    const dir = connected();
    const res = await kai("integration", "azure", dir, "--merge-branch", "nope");
    expect(res.code).toBe(1);
    expect(res.err).toContain('no branch named "nope"');
    expect(findBinding(dir)!.binding.rules).toBeUndefined();
  });

  it("accepts a typed branch when the repository cannot be reached", async () => {
    const dir = connected();
    setProviderForTests(
      "azure-devops",
      writableAzure({
        discovery: {
          listProjects: async () => [],
          listRepos: async () => [],
          listBranches: async () => {
            throw new IntegrationError("network", "offline");
          },
        },
      })
    );
    const res = await kai("integration", "azure", dir, "--merge-branch", "develop");
    expect(res.code).toBe(0);
    expect(findBinding(dir)!.binding.rules?.mergeBranch).toBe("develop");
  });

  it("needs a value, rejects contradictions, and is not mixed with connecting", async () => {
    const dir = connected();
    const noValue = await kai("integration", "azure", dir, "--merge-branch");
    expect(noValue.code).toBe(1);
    expect(noValue.err).toContain("--merge-branch needs a branch name");
    expect(noValue.err).toContain("--clear-merge-branch");
    expect((await kai("integration", "azure", dir, "--branch-pattern")).err).toContain(
      "--branch-pattern needs a regular expression"
    );
    expect(
      (await kai("integration", "azure", dir, "--merge-branch", "main", "--clear-merge-branch")).err
    ).toContain("either --merge-branch or --clear-merge-branch");
    expect(
      (await kai("integration", "azure", dir, "--branch-pattern", "^a$", "--clear-branch-pattern"))
        .err
    ).toContain("either --branch-pattern or --clear-branch-pattern");
    const mixed = await kai(
      "integration",
      "azure",
      dir,
      "--org",
      "Contoso",
      "--merge-branch",
      "main"
    );
    expect(mixed.code).toBe(1);
    expect(mixed.err).toContain("Run them as two commands");
    expect(findBinding(dir)!.binding.rules).toBeUndefined();
  });

  it("needs a connected folder", async () => {
    const dir = repo(REMOTE);
    const res = await kai("integration", "azure", dir, "--merge-branch", "main");
    expect(res.code).toBe(1);
    expect(res.err).toContain("This folder is not connected to Azure DevOps");
    expect(res.err).toContain("kai integration azure");
    expect(findBinding(dir)).toBeNull();
  });

  it("does not sign in, wire agents or touch the connection", async () => {
    const dir = connected();
    const before = fs.readFileSync(path.join(env.home, "config.json"), "utf8");
    const res = await kai("integration", "azure", dir, "--merge-branch", "main");
    expect(res.out).not.toContain("Sign-in");
    expect(res.out).not.toContain("wired");
    expect(fs.existsSync(path.join(agents.home, ".claude.json"))).toBe(false);
    expect(fs.readFileSync(path.join(env.home, "config.json"), "utf8")).toBe(before);
  });
});

describe("kai integration azure: write tools", () => {
  it("is off until the user asks, and lists nothing about writing", async () => {
    const dir = connected();
    const list = await kai("integration", "list", dir);
    expect(list.out).not.toContain("write tools on");
    expect(findBinding(dir)!.binding.writeTools).toBeUndefined();
  });

  it("--allow-writes --yes turns them on, and --no-writes turns them off", async () => {
    const dir = connected();
    const on = await kai("integration", "azure", dir, "--allow-writes", "--yes");
    expect(on.code).toBe(0);
    expect(on.out).toContain("Write tools: on");
    expect(on.out).toContain("kai integration azure --no-writes");
    expect(findBinding(dir)!.binding.writeTools).toBe(true);
    expect((await kai("integration", "list", dir)).out).toContain("write tools on");

    const off = await kai("integration", "azure", dir, "--no-writes");
    expect(off.code).toBe(0);
    expect(off.out).toContain("Write tools: off");
    expect(findBinding(dir)!.binding.writeTools).toBeUndefined();
  });

  it("explains what it allows and asks first in a terminal", async () => {
    const dir = connected();
    hoisted.term.interactive = true;
    hoisted.term.answers = [true];
    const res = await kai("integration", "azure", dir, "--allow-writes");
    expect(res.out).toContain("change data in Azure DevOps through Kai, as you");
    expect(res.out).toContain("cannot create branches, merge, delete");
    expect(res.out).toContain("Work Items and Code: Read & write");
    expect(findBinding(dir)!.binding.writeTools).toBe(true);
  });

  it("changes nothing when the question is answered no", async () => {
    const dir = connected();
    hoisted.term.interactive = true;
    hoisted.term.answers = [false];
    const res = await kai("integration", "azure", dir, "--allow-writes");
    expect(res.code).toBe(1);
    expect(res.out).toContain("Nothing changed");
    expect(findBinding(dir)!.binding.writeTools).toBeUndefined();
  });

  it("will not turn writes on without a person or --yes", async () => {
    const dir = connected();
    const res = await kai("integration", "azure", dir, "--allow-writes");
    expect(res.code).toBe(1);
    expect(res.err).toContain("needs your confirmation");
    expect(res.err).toContain("--yes");
    expect(findBinding(dir)!.binding.writeTools).toBeUndefined();
  });

  it("is refused inside an AI agent's session, even with --yes", async () => {
    const dir = connected();
    hoisted.agent.refuse = true;
    const res = await kai("integration", "azure", dir, "--allow-writes", "--yes");
    expect(res.code).toBe(1);
    expect(res.err).toContain("not available inside an AI agent's session");
    expect(findBinding(dir)!.binding.writeTools).toBeUndefined();
  });

  it("turning writes off still works inside an agent's session", async () => {
    const dir = connected();
    await kai("integration", "azure", dir, "--allow-writes", "--yes");
    hoisted.agent.refuse = true;
    const res = await kai("integration", "azure", dir, "--no-writes");
    expect(res.code).toBe(0);
    expect(findBinding(dir)!.binding.writeTools).toBeUndefined();
  });

  it("says so when the integration has no write tools", async () => {
    const dir = connected();
    setProviderForTests("azure-devops", offlineAzure());
    const res = await kai("integration", "azure", dir, "--allow-writes", "--yes");
    expect(res.code).toBe(1);
    expect(res.err).toContain("has no write tools");
  });

  it("cannot be combined with its opposite", async () => {
    const dir = connected();
    const res = await kai("integration", "azure", dir, "--allow-writes", "--no-writes", "--yes");
    expect(res.code).toBe(1);
    expect(res.err).toContain("either --allow-writes or --no-writes");
  });

  it("can be set together with the rules in one command", async () => {
    const dir = connected();
    const res = await kai(
      "integration",
      "azure",
      dir,
      "--merge-branch",
      "main",
      "--allow-writes",
      "--yes"
    );
    expect(res.code).toBe(0);
    expect(findBinding(dir)!.binding).toMatchObject({
      writeTools: true,
      rules: { mergeBranch: "main" },
    });
  });
});

describe("kai integration azure: a Server SSH remote", () => {
  const discoveryFor = (): IntegrationProvider["discovery"] => ({
    listProjects: async () => [{ name: "Billing" }],
    listRepos: async () => [{ name: "ledger" }],
    listBranches: async () => ["main"],
  });

  it("does not sign in to a guessed address when it cannot ask, and shows the command to run", async () => {
    const dir = repo(SSH_REMOTE);
    const res = await kai("integration", "azure", dir, "--yes", "--no-agents");
    expect(res.code).toBe(1);
    expect(res.err).toContain("SSH does not say the web address");
    expect(res.err).toContain("https://tfs.corp.local/tfs/DefaultCollection");
    expect(res.err).toContain(
      'kai integration azure --server-url https://tfs.corp.local/tfs/DefaultCollection --project "Billing" --repo "ledger" --pat-stdin'
    );
    expect(listAccounts("azure-devops").map((a) => a.id)).toEqual(["azure-devops:contoso"]);
    expect(findBinding(dir)).toBeNull();
  });

  it("goes on without asking when the person is already signed in to exactly that address", async () => {
    setProviderForTests("azure-devops", writableAzure({ discovery: discoveryFor() }));
    saveAccount({
      id: SERVER_ACCOUNT_ID,
      provider: "azure-devops",
      org: "DefaultCollection",
      baseUrl: "https://tfs.corp.local/tfs/DefaultCollection",
      authMethod: "az",
      apiVersion: "7.0",
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    const dir = repo(SSH_REMOTE);
    const res = await kai("integration", "azure", dir, "--yes", "--no-agents");
    expect(res.out).toContain("you are already signed in there");
    expect(res.code).toBe(0);
    expect(findBinding(dir)!.binding).toMatchObject({
      account: SERVER_ACCOUNT_ID,
      project: "Billing",
      repo: "ledger",
    });
  });

  it("an address typed with --server-url is the person's own word: no question, project from the remote", async () => {
    setProviderForTests("azure-devops", writableAzure({ discovery: discoveryFor() }));
    saveAccount({
      id: SERVER_ACCOUNT_ID,
      provider: "azure-devops",
      org: "DefaultCollection",
      baseUrl: "https://tfs.corp.local/tfs/DefaultCollection",
      authMethod: "az",
      apiVersion: "7.0",
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    const dir = repo(SSH_REMOTE);
    const res = await kai(
      "integration",
      "azure",
      dir,
      "--yes",
      "--no-agents",
      "--server-url",
      "https://tfs.corp.local/tfs/DefaultCollection"
    );
    expect(res.code).toBe(0);
    expect(res.out).not.toContain("SSH does not say");
    expect(findBinding(dir)!.binding).toMatchObject({ project: "Billing", repo: "ledger" });
  });

  it("asks in a terminal, and signing in only starts after the guess is confirmed", async () => {
    const dir = repo(SSH_REMOTE);
    hoisted.term.interactive = true;
    hoisted.term.answers = [true];
    hoisted.term.hidden = null; // the token prompt is cancelled: nothing is sent anywhere
    const res = await kai("integration", "azure", dir, "--no-agents");
    expect(res.out).toContain("Kai's guess: https://tfs.corp.local/tfs/DefaultCollection");
    expect(res.out).toContain("Azure DevOps Server signs in with an access token");
    expect(res.err).toContain("Cancelled.");
    expect(listAccounts("azure-devops").map((a) => a.id)).toEqual(["azure-devops:contoso"]);
  });

  it("takes a typed address when the guess is declined, and stops when none is given", async () => {
    const dir = repo(SSH_REMOTE);
    hoisted.term.interactive = true;
    hoisted.term.answers = [false];
    hoisted.term.typed = [""];
    const stopped = await kai("integration", "azure", dir, "--no-agents");
    expect(stopped.code).toBe(1);
    expect(stopped.err).toContain("Cancelled.");

    hoisted.term.answers = [false];
    hoisted.term.typed = ["https://tfs.corp.local/DefaultCollection"];
    hoisted.term.hidden = null;
    const typed = await kai("integration", "azure", dir, "--no-agents");
    expect(typed.out).toContain("Not signed in to DefaultCollection yet");
    expect(typed.err).toContain("Cancelled.");
  });
});
