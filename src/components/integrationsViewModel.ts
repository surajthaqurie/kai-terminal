import { findProvider, type IntegrationAuthMethod } from "../core/integrations/providerCatalog";
import { parseAzureRemote } from "../core/integrations/providers/azure-devops/remote";
import type {
  DetectedCoordinates,
  IntegrationAccountView,
  IntegrationBindingView,
  IntegrationErrorBody,
  IntegrationProjectView,
  IntegrationRepoView,
  IntegrationStatusView,
} from "../core/integrations/rpcTypes";

/** What a provider card shows. At most one integration is ever "active" per project. */
export type CardState = "not_connected" | "connected" | "active" | "signed_out";

export interface BadgeView {
  label: string;
  tone: "muted" | "ok" | "warn";
}

export function deriveCardState(status: IntegrationStatusView | null): CardState {
  if (!status) return "not_connected";
  const { state } = status.project;
  if (state === "ready") return "active";
  if (state === "signed_out" || state === "account_missing") return "signed_out";
  return status.accounts.length > 0 ? "connected" : "not_connected";
}

const BADGES: Record<CardState, BadgeView> = {
  not_connected: { label: "Not connected", tone: "muted" },
  connected: { label: "Connected", tone: "ok" },
  active: { label: "Active for this project", tone: "ok" },
  signed_out: { label: "Sign-in needed", tone: "warn" },
};

export function badgeFor(state: CardState): BadgeView {
  return BADGES[state];
}

/**
 * The error to show when browser sign-in fails. When this build has no
 * Microsoft app registered (a `config` error), the panel has no other way to
 * sign in, so it points at the terminal command that does.
 */
export function explainSignInError(error: IntegrationErrorBody): IntegrationErrorBody {
  if (error.code !== "config") return error;
  const next =
    'To sign in now, run "kai integration azure" in a terminal: it signs in with the Azure CLI or an access token instead.';
  return { ...error, hint: error.hint ? `${next} (Maintainers: ${error.hint})` : next };
}

export function authMethodLabel(method: IntegrationAuthMethod): string {
  return method === "oauth" ? "Browser sign-in" : method === "az" ? "Azure CLI" : "Access token";
}

/** Same hosts the CLI treats as Azure DevOps Services; anything else is an on-premises Server. */
function isCloudHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "dev.azure.com" || h.endsWith(".visualstudio.com");
}

function hostOf(address: string): string | null {
  try {
    return new URL(address).host;
  } catch {
    return null;
  }
}

/** True for an on-premises Azure DevOps Server address (not dev.azure.com / visualstudio.com). */
export function isServerAddress(baseUrl: string): boolean {
  try {
    return !isCloudHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function isServerAccount(account: Pick<IntegrationAccountView, "baseUrl">): boolean {
  return isServerAddress(account.baseUrl);
}

/**
 * How an account is named in lists and labels: the organization for Azure DevOps
 * Services, `collection @ host` for a Server (two servers can share a collection name).
 */
export function accountName(account: Pick<IntegrationAccountView, "org" | "baseUrl">): string {
  if (!isServerAddress(account.baseUrl)) return account.org;
  const host = hostOf(account.baseUrl);
  return host ? `${account.org} @ ${host}` : account.org;
}

const sameAddress = (a: string, b: string): boolean =>
  a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

/**
 * True when the folder's git remote belongs to this account: the same
 * organization on Azure DevOps Services, or the same collection on the same
 * host for a Server (a collection name alone is not enough: `DefaultCollection`
 * exists on every server).
 */
export function accountMatchesRemote(
  account: Pick<IntegrationAccountView, "org" | "baseUrl">,
  detected: Pick<DetectedCoordinates, "org" | "baseUrl"> | null | undefined
): boolean {
  if (!detected || account.org.toLowerCase() !== detected.org.toLowerCase()) return false;
  if (!isServerAddress(account.baseUrl) && !isServerAddress(detected.baseUrl)) return true;
  return sameAddress(account.baseUrl, detected.baseUrl);
}

/**
 * The account "Use for this project" binds by default: the one whose
 * organization matches the git remote, else the first usable account.
 */
export function preferredAccountId(status: IntegrationStatusView | null): string | null {
  if (!status || status.accounts.length === 0) return null;
  const detected = status.project.detected;
  const matching = status.accounts.find((a) => accountMatchesRemote(a, detected));
  return (matching ?? status.accounts[0]).id;
}

export function describeDetected(detected: DetectedCoordinates | null): string | null {
  if (!detected) return null;
  return [detected.org, detected.project, detected.repo].filter(Boolean).join(" / ");
}

export function describeAccount(account: IntegrationAccountView): string {
  const parts = [accountName(account), authMethodLabel(account.authMethod)];
  if (account.user) parts.push(account.user);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Azure DevOps Server form
// ---------------------------------------------------------------------------

/** Longest token the CLI accepts (`RPC_PAT_MAX` in the integration service). */
export const SERVER_TOKEN_MAX = 4096;
const PROJECT_MAX = 256;

export interface ServerFormInput {
  url: string;
  /** Optional: empty means "use the folder's remote, or let me pick from a list". */
  project: string;
  token: string;
}

export interface ServerFormErrors {
  url?: string;
  project?: string;
  token?: string;
}

export interface ServerFormValue {
  baseUrl: string;
  project: string | null;
  token: string;
}

export type ServerAddressCheck =
  { ok: true; baseUrl: string; project?: string } | { ok: false; message: string };

const EXAMPLE_URL = "https://tfs.contoso.com/DefaultCollection";

/**
 * Checks a typed Server address with the rules the CLI applies to
 * `--server-url`: http(s) only, no credentials in the address, a collection in
 * the path, and the normalized `origin + path` as the stored address. A pasted
 * clone address (`.../<collection>/<project>/_git/<repo>`) is reduced to its
 * collection, and its project is offered back.
 */
export function checkServerAddress(raw: string): ServerAddressCheck {
  const text = raw.trim();
  if (!text) return { ok: false, message: "Enter the server address." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: `That is not a valid address. Use a form like ${EXAMPLE_URL}.` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: "The address must start with https:// (or http://)." };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      message:
        "Remove the user name and password from the address; the token goes in its own field.",
    };
  }
  if (isCloudHost(url.hostname)) {
    return {
      ok: false,
      message:
        "That is an Azure DevOps Services address. Close this form and choose Connect Azure DevOps instead.",
    };
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.includes("_git")) {
    const parsed = parseAzureRemote(`${url.origin}${url.pathname}`);
    if (!parsed) {
      return {
        ok: false,
        message: `Use the collection address, without /_git/. Example: ${EXAMPLE_URL}.`,
      };
    }
    return { ok: true, baseUrl: parsed.baseUrl, project: parsed.project };
  }
  if (segments.length === 0) {
    return {
      ok: false,
      message: `Add the collection to the address. Example: ${EXAMPLE_URL}.`,
    };
  }
  return { ok: true, baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
}

/** Validates the whole Server form; every problem is reported at once, next to its field. */
export function validateServerForm(
  input: ServerFormInput
): { ok: true; value: ServerFormValue } | { ok: false; errors: ServerFormErrors } {
  const errors: ServerFormErrors = {};

  const address = checkServerAddress(input.url);
  if (!address.ok) errors.url = address.message;

  let project: string | null = input.project.trim() || null;
  if (project) {
    // eslint-disable-next-line no-control-regex
    if (/[\\/\u0000-\u001f]/.test(project) || project.length > PROJECT_MAX) {
      errors.project = "That is not a project name. Use the name only, without slashes.";
    }
  } else if (address.ok && address.project) {
    project = address.project;
  }

  const token = input.token.trim();
  if (!token) errors.token = "Enter an access token.";
  else if (/\s/.test(token)) errors.token = "A token has no spaces or line breaks. Paste it again.";
  else if (token.length > SERVER_TOKEN_MAX) errors.token = "That token is too long.";

  if (Object.keys(errors).length > 0 || !address.ok) return { ok: false, errors };
  return { ok: true, value: { baseUrl: address.baseUrl, project, token } };
}

/** True when the account keeps a stored credential and it is gone. */
export function needsRelogin(account: IntegrationAccountView): boolean {
  return account.authMethod !== "az" && !account.hasCredential;
}

/** Display name of a provider id, falling back to the id itself. */
export function providerLabel(id: string | null): string {
  if (!id) return "another integration";
  return findProvider(id)?.label ?? id;
}

export function formatError(error: IntegrationErrorBody): { message: string; hint?: string } {
  return error.hint ? { message: error.message, hint: error.hint } : { message: error.message };
}

/** The project a "Switch project" picker preselects: the active one, else the first. */
export function pickSwitchProject(
  projects: readonly IntegrationProjectView[],
  current: string
): string {
  const wanted = current.toLowerCase();
  const match = projects.find((p) => p.name.toLowerCase() === wanted);
  return (match ?? projects[0])?.name ?? current;
}

/**
 * The repository to preselect after the project changes: the current one when
 * it also exists in the new project (canonical spelling), otherwise none.
 */
export function pickRepoForProject(
  repos: readonly IntegrationRepoView[],
  currentRepo: string | null
): string | null {
  if (!currentRepo) return null;
  const wanted = currentRepo.toLowerCase();
  return repos.find((r) => r.name.toLowerCase() === wanted)?.name ?? null;
}

/** True when applying would not change the binding. */
export function isSameSelection(
  binding: Pick<IntegrationBindingView, "project" | "repo">,
  project: string,
  repo: string | null
): boolean {
  return binding.project === project && (binding.repo ?? null) === (repo ?? null);
}
