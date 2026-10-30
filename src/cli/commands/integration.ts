import { spawn } from "child_process";
import { applyAgentSetup, detectInstalledAgentsSync } from "../../core/agents";
import { getAccount, listAccounts } from "../../core/integrations/config";
import {
  findProvider,
  PROVIDER_CATALOG,
  type ProviderInfo,
} from "../../core/integrations/providerCatalog";
import { getProvider } from "../../core/integrations/providers";
import { azCliOnPath, isCloudBaseUrl } from "../../core/integrations/providers/azure-devops/auth";
import type { DetectedCoordinates, IntegrationStatusView } from "../../core/integrations/rpcTypes";
import {
  accountIdFor,
  bind,
  checkAccess,
  detectAllCoordinates,
  getStatus,
  login,
  resolveSwitch,
  verifyAccount,
  type AccessCheck,
} from "../../core/integrations/service";
import { integrationToolDefs } from "../../core/integrations/tools";
import {
  IntegrationError,
  type IntegrationAccount,
  type IntegrationProvider,
} from "../../core/integrations/types";
import { resolveKaiBin } from "../agentWorkflow";
import { ask, askHidden, confirm, isInteractive, readAllStdin } from "../prompt";
import {
  assertKnownFlags,
  authLabel,
  fail,
  flagValue,
  parseFlags,
  pickProjectAndRepo,
  projectDirFrom,
  where,
  withReplace,
  type Flags,
} from "./integrationShared";

/**
 * `kai integration list` and `kai integration <provider>`: the one place a
 * user sets an integration up. Sign in, connect this folder, wire Kai's MCP
 * server into the user's agents, and prove it works with real calls.
 */

function printHelp(): void {
  const names = PROVIDER_CATALOG.map((p) => p.aliases[0] ?? p.id).join("|");
  console.log(`
Kai integrations

Usage:
  kai integration list               Every integration and its state
  kai integration <${names}>         Set one up for THIS folder: sign in, connect the
                                     project, select your agents, and verify it works

Steps:
  1. Sign-in     Authenticate with organization
  2. Scope       Select organization, project, and repository
  3. Agents      Select agents to configure (default: all)
  4. Check       Verify tool access with live API checks

Options for \`kai integration azure\`:
  --org <name>          Organization (default: from the git remote)
  --project <name>      Project (default: from the git remote, or you pick one)
  --repo <name|none>    Repository (default: from the git remote)
  --pat-stdin           Pipe an access token on stdin
  --server-url <url>    Azure DevOps Server (on-premises; signs in with --pat-stdin)
  --no-agents           Do not touch any agent's config
  -y, --yes             Do not ask for confirmation

It is safe to run again: it checks the saved sign-in and only asks what is missing.
Then: kai azure list | kai azure active --name <project> | kai azure remove
`);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

type ListState = "active" | "needs_sign_in" | "signed_in" | "elsewhere" | "not_set_up";

function stateOf(s: IntegrationStatusView): ListState {
  if (s.project.otherProvider) return "elsewhere";
  if (s.project.state === "ready") return "active";
  if (s.project.state === "signed_out" || s.project.state === "account_missing") {
    return "needs_sign_in";
  }
  return s.accounts.length > 0 ? "signed_in" : "not_set_up";
}

const STATE_TEXT: Record<ListState, string> = {
  active: "● active here",
  needs_sign_in: "! sign-in needed",
  signed_in: "○ signed in, not used here",
  elsewhere: "○ another integration is active here",
  not_set_up: "○ not set up",
};

async function runList(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  assertKnownFlags(flags, ["--json"]);
  const dir = projectDirFrom(flags);
  const rows: Array<{ info: ProviderInfo; status: IntegrationStatusView }> = [];
  for (const info of PROVIDER_CATALOG) {
    rows.push({ info, status: await getStatus(info.id, dir) });
  }
  if (flags.bool.has("--json")) {
    console.log(
      JSON.stringify(
        rows.map(({ info, status }) => ({ id: info.id, state: stateOf(status), status })),
        null,
        2
      )
    );
    return 0;
  }
  console.log(`Integrations  (folder: ${rows[0]?.status.project.dir ?? dir})\n`);
  for (const { info, status } of rows) {
    const state = stateOf(status);
    const alias = (info.aliases[0] ?? info.id).padEnd(8);
    console.log(`  ${alias} ${info.label.padEnd(14)} ${STATE_TEXT[state]}`);
    const b = status.project.binding;
    if (b) console.log(`  ${" ".repeat(8)} ${" ".repeat(14)} ${b.account} · ${where(b)}`);
    for (const a of status.accounts) {
      const flag = a.hasCredential ? "" : "  (token missing)";
      console.log(
        `  ${" ".repeat(8)} ${" ".repeat(14)} account ${a.org} · ${authLabel(a.authMethod)}${a.user ? ` · ${a.user}` : ""}${flag}`
      );
    }
    const alias0 = info.aliases[0] ?? info.id;
    if (state === "not_set_up" || state === "signed_in" || state === "needs_sign_in") {
      const d = status.project.detected;
      console.log(
        `  ${" ".repeat(8)} ${" ".repeat(14)} → kai integration ${alias0}${d ? `   (remote: ${d.org} / ${d.project})` : ""}`
      );
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// sign-in
// ---------------------------------------------------------------------------

/** Run `az login` in the user's terminal so they can sign in without leaving this command. */
function runAzLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ["login"];
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/s", "/c", "az", ...args], { stdio: "inherit" })
        : spawn("az", args, { stdio: "inherit" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

interface SignInPlan {
  org?: string;
  baseUrl?: string;
}

/** Sign in (or sign in again) and return the saved account. */
async function signIn(
  info: ProviderInfo,
  plan: SignInPlan,
  flags: Flags
): Promise<IntegrationAccount> {
  // Azure DevOps Server does not accept the Entra tokens the Azure CLI issues, so it defaults to a token.
  const isServer = !isCloudBaseUrl(
    getProvider(info.id)!.buildAccount({ ...plan, authMethod: "az" }).baseUrl
  );
  let authMethod: "az" | "pat";
  if (flags.bool.has("--pat-stdin")) authMethod = "pat";
  else if (flags.bool.has("--az")) authMethod = "az";
  else authMethod = azCliOnPath() && !isServer ? "az" : "pat";

  let pat: string | undefined;
  if (authMethod === "pat") {
    if (flags.bool.has("--pat-stdin")) {
      pat = (await readAllStdin()).trim();
    } else if (isInteractive()) {
      console.log(
        `  ${isServer ? "Azure DevOps Server signs in with an access token" : "The Azure CLI was not found. Use an access token instead"} (needs Work Items, Code and Build: read).`
      );
      const entered = await askHidden(`  Access token (input hidden): `);
      if (entered === null) throw new IntegrationError("bad_request", "Cancelled.");
      pat = entered.trim();
    } else {
      throw new IntegrationError(
        "bad_request",
        isServer
          ? "Azure DevOps Server needs an access token and none was provided."
          : "No Azure CLI was found and no token was provided.",
        `Pipe a token in: kai integration ${info.aliases[0]} ${isServer ? "--server-url <url>" : "--org <org>"} --pat-stdin`
      );
    }
  }

  const attempt = () => login(info.id, { org: plan.org, baseUrl: plan.baseUrl, authMethod, pat });
  let result;
  try {
    result = await attempt();
  } catch (err) {
    // Azure CLI installed but signed out: offer to run `az login` right here.
    const signedOutCli =
      authMethod === "az" && err instanceof IntegrationError && err.code === "auth";
    if (!(signedOutCli && isInteractive() && !flags.bool.has("--yes"))) throw err;
    console.log(`  ${err.message}`);
    if (!(await confirm("  Run `az login` now?", true))) throw err;
    if (!(await runAzLogin())) {
      throw new IntegrationError(
        "auth",
        "`az login` did not finish.",
        "Run `az login`, then retry."
      );
    }
    result = await attempt();
  }
  const saved = getAccount(result.account.id);
  if (!saved) throw new IntegrationError("config", "The account was not saved.");
  if (result.storedIn === "file") {
    console.log(
      `  Note: no OS secret store was available, so the token is kept in a private file under ~/.kai/credentials.`
    );
  }
  return saved;
}

/** The account for this setup: reuse a working sign-in, or sign in. */
async function ensureAccount(
  info: ProviderInfo,
  flags: Flags,
  detected: DetectedCoordinates | null
): Promise<IntegrationAccount> {
  const provider = getProvider(info.id)!;
  const serverUrl = flagValue(flags, "--server-url");
  const orgFlag = flagValue(flags, "--org");
  const accounts = listAccounts(info.id);

  // Which account: what was typed, else what the git remote belongs to, else the only one.
  let plan: SignInPlan;
  if (serverUrl) plan = { baseUrl: serverUrl };
  else if (orgFlag) plan = { org: orgFlag };
  else if (detected) plan = { org: detected.org, baseUrl: detected.baseUrl };
  else if (accounts.length === 1) plan = { org: accounts[0].org, baseUrl: accounts[0].baseUrl };
  else if (isInteractive()) {
    plan = { org: (await ask(`  Organization (dev.azure.com/<name>): `)).trim() };
  } else {
    throw new IntegrationError(
      "bad_request",
      "Which organization?",
      "Pass --org <name> (the part after dev.azure.com/), or run this inside a repository cloned from it."
    );
  }
  const id = provider.buildAccount({ ...plan, authMethod: "az" }).id;
  const existing = getAccount(id);

  if (existing) {
    try {
      const user = await verifyAccount(existing.id);
      console.log(
        `  ✔ Signed in to ${existing.org} as ${user.email ?? user.name} (${authLabel(existing.authMethod)})`
      );
      return existing;
    } catch (err) {
      if (!(err instanceof IntegrationError) || err.code !== "auth") throw err;
      console.log(`  ! The saved sign-in no longer works: ${err.message}`);
    }
  } else {
    console.log(`  Not signed in to ${plan.org ?? plan.baseUrl} yet.`);
  }
  const account = await signIn(info, plan, flags);
  console.log(
    `  ✔ Signed in to ${account.org} as ${account.user ?? "you"} (${authLabel(account.authMethod)})`
  );
  return account;
}

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

export interface WireOptions {
  dir: string;
  yes: boolean;
  interactive: boolean;
  /** Test seam: where agents' config files live. */
  homeDir?: string;
  /** Test seam: the command written into agent configs. */
  kaiBin?: string;
}

export interface WireOutcome {
  wired: string[];
  already: string[];
  failed: Array<{ id: string; message: string }>;
  /** True when the user was asked and said no. */
  declined: boolean;
  /** True when no supported agent was found on this machine. */
  noneInstalled: boolean;
}

/**
 * Wire Kai's MCP server into every installed agent that does not have it yet
 * (the same probe and writer as `kai mcp all`: PATH-detected agents only, a
 * backup of any config it changes, unrelated keys untouched).
 */
export async function wireAgents(opts: WireOptions): Promise<WireOutcome> {
  const detected = detectInstalledAgentsSync({ projectDir: opts.dir, homeDir: opts.homeDir });
  const installed = detected.filter((d) => d.binaryFound);
  const out: WireOutcome = {
    wired: [],
    already: installed.filter((d) => d.kaiWired).map((d) => d.id),
    failed: [],
    declined: false,
    noneInstalled: installed.length === 0,
  };
  const todo = installed.filter((d) => !d.kaiWired);
  if (todo.length === 0) return out;

  let targets = todo;
  if (opts.interactive && !opts.yes) {
    console.log(`  Detected installed agents:`);
    todo.forEach((d, i) => console.log(`    ${i + 1}. ${d.name} (${d.id})`));
    const answer = (
      await ask(`  Which agents to wire? (Enter for all, or comma-separated numbers/ids): `)
    ).trim();
    if (answer.toLowerCase() === "none" || answer.toLowerCase() === "n") {
      out.declined = true;
      return out;
    }
    if (
      answer &&
      answer.toLowerCase() !== "all" &&
      answer.toLowerCase() !== "y" &&
      answer.toLowerCase() !== "yes"
    ) {
      const parts = answer.split(",").map((s) => s.trim().toLowerCase());
      targets = todo.filter(
        (d, i) => parts.includes(String(i + 1)) || parts.includes(d.id.toLowerCase())
      );
    }
  }
  const kaiBin = opts.kaiBin ?? resolveKaiBin();
  for (const d of targets) {
    const r = applyAgentSetup(d.id, kaiBin, {
      projectDir: opts.dir,
      homeDir: opts.homeDir,
      scope: "auto",
    });
    if (r.wrote) out.wired.push(d.id);
    else if (r.alreadyConfigured) out.already.push(d.id);
    else out.failed.push({ id: d.id, message: r.message });
  }
  return out;
}

function printWire(outcome: WireOutcome): void {
  if (outcome.noneInstalled) {
    console.log(`  – No supported AI agent was found on PATH.`);
    console.log(`    Install one, then run \`kai mcp <agent>\` (see \`kai mcp list\`).`);
    return;
  }
  for (const id of outcome.wired) console.log(`  ✔ ${id.padEnd(10)} wired`);
  for (const id of outcome.already) console.log(`  = ${id.padEnd(10)} already wired`);
  for (const f of outcome.failed) console.log(`  ✖ ${f.id.padEnd(10)} ${f.message}`);
  if (outcome.declined)
    console.log(`  – Skipped. Run \`kai mcp all\` whenever you want to wire them.`);
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

const CAPABILITY_LABEL: Record<AccessCheck["capability"], string> = {
  "work-items": "Work items",
  "pull-requests": "Pull requests",
  builds: "Builds",
};

function printChecks(checks: AccessCheck[]): number {
  let failed = 0;
  for (const c of checks) {
    const label = CAPABILITY_LABEL[c.capability].padEnd(14);
    if (c.ok) console.log(`  ✔ ${label} readable`);
    else {
      failed++;
      console.log(`  ✖ ${label} ${c.error?.message ?? "failed"}`);
      if (c.error?.hint) console.log(`      ${c.error.hint}`);
    }
  }
  return failed;
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

/**
 * The project the folder's git remotes point at. One remote: use it. Several
 * distinct ones (a mirrored repository): ask which, or take `origin`'s and say so.
 */
async function chooseRemote(
  provider: IntegrationProvider,
  dir: string,
  mayAsk: boolean
): Promise<DetectedCoordinates | null> {
  const all = detectAllCoordinates(provider, dir);
  if (all.length <= 1) return all[0] ?? null;
  const show = (d: DetectedCoordinates) => `${d.org} / ${d.project}${d.repo ? ` / ${d.repo}` : ""}`;
  if (!mayAsk) {
    console.log(
      `  Note: this folder has ${all.length} ${provider.info.label} remotes; using ${show(all[0])}.`
    );
    console.log(
      `  Others: ${all.slice(1).map(show).join(", ")}. Pass --project to choose another.`
    );
    return all[0];
  }
  console.log(`  This folder has ${all.length} ${provider.info.label} remotes:`);
  all.forEach((d, i) => console.log(`    ${i + 1}  ${show(d)}`));
  const answer = (await ask(`  Which one? (number, Enter for 1): `)).trim();
  const n = answer ? Number(answer) : 1;
  return Number.isInteger(n) && n >= 1 && n <= all.length ? all[n - 1] : all[0];
}

async function runSetup(info: ProviderInfo, args: string[]): Promise<number> {
  const flags = parseFlags(args);
  assertKnownFlags(flags, [
    "--org",
    "--project",
    "--name",
    "--repo",
    "--server-url",
    "--az",
    "--pat-stdin",
    "--no-agents",
    "--yes",
  ]);
  const dir = projectDirFrom(flags);
  const yes = flags.bool.has("--yes");
  const interactive = isInteractive() && !yes;
  const alias = info.aliases[0] ?? info.id;

  console.log(`\n${info.label} setup\n`);

  // 1. Account
  console.log(`▸ Sign-in`);
  const status = await getStatus(info.id, dir);
  const provider = getProvider(info.id)!;
  const detected = await chooseRemote(
    provider,
    dir,
    interactive && !flagValue(flags, "--org", "--server-url", "--project", "--name")
  );
  const account = await ensureAccount(info, flags, detected);
  // The remote's project and repository belong to the remote's own account only.
  const own = detected && accountIdFor(provider, detected) === account.id ? detected : null;

  // 2. Project
  console.log(`\n▸ Project`);
  let project = flagValue(flags, "--project", "--name") ?? own?.project;
  const repoFlag = flags.value.get("--repo");
  let repo: string | null | undefined =
    repoFlag === undefined
      ? undefined
      : !repoFlag || repoFlag.toLowerCase() === "none"
        ? null
        : repoFlag;
  const current = status.project.binding;
  if (!project) {
    if (!isInteractive()) {
      throw new IntegrationError(
        "no_remote",
        `No ${info.label} remote was found in ${dir}.`,
        "Run this inside a repository cloned from Azure DevOps, or pass --project <name> [--repo <name>]."
      );
    }
    const picked = await pickProjectAndRepo(account, current);
    if (!picked) {
      console.log(`  Cancelled. Nothing was connected.`);
      return 1;
    }
    project = picked.project;
    repo = picked.repo;
  }

  let resolved;
  for (;;) {
    try {
      resolved = await resolveSwitch(info.id, dir, { account: account.id, project, repo });
      break;
    } catch (err) {
      const notFound = err instanceof IntegrationError && err.code === "not_found";
      if (!(notFound && interactive && !flagValue(flags, "--project", "--name"))) throw err;
      console.log(`  ${err.message}${err.hint ? ` ${err.hint}` : ""}`);
      const picked = await pickProjectAndRepo(account, current);
      if (!picked) return 1;
      project = picked.project;
      repo = picked.repo;
    }
  }
  const same =
    current?.account === resolved.account.id &&
    current.project === resolved.project &&
    current.repo === resolved.repo;
  console.log(
    `  ${resolved.account.org} / ${where({ project: resolved.project, repo: resolved.repo })}${
      own && !flagValue(flags, "--project", "--name") ? "   (from the git remote, verified)" : ""
    }`
  );
  if (same) {
    console.log(`  ✔ Already connected`);
  } else {
    if (!yes) {
      if (!isInteractive()) {
        console.error(`[kai] Re-run with --yes to connect without a prompt.`);
        return 1;
      }
      if (!(await confirm("  Connect this folder?", true))) {
        console.log(`  Cancelled. Nothing was connected.`);
        return 1;
      }
    }
    const binding = await withReplace(yes, (replace) =>
      Promise.resolve(
        bind(info.id, dir, {
          account: resolved.account.id,
          project: resolved.project,
          repo: resolved.repo,
          replace,
        })
      )
    );
    if (!binding) return 1;
    console.log(`  ✔ Connected`);
  }

  // 3. Agents
  if (flags.bool.has("--no-agents")) {
    console.log(`\n▸ Agents\n  – Skipped (--no-agents). Run \`kai mcp all\` to wire them.`);
  } else {
    console.log(`\n▸ Agents`);
    printWire(await wireAgents({ dir, yes, interactive: isInteractive() }));
  }

  // 4. Verify with real calls
  console.log(`\n▸ Check`);
  const checks = await checkAccess(dir);
  const failed = printChecks(checks);
  const tools = integrationToolDefs(dir).map((t) => t.name);

  console.log(`\nDone. Agents now get ${tools.length} ${info.label} tools for this folder.`);
  if (failed > 0) {
    console.log(`  Fix the access above, then run \`kai integration ${alias}\` again to re-check.`);
  }
  console.log(`  Restart a running agent session so it re-reads its tools.`);
  console.log(
    `  Next: \`kai azure list\` · \`kai azure active --name <project>\` · \`kai azure remove\`\n`
  );
  return 0;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

/** `kai integration [list|<provider>]`. */
export async function runIntegration(args: string[]): Promise<number> {
  const sub = (args[1] ?? "").toLowerCase();
  try {
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      printHelp();
      return 0;
    }
    if (sub === "list" || sub === "ls") return await runList(args.slice(2));
    const info = findProvider(sub);
    if (info) return await runSetup(info, args.slice(2));
    console.error(`[kai] Unknown integration "${args[1]}".`);
    console.error(
      `  Available: ${PROVIDER_CATALOG.map((p) => p.aliases[0] ?? p.id).join(", ")}. Run \`kai integration list\`.`
    );
    return 1;
  } catch (err) {
    return fail(err);
  }
}
