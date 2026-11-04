import { spawn } from "child_process";
import { applyAgentSetup, detectInstalledAgentsSync } from "../../core/agents";
import { findBinding, getAccount, listAccounts } from "../../core/integrations/config";
import {
  findProvider,
  PROVIDER_CATALOG,
  type ProviderInfo,
} from "../../core/integrations/providerCatalog";
import { getProvider } from "../../core/integrations/providers";
import { azCliOnPath, isCloudBaseUrl } from "../../core/integrations/providers/azure-devops/auth";
import { browserSignInAvailable } from "../../core/integrations/providers/azure-devops/oauth";
import type { DetectedCoordinates, IntegrationStatusView } from "../../core/integrations/rpcTypes";
import {
  accountIdFor,
  bind,
  checkAccess,
  detectAllCoordinates,
  getStatus,
  login,
  loginWithBrowser,
  resolveSwitch,
  setRules,
  setWriteTools,
  verifyAccount,
  type AccessCheck,
} from "../../core/integrations/service";
import { integrationToolDefs } from "../../core/integrations/tools";
import { checkBranchPattern, effectiveRules } from "../../core/integrations/workflowRules";
import {
  IntegrationError,
  type IntegrationAccount,
  type IntegrationProvider,
} from "../../core/integrations/types";
import { resolveKaiBin } from "../agentWorkflow";
import { ask, askHidden, confirm, isInteractive, readAllStdin } from "../prompt";
import { getTeamsAccount } from "../../core/teams/config";
import { runTeamsSetup } from "./teams";
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
  kai integration teams              Sign in to Microsoft Teams (your own account, not
                                     tied to a folder), then chat with: kai teams

Steps:
  1. Sign-in     Opens your browser; no organization or token to type
  2. Scope       Select organization, project, and repository
  3. Agents      Select agents to configure (default: all)
  4. Check       Verify tool access with live API checks

Options for \`kai integration azure\`:
  --org <name>          Organization (default: from the git remote, or found at sign-in)
  --project <name>      Project (default: from the git remote, or you pick one)
  --repo <name|none>    Repository (default: from the git remote)
  --pat-stdin           Scripts/CI: pipe an access token on stdin instead of the browser
  --az                  Scripts/CI: use the Azure CLI's sign-in instead of the browser
  --server-url <url>    Azure DevOps Server (on-premises; signs in with --pat-stdin)
  --no-agents           Do not touch any agent's config
  -y, --yes             Do not ask for confirmation

It is safe to run again: it checks the saved sign-in and only asks what is missing.
Then: kai azure list | kai azure active --name <project> | kai azure remove

Settings of a folder that is already connected (run on their own, not with the options above):
  --merge-branch <name>        Branch agents start new work from and open pull requests into
  --clear-merge-branch         Back to the repository's default branch
  --branch-pattern <regex>     Regular expression new branch names should match, e.g.
                               "^feature/[0-9]+-[a-z-]+$"  (quote it; guidance for agents,
                               not enforced)
  --clear-branch-pattern       Agents choose their own branch names again
  --allow-writes               Let agents change data as you: comment on work items and
                               pull requests, change a work item's state, open a pull request
                               between existing branches. Off by default; only you can turn it
                               on (it asks first, -y/--yes skips the question)
  --no-writes                  Read-only again (the default)
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
    if (b?.writeTools) {
      console.log(
        `  ${" ".repeat(8)} ${" ".repeat(14)} write tools on: agents can change data here (turn off: kai integration ${info.aliases[0] ?? info.id} --no-writes)`
      );
    }
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
  const teamsAccount = getTeamsAccount();
  console.log(
    `  ${"teams".padEnd(8)} ${"MS Teams".padEnd(14)} ${
      teamsAccount ? `\u25cf signed in as ${teamsAccount.name}` : "\u25cb not set up"
    }`
  );
  if (!teamsAccount) {
    console.log(`  ${" ".repeat(8)} ${" ".repeat(14)} \u2192 kai integration teams`);
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
  flags: Flags,
  /** Forces the sign-in method (replacing a token that was accepted but is missing a scope). */
  method?: "az" | "pat"
): Promise<IntegrationAccount> {
  // Azure DevOps Server does not accept the Entra tokens the Azure CLI issues, so it defaults to a token.
  const isServer = !isCloudBaseUrl(
    getProvider(info.id)!.buildAccount({ ...plan, authMethod: "az" }).baseUrl
  );
  let authMethod: "az" | "pat";
  if (flags.bool.has("--pat-stdin")) authMethod = "pat";
  else if (flags.bool.has("--az")) authMethod = "az";
  else if (method) authMethod = method;
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

/**
 * Browser sign-in: the default. Reuse a working sign-in for the folder's
 * organization; otherwise open the browser, which finds every organization the
 * user belongs to, and pick the one this folder needs.
 */
async function ensureBrowserAccount(
  info: ProviderInfo,
  flags: Flags,
  detected: DetectedCoordinates | null
): Promise<IntegrationAccount> {
  const provider = getProvider(info.id)!;
  const orgFlag = flagValue(flags, "--org");
  const accounts = listAccounts(info.id);
  const wantedId = orgFlag
    ? provider.buildAccount({ org: orgFlag, authMethod: "oauth" }).id
    : detected
      ? accountIdFor(provider, detected)
      : null;
  const existing = wantedId ? getAccount(wantedId) : accounts.length === 1 ? accounts[0] : null;

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
    console.log(`  Not signed in yet.`);
  }

  console.log(`  Opening your browser to sign in to ${info.label}...`);
  const signedIn = await loginWithBrowser(info.id, {
    onUrl: (url) => console.log(`  If it does not open, visit this address:\n    ${url}`),
  });
  const who = signedIn.user.email ?? signedIn.user.name;
  const orgs = signedIn.accounts.map((a) => a.org);

  let chosen = wantedId ? signedIn.accounts.find((a) => a.id === wantedId) : undefined;
  if (wantedId && !chosen) {
    throw new IntegrationError(
      "no_account",
      `${who} cannot reach the "${orgFlag ?? detected?.org}" organization.`,
      `Organizations on this account: ${orgs.join(", ")}. Sign in with the account that owns it.`
    );
  }
  if (!chosen && signedIn.accounts.length === 1) chosen = signedIn.accounts[0];
  if (!chosen) {
    if (!isInteractive()) {
      throw new IntegrationError(
        "bad_request",
        "Which organization?",
        `Signed in as ${who}. Pass --org <name>: ${orgs.join(", ")}.`
      );
    }
    signedIn.accounts.forEach((a, i) => console.log(`    ${i + 1}. ${a.org}`));
    const n = Number((await ask(`  Which organization? (number, Enter for 1): `)).trim() || "1");
    chosen = signedIn.accounts[Number.isInteger(n) && n >= 1 && n <= orgs.length ? n - 1 : 0];
  }
  const saved = getAccount(chosen.id);
  if (!saved) throw new IntegrationError("config", "The account was not saved.");
  console.log(`  ✔ Signed in to ${saved.org} as ${who} (${authLabel(saved.authMethod)})`);
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
  // The token and Azure CLI paths (and on-premises Server) are for scripts and CI,
  // and for any build that has no Microsoft app registered for browser sign-in.
  // A self-hosted server's remote is also one: browser sign-in only reaches Azure DevOps Services.
  const detectedIsServer = detected ? !isCloudBaseUrl(detected.baseUrl) : false;
  const chosenMethod =
    serverUrl || flags.bool.has("--pat-stdin") || flags.bool.has("--az") || detectedIsServer;
  const browserReady = browserSignInAvailable();
  const legacy = chosenMethod || !browserReady;
  if (!legacy) return ensureBrowserAccount(info, flags, detected);
  if (!chosenMethod) {
    console.log(
      "  Browser sign-in is not set up in this build of Kai, so this signs in with the Azure CLI or an access token instead."
    );
  }
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

  // A token or method named on the command line means "use this one", so it replaces a working sign-in.
  const replacing = flags.bool.has("--pat-stdin") || flags.bool.has("--az");
  if (existing && !replacing) {
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

/**
 * A Server SSH remote does not say the server's web address, so Kai only has a guess.
 * Nothing signs in to a guessed host unasked: confirm it (or take the typed address), or
 * stop with the exact command to run. Skipped when the person already named the address
 * (`--server-url`, `--org`) or is already signed in to exactly that address.
 */
async function confirmSuggestedRemote(
  provider: IntegrationProvider,
  flags: Flags,
  detected: DetectedCoordinates | null,
  interactive: boolean
): Promise<DetectedCoordinates | null> {
  if (!detected?.needsConfirmation) return detected;
  if (flagValue(flags, "--server-url", "--org")) return detected;
  const guess = detected.baseUrl;
  if (getAccount(accountIdFor(provider, detected))) {
    console.log(
      `  Azure DevOps Server SSH remote: using ${guess} (you are already signed in there).`
    );
    return detected;
  }
  const rerun = `kai integration azure --server-url ${guess} --project "${detected.project}"${
    detected.repo ? ` --repo "${detected.repo}"` : ""
  } --pat-stdin`;
  if (!interactive) {
    throw new IntegrationError(
      "needs_confirmation",
      `This folder's remote is an Azure DevOps Server SSH address. SSH does not say the web address, so ${guess} is only a guess (its port and any virtual directory like /tfs can differ).`,
      `If that is the address you open in a browser, run: ${rerun}`
    );
  }
  console.log(
    `  The remote is an Azure DevOps Server over SSH, which does not give its web address.`
  );
  console.log(
    `  Kai's guess: ${guess}  (project ${detected.project}${detected.repo ? `, repository ${detected.repo}` : ""})`
  );
  if (await confirm(`  Is that the address you open in your browser?`, true)) return detected;
  const typed = (
    await ask(`  Web address (https://<host>[/virtual dir]/<collection>), Enter to cancel: `)
  ).trim();
  if (!typed) throw new IntegrationError("bad_request", "Cancelled.");
  const account = provider.buildAccount({ baseUrl: typed, authMethod: "az" });
  return {
    org: account.org,
    project: detected.project,
    repo: detected.repo,
    baseUrl: account.baseUrl,
  };
}

// ---------------------------------------------------------------------------
// settings of a connected folder
// ---------------------------------------------------------------------------

const RULE_FLAGS = [
  "--merge-branch",
  "--clear-merge-branch",
  "--branch-pattern",
  "--clear-branch-pattern",
];
const WRITE_FLAGS = ["--allow-writes", "--no-writes"];
const SETTINGS_FLAGS = [...RULE_FLAGS, ...WRITE_FLAGS];
/** Options that connect a folder; they do not mix with settings. */
const SETUP_ONLY_FLAGS = [
  "--org",
  "--project",
  "--name",
  "--repo",
  "--server-url",
  "--az",
  "--pat-stdin",
  "--no-agents",
];

const present = (flags: Flags, names: readonly string[]): string[] =>
  names.filter((n) => flags.bool.has(n) || flags.value.has(n));

function badRequest(message: string, hint?: string): IntegrationError {
  return new IntegrationError("bad_request", message, hint);
}

/**
 * `kai integration azure --merge-branch … / --branch-pattern … / --allow-writes …`: change a
 * connected folder's settings without signing in again. Rules reuse the desktop path
 * (`setRules`: same checks, same storage); write tools reuse `setWriteTools`, which refuses
 * to turn them on from inside an AI agent's session.
 */
async function runSettings(info: ProviderInfo, flags: Flags, dir: string): Promise<number> {
  const alias = info.aliases[0] ?? info.id;
  const mixed = present(flags, SETUP_ONLY_FLAGS);
  if (mixed.length > 0) {
    throw badRequest(
      `${mixed.join(", ")} connects a folder, and ${present(flags, SETTINGS_FLAGS).join(", ")} changes the settings of a connected one.`,
      `Run them as two commands: first \`kai integration ${alias}\`, then the settings.`
    );
  }
  const has = (n: string) => flags.bool.has(n) || flags.value.has(n);
  if (has("--merge-branch") && has("--clear-merge-branch")) {
    throw badRequest("Use either --merge-branch or --clear-merge-branch, not both.");
  }
  if (has("--branch-pattern") && has("--clear-branch-pattern")) {
    throw badRequest("Use either --branch-pattern or --clear-branch-pattern, not both.");
  }
  if (has("--allow-writes") && has("--no-writes")) {
    throw badRequest("Use either --allow-writes or --no-writes, not both.");
  }
  const mergeBranch = flagValue(flags, "--merge-branch");
  const branchPattern = flagValue(flags, "--branch-pattern");
  if (has("--merge-branch") && !mergeBranch) {
    throw badRequest("--merge-branch needs a branch name.", "To remove it: --clear-merge-branch");
  }
  if (has("--branch-pattern") && !branchPattern) {
    throw badRequest(
      "--branch-pattern needs a regular expression.",
      'Quote it, e.g. --branch-pattern "^feature/[0-9]+$". To remove it: --clear-branch-pattern'
    );
  }

  const found = findBinding(dir);
  if (!found || found.binding.provider !== info.id) {
    throw new IntegrationError(
      "no_account",
      `This folder is not connected to ${info.label}.`,
      `Run \`kai integration ${alias}\` first.`
    );
  }
  const yes = flags.bool.has("--yes");
  console.log(`\n${info.label} settings for ${where(found.binding)}\n`);

  // Everything that can be refused is checked before anything is written.
  if (has("--allow-writes") && !yes) {
    console.log(`  Agents will be able to change data in ${info.label} through Kai, as you:`);
    console.log(`    - add comments to work items and pull requests`);
    console.log(`    - change a work item's state`);
    console.log(`    - open a pull request between branches that already exist`);
    console.log(`  They cannot create branches, merge, delete or edit anything else. Every change`);
    console.log(
      `  is made with YOUR sign-in. Tokens (PAT) need Work Items and Code: Read & write;`
    );
    console.log(`  browser and Azure CLI sign-ins use your own permissions.`);
    if (!isInteractive()) {
      throw badRequest(
        "Turning on write tools needs your confirmation.",
        "Re-run in a terminal, or add --yes to confirm without a prompt."
      );
    }
    if (!(await confirm(`  Let agents write to ${info.label} for this folder?`, false))) {
      console.log(`  Cancelled. Nothing changed.`);
      return 1;
    }
  }

  if (
    has("--merge-branch") ||
    has("--clear-merge-branch") ||
    has("--branch-pattern") ||
    has("--clear-branch-pattern")
  ) {
    const current = effectiveRules(found.binding.rules);
    const next = {
      mergeBranch: has("--clear-merge-branch") ? "" : (mergeBranch ?? current.mergeBranch),
      branchPattern: has("--clear-branch-pattern") ? "" : (branchPattern ?? current.branchPattern),
    };
    const saved = await setRules(info.id, dir, next);
    const rules = effectiveRules(saved.rules);
    console.log(
      rules.mergeBranch
        ? `  ✔ Merge branch: ${rules.mergeBranch}`
        : `  ✔ Merge branch: none (agents use the repository's default branch)`
    );
    console.log(
      rules.branchPattern
        ? `  ✔ Branch naming: ${rules.branchPattern}`
        : `  ✔ Branch naming: none (agents choose their own names)`
    );
    const warning = rules.branchPattern ? checkBranchPattern(rules.branchPattern).warning : null;
    if (warning) console.log(`    ${warning}`);
    console.log(`    Guidance for agents (the kai_workflow_rules tool). Kai does not enforce it.`);
  }

  if (has("--allow-writes") || has("--no-writes")) {
    const on = has("--allow-writes");
    await setWriteTools(info.id, dir, on);
    const tools = integrationToolDefs(dir).length;
    console.log(
      on
        ? `  ✔ Write tools: on. Agents now get ${tools} ${info.label} tools here, including the ones that change data.`
        : `  ✔ Write tools: off. Agents can only read ${info.label} here.`
    );
    console.log(
      on
        ? `    Turn them off any time: kai integration ${alias} --no-writes`
        : `    Turn them on: kai integration ${alias} --allow-writes`
    );
    console.log(
      `    A running agent that honors MCP tool-list updates refreshes on its own; restart any that does not.`
    );
  }
  console.log("");
  return 0;
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
    ...SETTINGS_FLAGS,
  ]);
  const dir = projectDirFrom(flags);
  if (present(flags, SETTINGS_FLAGS).length > 0) return runSettings(info, flags, dir);
  const yes = flags.bool.has("--yes");
  const interactive = isInteractive() && !yes;
  const alias = info.aliases[0] ?? info.id;

  console.log(`\n${info.label} setup\n`);

  // 1. Account
  console.log(`▸ Sign-in`);
  const status = await getStatus(info.id, dir);
  const provider = getProvider(info.id)!;
  const detected = await confirmSuggestedRemote(
    provider,
    flags,
    await chooseRemote(
      provider,
      dir,
      interactive && !flagValue(flags, "--org", "--server-url", "--project", "--name")
    ),
    interactive
  );
  let account = await ensureAccount(info, flags, detected);
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
  let replacedToken = false;
  for (;;) {
    try {
      resolved = await resolveSwitch(info.id, dir, { account: account.id, project, repo });
      break;
    } catch (err) {
      // The token verified at sign-in, so a refusal here means it lacks a scope: offer a new one.
      const scopeShort =
        err instanceof IntegrationError &&
        err.code === "auth" &&
        account.authMethod === "pat" &&
        interactive &&
        !replacedToken;
      if (scopeShort) {
        console.log(`  ! ${err.message}`);
        console.log(
          `    The token signed in but cannot read this project. Create one with Work Items, Code, Build and Project and Team (all Read).`
        );
        if (!(await confirm("  Enter a new token now?", true))) throw err;
        account = await signIn(info, { org: account.org, baseUrl: account.baseUrl }, flags, "pat");
        replacedToken = true;
        continue;
      }
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
  console.log(
    `  A running agent that honors MCP tool-list updates refreshes on its own; restart any that does not.`
  );
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
    if (sub === "teams" || sub === "msteams") return await runTeamsSetup(args.slice(2));
    const info = findProvider(sub);
    if (info) return await runSetup(info, args.slice(2));
    console.error(`[kai] Unknown integration "${args[1]}".`);
    console.error(
      `  Available: ${[...PROVIDER_CATALOG.map((p) => p.aliases[0] ?? p.id), "teams"].join(", ")}. Run \`kai integration list\`.`
    );
    return 1;
  } catch (err) {
    return fail(err);
  }
}
