import { execFileSync } from "child_process";
import { findProvider } from "./providerCatalog";
import {
  findBinding,
  getAccount,
  listAccounts,
  projectRootFor,
  projectsUsingAccount,
  removeAccount,
  removeBinding,
  removeBindingsForAccount,
  saveAccount,
  writeBinding,
} from "./config";
import { getProvider } from "./providers";
import { azCliOnPath } from "./providers/azure-devops/auth";
import type {
  DetectedCoordinates,
  IntegrationAccountView,
  IntegrationBindingView,
  IntegrationErrorBody,
  IntegrationRpcRequest,
  IntegrationRpcResponse,
  IntegrationStatusView,
  ProjectIntegrationState,
} from "./rpcTypes";
import {
  defaultSecretStore,
  secretKeyFor,
  type SecretLocation,
  type SecretStore,
} from "./secretStore";
import {
  asIntegrationError,
  IntegrationError,
  type Capability,
  type IntegrationAccount,
  type IntegrationProvider,
  type IntegrationUser,
  type ProjectBinding,
  type ProjectInfo,
  type ProviderContext,
  type RepoInfo,
} from "./types";

/**
 * The operations behind `kai azure …`, `kai integration azure`, `kai remove azure`,
 * the desktop app's RPC, and the MCP tools. One implementation, so those entry
 * points cannot drift apart.
 */
export interface ServiceDeps {
  secrets?: SecretStore;
  /** Remote URLs of the repository at `dir`; defaults to `git remote -v`. */
  remotes?: (dir: string) => string[];
}

function secretsOf(deps: ServiceDeps): SecretStore {
  return deps.secrets ?? defaultSecretStore();
}

function providerFor(id: string): IntegrationProvider {
  const provider = getProvider(id);
  if (!provider) {
    throw new IntegrationError("bad_request", `Unknown integration "${id}".`);
  }
  return provider;
}

/** Remote URLs for `dir`, `origin` first. */
export function readGitRemotes(dir: string): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["-C", dir, "remote", "-v"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    });
  } catch {
    return [];
  }
  const rows = out
    .split(/\r?\n/)
    .map((line) => /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[1], url: m[2] }));
  rows.sort((a, b) => Number(b.name === "origin") - Number(a.name === "origin"));
  return [...new Set(rows.map((r) => r.url))];
}

/**
 * Every distinct project the folder's git remotes point at for this provider,
 * `origin` first. A repository mirrored to several remotes can name more than one.
 */
export function detectAllCoordinates(
  provider: IntegrationProvider,
  dir: string,
  deps: ServiceDeps = {}
): DetectedCoordinates[] {
  const seen = new Set<string>();
  const out: DetectedCoordinates[] = [];
  for (const url of (deps.remotes ?? readGitRemotes)(dir)) {
    const found = provider.detectFromRemote(url);
    if (!found) continue;
    const key = `${found.baseUrl}|${found.project}|${found.repo ?? ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(found);
  }
  return out;
}

export function detectCoordinates(
  provider: IntegrationProvider,
  dir: string,
  deps: ServiceDeps = {}
): DetectedCoordinates | null {
  return detectAllCoordinates(provider, dir, deps)[0] ?? null;
}

/** The account id a detected remote belongs to (an organization, or a server's collection). */
export function accountIdFor(provider: IntegrationProvider, detected: DetectedCoordinates): string {
  return provider.buildAccount({
    org: detected.org,
    baseUrl: detected.baseUrl,
    authMethod: "az",
  }).id;
}

/** The command that signs in to the account a detected remote belongs to. */
export function loginCommandFor(
  provider: IntegrationProvider,
  detected: DetectedCoordinates
): string {
  const alias = provider.info.aliases[0] ?? provider.info.id;
  const account = provider.buildAccount({
    org: detected.org,
    baseUrl: detected.baseUrl,
    authMethod: "az",
  });
  const cloud = account.id === `${provider.info.id}:${detected.org.toLowerCase()}`;
  return cloud
    ? `kai integration ${alias} --org ${detected.org}`
    : `kai integration ${alias} --server-url ${detected.baseUrl}`;
}

function bindingView(b: ProjectBinding): IntegrationBindingView {
  return { ...b };
}

async function accountView(
  account: IntegrationAccount,
  secrets: SecretStore,
  boundAccountId: string | null
): Promise<IntegrationAccountView> {
  const hasCredential =
    account.authMethod === "az" ? true : await secrets.has(secretKeyFor(account.id));
  return {
    id: account.id,
    provider: account.provider,
    org: account.org,
    baseUrl: account.baseUrl,
    authMethod: account.authMethod,
    ...(account.user ? { user: account.user } : {}),
    hasCredential,
    usedByThisProject: account.id === boundAccountId,
  };
}

export async function getStatus(
  providerId: string,
  projectDir: string,
  deps: ServiceDeps = {}
): Promise<IntegrationStatusView> {
  const provider = providerFor(providerId);
  const secrets = secretsOf(deps);
  const found = findBinding(projectDir);
  const mine = found && found.binding.provider === providerId ? found.binding : null;
  const accounts = await Promise.all(
    listAccounts(providerId).map((a) => accountView(a, secrets, mine?.account ?? null))
  );

  let state: ProjectIntegrationState = "none";
  if (mine) {
    const view = accounts.find((a) => a.id === mine.account);
    state = !view ? "account_missing" : view.hasCredential ? "ready" : "signed_out";
  }
  return {
    provider: { id: provider.info.id, label: provider.info.label },
    accounts,
    project: {
      dir: found?.root ?? projectRootFor(projectDir),
      state,
      binding: mine ? bindingView(mine) : null,
      detected: detectCoordinates(provider, projectDir, deps),
      otherProvider: found && !mine ? found.binding.provider : null,
    },
    azCli: azCliOnPath(),
  };
}

export interface LoginInput {
  org?: string;
  baseUrl?: string;
  authMethod: "az" | "pat";
  pat?: string;
}

export interface LoginResult {
  account: IntegrationAccountView;
  user: IntegrationUser;
  storedIn: SecretLocation | null;
}

/** Verify first, store second: a rejected credential leaves nothing behind. */
export async function login(
  providerId: string,
  input: LoginInput,
  deps: ServiceDeps = {}
): Promise<LoginResult> {
  const provider = providerFor(providerId);
  const secrets = secretsOf(deps);
  const pat = input.pat?.trim();
  if (input.authMethod === "pat" && !pat) {
    throw new IntegrationError(
      "bad_request",
      "An access token is required.",
      "Pass it on stdin: `kai integration azure --org <org> --pat-stdin`."
    );
  }
  const draft = provider.buildAccount({
    org: input.org,
    baseUrl: input.baseUrl,
    authMethod: input.authMethod,
  });
  const probe: IntegrationAccount = { ...draft, createdAt: new Date().toISOString() };
  const user = await provider.verify(probe, secrets, input.authMethod === "pat" ? pat : undefined);

  let storedIn: SecretLocation | null = null;
  if (input.authMethod === "pat" && pat) {
    storedIn = await secrets.set(secretKeyFor(draft.id), pat);
  } else {
    // Switching to Azure CLI auth must not leave an old token behind.
    await secrets.delete(secretKeyFor(draft.id));
  }
  const previous = getAccount(draft.id);
  const account: IntegrationAccount = {
    ...draft,
    user: user.email ?? user.name,
    createdAt: previous?.createdAt ?? probe.createdAt,
  };
  saveAccount(account);
  return {
    account: await accountView(account, secrets, null),
    user,
    storedIn,
  };
}

export async function verifyAccount(
  accountId: string,
  deps: ServiceDeps = {}
): Promise<IntegrationUser> {
  const account = getAccount(accountId);
  if (!account) {
    throw new IntegrationError(
      "no_account",
      `No account "${accountId}".`,
      "Run `kai integration azure`."
    );
  }
  return providerFor(account.provider).verify(account, secretsOf(deps));
}

function requireAccount(accountId: string): IntegrationAccount {
  const account = getAccount(accountId);
  if (!account) {
    throw new IntegrationError(
      "no_account",
      `No account "${accountId}".`,
      "Run `kai integration azure`."
    );
  }
  return account;
}

function discoveryFor(account: IntegrationAccount) {
  const provider = providerFor(account.provider);
  if (!provider.discovery) {
    throw new IntegrationError(
      "bad_request",
      `${provider.info.label} cannot list projects.`,
      "Pass the project name explicitly."
    );
  }
  return provider.discovery;
}

/** Projects the account can reach. A network call. */
export async function listProjects(
  accountId: string,
  deps: ServiceDeps = {}
): Promise<ProjectInfo[]> {
  const account = requireAccount(accountId);
  return discoveryFor(account).listProjects(account, secretsOf(deps));
}

/** Repositories of one project. A network call. */
export async function listRepos(
  accountId: string,
  project: string,
  deps: ServiceDeps = {}
): Promise<RepoInfo[]> {
  const account = requireAccount(accountId);
  return discoveryFor(account).listRepos(account, secretsOf(deps), project);
}

/** The real spelling of `typed` among `options` (case-insensitive), or a not_found that lists some. */
function canonicalName(typed: string, options: readonly string[], what: string): string {
  const wanted = typed.trim().toLowerCase();
  const hit = options.find((o) => o.toLowerCase() === wanted);
  if (hit) return hit;
  const sample = options.slice(0, 8).join(", ");
  throw new IntegrationError(
    "not_found",
    `No ${what} named "${typed}" was found.`,
    options.length > 0
      ? `Available: ${sample}${options.length > 8 ? ", …" : ""}`
      : `This account has no ${what}s it can read.`
  );
}

export interface SwitchInput {
  account?: string;
  project: string;
  /** `null` clears the repository; `undefined` keeps the current one when the new project has it. */
  repo?: string | null;
  replace?: boolean;
}

export interface ResolvedSwitch {
  account: IntegrationAccount;
  /** The project's true spelling, as Azure has it. */
  project: string;
  repo: string | null;
}

/**
 * Check a project (and repository) against what the account can really reach
 * and return their true spellings. Makes network calls and changes nothing, so
 * a caller can show the result and ask before writing it.
 */
export async function resolveSwitch(
  providerId: string,
  projectDir: string,
  input: SwitchInput,
  deps: ServiceDeps = {}
): Promise<ResolvedSwitch> {
  const provider = providerFor(providerId);
  const existing = findBinding(projectDir);
  const current = existing && existing.binding.provider === providerId ? existing.binding : null;
  const accountId =
    input.account ??
    current?.account ??
    (listAccounts(providerId).length === 1 ? listAccounts(providerId)[0].id : undefined);
  if (!accountId) {
    throw new IntegrationError(
      "no_account",
      "Which account? More than one is signed in, or none.",
      "Pass --org <name>, or run `kai integration azure`."
    );
  }
  const account = requireAccount(accountId);
  const discovery = discoveryFor(account);
  const secrets = secretsOf(deps);

  const projects = await discovery.listProjects(account, secrets);
  const project = canonicalName(
    input.project,
    projects.map((p) => p.name),
    "project"
  );

  const repos = (await discovery.listRepos(account, secrets, project)).map((r) => r.name);
  let repo: string | null;
  if (typeof input.repo === "string") {
    repo = canonicalName(input.repo, repos, "repository");
  } else if (input.repo === null) {
    repo = null;
  } else {
    // The remote's repository counts only when it is in this very project of this account.
    const remote = detectCoordinates(provider, projectDir, deps);
    const remoteRepo =
      remote &&
      accountIdFor(provider, remote) === account.id &&
      remote.project.toLowerCase() === project.toLowerCase()
        ? remote.repo
        : null;
    const keep = [current?.repo, remoteRepo].find(
      (r) => r && repos.some((o) => o.toLowerCase() === r.toLowerCase())
    );
    repo = keep ? (repos.find((o) => o.toLowerCase() === keep.toLowerCase()) ?? null) : null;
  }
  return { account, project, repo };
}

/**
 * Make `project` the active one for this folder. The name is checked against
 * what the account can really reach and stored with its true spelling, so a
 * typo can never become the binding. Replaces the folder's single binding.
 */
export async function switchActive(
  providerId: string,
  projectDir: string,
  input: SwitchInput,
  deps: ServiceDeps = {}
): Promise<ProjectBinding> {
  const resolved = await resolveSwitch(providerId, projectDir, input, deps);
  return bind(
    providerId,
    projectDir,
    {
      account: resolved.account.id,
      project: resolved.project,
      repo: resolved.repo,
      replace: input.replace,
    },
    deps
  );
}

/** Sign out: delete the secret and the account. Bindings stay and report `account_missing`. */
export async function logout(
  accountId: string,
  deps: ServiceDeps = {}
): Promise<{ affectedProjects: string[] }> {
  const account = getAccount(accountId);
  if (!account) {
    throw new IntegrationError("no_account", `No account "${accountId}".`);
  }
  const affectedProjects = projectsUsingAccount(accountId);
  await secretsOf(deps).delete(secretKeyFor(accountId));
  removeAccount(accountId);
  return { affectedProjects };
}

/** Accounts matching a typed account id or organization name, ignoring case. */
export function findAccounts(name: string): IntegrationAccount[] {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];
  const all = listAccounts();
  const byId = all.filter((a) => a.id.toLowerCase() === needle);
  return byId.length > 0 ? byId : all.filter((a) => a.org.toLowerCase() === needle);
}

export interface RemoveAccountResult {
  /** Folders that were connected to the account and are not any more. */
  folders: string[];
}

/**
 * Remove an account everywhere: its stored token, the account itself, and the
 * connection of every folder that used it. Nothing in any repository changes.
 * The secret goes first, so a failure there leaves the account as it was.
 */
export async function removeAccountEverywhere(
  accountId: string,
  deps: ServiceDeps = {}
): Promise<RemoveAccountResult> {
  requireAccount(accountId);
  const folders = projectsUsingAccount(accountId);
  await secretsOf(deps).delete(secretKeyFor(accountId));
  removeAccount(accountId);
  removeBindingsForAccount(accountId);
  return { folders };
}

export interface AccessCheck {
  capability: Capability;
  ok: boolean;
  error?: IntegrationErrorBody;
}

/**
 * One small real call per capability for the folder's connected project, so a
 * token that signs in but cannot read (missing scope, no project access) is
 * caught at setup instead of on an agent's first request.
 */
export async function checkAccess(
  projectDir: string,
  deps: ServiceDeps = {}
): Promise<AccessCheck[]> {
  const { provider, ctx } = await resolveReady(projectDir, deps);
  const probes: Array<[Capability, () => Promise<unknown>]> = [];
  const one = { limit: 1, offset: 0 };
  if (provider.workItems) probes.push(["work-items", () => provider.workItems!.search(ctx, one)]);
  if (provider.pullRequests) {
    probes.push(["pull-requests", () => provider.pullRequests!.list(ctx, one)]);
  }
  if (provider.builds) probes.push(["builds", () => provider.builds!.list(ctx, one)]);
  const settled = await Promise.allSettled(probes.map(([, run]) => run()));
  return settled.map((result, i) => ({
    capability: probes[i][0],
    ok: result.status === "fulfilled",
    ...(result.status === "rejected" ? { error: asIntegrationError(result.reason).toBody() } : {}),
  }));
}

export interface BindInput {
  account?: string;
  project?: string;
  repo?: string | null;
  replace?: boolean;
}

/** Bind `projectDir` to one account. A different integration already there needs `replace`. */
export function bind(
  providerId: string,
  projectDir: string,
  input: BindInput = {},
  deps: ServiceDeps = {}
): ProjectBinding {
  const provider = providerFor(providerId);
  const root = projectRootFor(projectDir);
  const existing = findBinding(projectDir);
  if (existing && existing.binding.provider !== providerId && !input.replace) {
    const other = findProvider(existing.binding.provider)?.label ?? existing.binding.provider;
    throw new IntegrationError(
      "needs_confirmation",
      `This project is already connected to ${other}.`,
      "Only one integration is active per project. Confirm to replace it."
    );
  }

  const detected = detectCoordinates(provider, projectDir, deps);
  const detectedAccountId = detected ? accountIdFor(provider, detected) : undefined;
  const accountId =
    input.account ??
    detectedAccountId ??
    (listAccounts(providerId).length === 1 ? listAccounts(providerId)[0].id : undefined);
  const account = accountId ? getAccount(accountId) : null;
  if (!accountId || !account) {
    throw new IntegrationError(
      "no_account",
      detected
        ? `You are not signed in to the "${detected.org}" organization.`
        : "No account selected.",
      detected
        ? `Run \`${loginCommandFor(provider, detected)}\`.`
        : "Run `kai integration azure`, then retry."
    );
  }
  // The remote's project and repository belong to the remote's own account only.
  const own = detected && detectedAccountId === account.id ? detected : null;
  const project = input.project ?? own?.project;
  if (!project) {
    throw new IntegrationError(
      "no_remote",
      detected
        ? `This folder's remote is in "${detected.org}", not in the selected account.`
        : `No ${provider.info.label} remote was found in this folder.`,
      "Pass --project (and --repo), or run this inside a repository cloned from Azure DevOps."
    );
  }

  // A different account from the same provider may already own the binding: replace it, never add.
  const binding: ProjectBinding = {
    provider: providerId,
    account: account.id,
    project,
    repo: input.repo !== undefined ? input.repo : (own?.repo ?? null),
    boundAt: new Date().toISOString(),
  };
  // Replace across roots too: the nearest existing binding is this project's one binding.
  if (existing && existing.root !== root) removeBinding(existing.root);
  writeBinding(root, binding);
  return binding;
}

export interface UnbindResult {
  removed: boolean;
  /** Set when the account is still used by other projects. */
  stillUsedBy: string[];
  loggedOut: boolean;
}

export async function unbind(
  providerId: string,
  projectDir: string,
  opts: { logout?: boolean } = {},
  deps: ServiceDeps = {}
): Promise<UnbindResult> {
  const found = findBinding(projectDir);
  const mine = found && found.binding.provider === providerId ? found : null;
  if (mine) removeBinding(mine.root);
  const accountId = mine?.binding.account;
  const stillUsedBy = accountId ? projectsUsingAccount(accountId) : [];
  let loggedOut = false;
  if (opts.logout && accountId && getAccount(accountId)) {
    await logout(accountId, deps);
    loggedOut = true;
  }
  return { removed: Boolean(mine), stillUsedBy, loggedOut };
}

/**
 * What an MCP tool needs to make a call, or an error that says what to run.
 * Never falls back to another account: acting in the wrong system is worse than failing.
 */
export async function resolveReady(
  projectDir: string,
  deps: ServiceDeps = {}
): Promise<{ provider: IntegrationProvider; ctx: ProviderContext }> {
  const found = findBinding(projectDir);
  if (!found) {
    throw new IntegrationError(
      "no_account",
      "No integration is connected to this project.",
      "Run `kai integration azure` in the project folder."
    );
  }
  const { binding } = found;
  const provider = getProvider(binding.provider);
  if (!provider) {
    throw new IntegrationError(
      "config",
      `This project uses an unknown integration "${binding.provider}".`
    );
  }
  const account = getAccount(binding.account);
  if (!account) {
    // A cloud id is `<provider>:<org>`; a server id carries a host, so it holds a `/` or a port `:`.
    const key = binding.account.split(":").slice(1).join(":");
    const target = /[/:]/.test(key) ? `--server-url https://${key}` : `--org ${key}`;
    throw new IntegrationError(
      "no_account",
      `The account "${binding.account}" is signed out.`,
      `Run \`kai integration azure ${target}\` then retry.`
    );
  }
  return { provider, ctx: { account, binding, secrets: secretsOf(deps) } };
}

// ---------------------------------------------------------------------------
// RPC dispatch (the desktop app's entry point)
// ---------------------------------------------------------------------------

const RPC_PAT_MAX = 4096;

export async function handleRpc(
  providerId: string,
  request: IntegrationRpcRequest,
  deps: ServiceDeps = {}
): Promise<IntegrationRpcResponse> {
  switch (request.op) {
    case "status":
      return { ok: true, status: await getStatus(providerId, request.projectDir, deps) };
    case "login": {
      if (typeof request.pat === "string" && request.pat.length > RPC_PAT_MAX) {
        throw new IntegrationError("bad_request", "The token is too long.");
      }
      const result = await login(
        providerId,
        {
          org: request.org,
          baseUrl: request.baseUrl,
          authMethod: request.authMethod,
          pat: request.pat,
        },
        deps
      );
      return { ok: true, account: result.account, user: result.user };
    }
    case "verify":
      return { ok: true, user: await verifyAccount(request.account, deps) };
    case "projects":
      return { ok: true, projects: await listProjects(request.account, deps) };
    case "repos":
      return { ok: true, repos: await listRepos(request.account, request.project, deps) };
    case "logout":
      await logout(request.account, deps);
      return { ok: true, done: true };
    case "bind": {
      // An explicit project is a switch: it is checked against what the account can reach.
      const binding = request.project
        ? await switchActive(
            providerId,
            request.projectDir,
            {
              account: request.account,
              project: request.project,
              repo: request.repo,
              replace: request.replace,
            },
            deps
          )
        : bind(
            providerId,
            request.projectDir,
            { account: request.account, repo: request.repo, replace: request.replace },
            deps
          );
      return { ok: true, binding: bindingView(binding) };
    }
    case "unbind":
      await unbind(providerId, request.projectDir, { logout: request.logout }, deps);
      return { ok: true, done: true };
    default:
      throw new IntegrationError("bad_request", "Unknown operation.");
  }
}
