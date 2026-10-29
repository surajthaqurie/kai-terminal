import {
  findBinding,
  getAccount,
  listAccounts,
  projectsUsingAccount,
} from "../../core/integrations/config";
import { findProvider, type ProviderInfo } from "../../core/integrations/providerCatalog";
import type { IntegrationRpcRequest } from "../../core/integrations/rpcTypes";
import {
  findAccounts,
  handleRpc,
  listProjects,
  listRepos,
  removeAccountEverywhere,
  switchActive,
  unbind,
} from "../../core/integrations/service";
import {
  IntegrationError,
  asIntegrationError,
  type IntegrationAccount,
  type ProjectBinding,
} from "../../core/integrations/types";
import { confirm, isInteractive, readAllStdin } from "../prompt";
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
} from "./integrationShared";

/**
 * `kai azure list|active|remove` (and `kai remove --name <id>`): one generic
 * implementation over the provider registry. Setup lives in `kai integration`.
 */

function printHelp(info: ProviderInfo): void {
  const cmd = info.aliases[0] ?? info.id;
  console.log(`
${info.label}

Usage:
  kai integration ${cmd}               Set up: sign in, connect this folder, wire agents, verify
  kai ${cmd} list [--repos] [--json]   Signed-in accounts with their projects (the active one
                                      for this folder is marked *); --repos shows every
                                      project's repositories
  kai ${cmd} active --name <project>   Switch this folder's active project
                                      (--repo <name|none>, --org <name>)
                                      With no --name in a terminal: pick from a list
  kai ${cmd} remove                    Disconnect THIS folder (keeps your sign-in)
  kai ${cmd} remove --name <id>        Remove an account everywhere: sign out, delete its
                                      stored token, disconnect every folder using it
  kai remove --name <id>              Same as above, for any integration
  (removing an account asks first; -y/--yes skips the question)

A folder has exactly one active project. Sign-in is per user and shared by every
folder. Tokens live in the OS secret store, never in a repo or an agent config.
`);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const MAX_EXPANDED_PROJECTS = 30;
const EXPAND_CONCURRENCY = 4;

interface ProjectRow {
  name: string;
  description?: string;
  active: boolean;
  repos?: string[];
  reposError?: string;
}

interface AccountRow {
  id: string;
  org: string;
  authMethod: string;
  user?: string;
  projects: ProjectRow[];
  /** More projects exist than were expanded with --repos. */
  expandedLimit?: number;
  error?: string;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function inPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function describeAccount(
  account: IntegrationAccount,
  active: ProjectBinding | null,
  expandAll: boolean
): Promise<AccountRow> {
  const row: AccountRow = {
    id: account.id,
    org: account.org,
    authMethod: account.authMethod,
    ...(account.user ? { user: account.user } : {}),
    projects: [],
  };
  try {
    const projects = await listProjects(account.id);
    const isActive = (n: string) => active?.project.toLowerCase() === n.toLowerCase();
    row.projects = projects.map((p) => ({
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
      active: isActive(p.name),
    }));
    const wantRepos = row.projects.filter((p, i) =>
      expandAll ? i < MAX_EXPANDED_PROJECTS : p.active
    );
    if (expandAll && row.projects.length > MAX_EXPANDED_PROJECTS) {
      row.expandedLimit = MAX_EXPANDED_PROJECTS;
    }
    await inPool(wantRepos, EXPAND_CONCURRENCY, async (p) => {
      try {
        p.repos = (await listRepos(account.id, p.name)).map((r) => r.name);
      } catch (err) {
        p.reposError = asIntegrationError(err).message;
      }
    });
  } catch (err) {
    const e = asIntegrationError(err);
    row.error = e.hint ? `${e.message} ${e.hint}` : e.message;
  }
  return row;
}

async function runList(info: ProviderInfo, args: string[]): Promise<number> {
  const flags = parseFlags(args);
  assertKnownFlags(flags, ["--repos", "--json", "--org"]);
  const dir = projectDirFrom(flags);
  const cmd = info.aliases[0] ?? info.id;
  const orgFlag = flags.value.get("--org");

  let accounts = listAccounts(info.id);
  if (orgFlag) accounts = accounts.filter((a) => a.org.toLowerCase() === orgFlag.toLowerCase());
  if (accounts.length === 0) {
    console.error(
      orgFlag
        ? `[kai] Not signed in to "${orgFlag}".`
        : `[kai] No ${info.label} account yet. Run \`kai integration ${cmd}\`.`
    );
    return orgFlag ? 1 : 0;
  }

  const found = findBinding(dir);
  const mine = found && found.binding.provider === info.id ? found.binding : null;
  const rows: AccountRow[] = [];
  for (const account of accounts) {
    rows.push(
      await describeAccount(
        account,
        mine && mine.account === account.id ? mine : null,
        flags.bool.has("--repos")
      )
    );
  }

  if (flags.bool.has("--json")) {
    console.log(JSON.stringify({ provider: info.id, folder: dir, accounts: rows }, null, 2));
    return rows.some((r) => r.error) ? 1 : 0;
  }

  console.log(info.label);
  for (const row of rows) {
    console.log(`\n${row.org} · ${authLabel(row.authMethod)}${row.user ? ` · ${row.user}` : ""}`);
    if (row.error) {
      console.log(`  ! Could not list projects: ${row.error}`);
      continue;
    }
    if (row.projects.length === 0) {
      console.log(`  (this sign-in cannot read any project)`);
      continue;
    }
    const width = Math.max(...row.projects.map((p) => p.name.length));
    for (const p of row.projects) {
      const repos = p.reposError
        ? `(repositories: ${p.reposError})`
        : p.repos
          ? p.repos.length > 0
            ? p.repos.join(", ")
            : "(no repositories)"
          : (p.description ?? "");
      console.log(`  ${p.active ? "*" : " "} ${p.name.padEnd(width)}  ${repos}`.trimEnd());
    }
    if (row.expandedLimit) {
      console.log(
        `  (repositories shown for the first ${row.expandedLimit} projects only; use \`kai ${cmd} active\` to pick one)`
      );
    }
  }
  console.log(
    mine
      ? `\n* = active for this folder (${where(mine)}).  Switch: kai ${cmd} active --name <project>`
      : `\nNothing is active for this folder.  Connect: kai integration ${cmd}`
  );
  return rows.some((r) => r.error) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// active
// ---------------------------------------------------------------------------

/** The one account `active` and `remove` should act on, or a message saying why not. */
function pickAccount(
  info: ProviderInfo,
  orgFlag: string | undefined,
  bound: ProjectBinding | null
): { account: IntegrationAccount } | { message: string } {
  const accounts = listAccounts(info.id);
  const cmd = info.aliases[0] ?? info.id;
  if (accounts.length === 0) {
    return { message: `Not signed in to ${info.label}. Run \`kai integration ${cmd}\` first.` };
  }
  if (orgFlag) {
    const hit = accounts.find((a) => a.org.toLowerCase() === orgFlag.toLowerCase());
    return hit
      ? { account: hit }
      : {
          message: `Not signed in to "${orgFlag}". Signed in: ${accounts.map((a) => a.org).join(", ")}`,
        };
  }
  const account =
    (bound && getAccount(bound.account)) || (accounts.length === 1 ? accounts[0] : null);
  return account
    ? { account }
    : {
        message: `Which account? Pass --org <name>. Signed in: ${accounts.map((a) => a.org).join(", ")}`,
      };
}

/**
 * `kai azure active [--name <project>]`: switch this folder's active project.
 * The name is checked against what Azure has and stored with its true spelling;
 * a folder always has exactly one active project.
 */
async function runActive(info: ProviderInfo, args: string[]): Promise<number> {
  const flags = parseFlags(args);
  assertKnownFlags(flags, ["--name", "--project", "--repo", "--org", "--yes"]);
  const dir = projectDirFrom(flags);
  const yes = flags.bool.has("--yes");
  const cmd = info.aliases[0] ?? info.id;

  const found = findBinding(dir);
  const mine = found && found.binding.provider === info.id ? found.binding : null;
  const chosen = pickAccount(info, flags.value.get("--org"), mine);
  if ("message" in chosen) {
    console.error(`[kai] ${chosen.message}`);
    return 1;
  }
  const account = chosen.account;
  const current = mine && mine.account === account.id ? mine : null;

  let name = flagValue(flags, "--name", "--project");
  let repo: string | null | undefined;
  const repoFlag = flags.value.get("--repo");
  if (repoFlag !== undefined) {
    repo = !repoFlag || repoFlag.toLowerCase() === "none" ? null : repoFlag;
  }

  if (!name) {
    if (!isInteractive()) {
      console.log(
        current
          ? `Active for this folder: ${where(current)} (${account.org})`
          : `Nothing is active for this folder yet.`
      );
      console.log(`Switch: kai ${cmd} active --name <project> [--repo <name|none>]`);
      console.log(`See what exists: kai ${cmd} list`);
      return 0;
    }
    console.log(`${info.label} · ${account.org} (${authLabel(account.authMethod)})`);
    console.log(current ? `Active for this folder: ${where(current)}` : `Nothing is active yet.`);
    const picked = await pickProjectAndRepo(account, current);
    if (!picked) {
      console.log(`[kai] Kept the current project. Nothing changed.`);
      return 0;
    }
    name = picked.project;
    repo = picked.repo;
  }

  const binding = await withReplace(yes, (replace) =>
    switchActive(info.id, dir, { account: account.id, project: name!, repo, replace })
  );
  if (!binding) return 1;
  console.log(`✔ Active project is now ${where(binding)} (${account.org}).`);
  console.log(`  Restart a running agent session if it listed the old project's data.`);
  return 0;
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

/** `kai azure remove` / `kai remove azure`: disconnect THIS folder. The sign-in stays. */
export async function runProviderRemove(name: string, args: string[]): Promise<number> {
  try {
    const info = findProvider(name);
    if (!info) throw new IntegrationError("bad_request", `Unknown integration "${name}".`);
    const flags = parseFlags(args);
    assertKnownFlags(flags, ["--yes"]);
    const dir = projectDirFrom(flags);
    const cmd = info.aliases[0] ?? info.id;
    const found = findBinding(dir);
    const mine = found && found.binding.provider === info.id ? found : null;

    if (!mine) {
      console.log(`[kai] This folder is not connected to ${info.label}. Nothing to remove.`);
      return 0;
    }
    const b = mine.binding;
    console.log(`[kai] Disconnect ${info.label} from this folder:`);
    console.log(`  Account   ${b.account}`);
    console.log(`  Project   ${where(b)}`);
    console.log(
      `  NOTE: Only Kai's private connection record is removed. The repository is NOT touched.`
    );
    const result = await unbind(info.id, dir);
    console.log(`✔ ${info.label} disconnected from this folder.`);
    const others = result.stillUsedBy.length;
    console.log(
      others > 0
        ? `  ${b.account} stays signed in (${others} other folder${others === 1 ? "" : "s"} use it).`
        : `  ${b.account} stays signed in on this machine.`
    );
    console.log(`  Remove the account itself: kai ${cmd} remove --name ${b.account}`);
    return 0;
  } catch (err) {
    return fail(err);
  }
}

/** Remove one account everywhere: token, account and every folder's connection. */
async function removeAccountFlow(account: IntegrationAccount, args: string[]): Promise<number> {
  const flags = parseFlags(args);
  assertKnownFlags(flags, ["--name", "--yes"]);
  const folders = projectsUsingAccount(account.id);
  console.log(`[kai] Remove the account ${account.id} everywhere:`);
  console.log(`  Signed in as  ${account.user ?? "(unknown)"} · ${authLabel(account.authMethod)}`);
  console.log(
    `  Stored token  deleted${account.authMethod === "az" ? " (none; the Azure CLI owns its sign-in)" : ""}`
  );
  console.log(
    `  Folders       ${folders.length === 0 ? "none use it" : `${folders.length} will be disconnected`}`
  );
  for (const f of folders.slice(0, 5)) console.log(`    - ${f}`);
  if (folders.length > 5) console.log(`    … and ${folders.length - 5} more`);
  console.log(`  NOTE: No repository is touched.`);

  if (!flags.bool.has("--yes")) {
    if (!isInteractive()) {
      console.error(`[kai] Re-run with --yes to remove it without a prompt.`);
      return 1;
    }
    if (!(await confirm("Remove it?"))) {
      console.log(`[kai] Cancelled. Nothing changed.`);
      return 1;
    }
  }
  const result = await removeAccountEverywhere(account.id);
  console.log(
    `✔ Removed ${account.id}${result.folders.length > 0 ? ` and disconnected ${result.folders.length} folder${result.folders.length === 1 ? "" : "s"}` : ""}.`
  );
  return 0;
}

/**
 * `kai remove --name <id>` and `kai azure remove --name <id>`: the name is an
 * account id (`azure-devops:contoso`) or an organization (`contoso`). An
 * integration's own name (`azure`) disconnects this folder, like `kai remove azure`.
 */
export async function runRemoveByName(name: string, args: string[]): Promise<number> {
  try {
    const matches = findAccounts(name);
    if (matches.length > 1) {
      console.error(`[kai] "${name}" matches more than one account:`);
      for (const m of matches) console.error(`  ${m.id}`);
      console.error(`  Use the full id.`);
      return 1;
    }
    if (matches.length === 1) return await removeAccountFlow(matches[0], args);
    if (findProvider(name)) return await runProviderRemove(name, withoutName(args));
    const all = listAccounts();
    console.error(`[kai] No account or integration named "${name}".`);
    console.error(
      all.length > 0
        ? `  Accounts: ${all.map((a) => a.id).join(", ")}`
        : `  Nothing is set up. See \`kai integration list\`.`
    );
    return 1;
  } catch (err) {
    return fail(err);
  }
}

/** `args` with a `--name <value>` pair removed. */
function withoutName(args: string[]): string[] {
  const at = args.indexOf("--name");
  return at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
}

async function runRemove(info: ProviderInfo, args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const name = flags.value.get("--name");
  if (name === undefined) return runProviderRemove(info.id, args);
  if (!name) {
    console.error(
      `[kai] --name needs an account id or organization. See \`kai ${info.aliases[0]} list\`.`
    );
    return 1;
  }
  // Scoped to this integration: an account of another provider is not removed from here.
  const match = findAccounts(name).find((a) => a.provider === info.id);
  return runRemoveByName(match?.id ?? name, args);
}

// ---------------------------------------------------------------------------
// rpc (the desktop app)
// ---------------------------------------------------------------------------

/** One JSON request on stdin, one JSON line on stdout. Errors are in-band; the exit code is 0. */
async function runRpc(info: ProviderInfo): Promise<number> {
  let response: unknown;
  try {
    const raw = (await readAllStdin()).trim();
    const request = JSON.parse(raw) as IntegrationRpcRequest;
    if (typeof request !== "object" || request === null || typeof request.op !== "string") {
      throw new IntegrationError("bad_request", "Expected a JSON object with an op.");
    }
    response = await handleRpc(info.id, request);
  } catch (err) {
    const e =
      err instanceof SyntaxError
        ? new IntegrationError("bad_request", "The request was not valid JSON.")
        : asIntegrationError(err);
    response = { ok: false, error: e.toBody() };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

/** `kai <provider> [list|active|remove]`. */
export async function runProvider(args: string[]): Promise<number> {
  const info = findProvider(args[0]);
  if (!info) {
    console.error(`[kai] Unknown integration "${args[0]}".`);
    return 1;
  }
  const sub = (args[1] ?? "").toLowerCase();
  try {
    switch (sub) {
      case "list":
      case "ls":
        return await runList(info, args.slice(2));
      case "active":
        return await runActive(info, args.slice(2));
      case "remove":
      case "rm":
        return await runRemove(info, args.slice(2));
      case "rpc":
        return await runRpc(info);
      case "":
      case "help":
      case "--help":
      case "-h":
        printHelp(info);
        return 0;
      default:
        console.error(
          `[kai] Unknown command "kai ${args[0]} ${sub}". Run 'kai ${args[0]} --help'.`
        );
        return 1;
    }
  } catch (err) {
    return fail(err);
  }
}
