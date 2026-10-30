import { findProvider, type IntegrationAuthMethod } from "../core/integrations/providerCatalog";
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

export function authMethodLabel(method: IntegrationAuthMethod): string {
  return method === "oauth" ? "Browser sign-in" : method === "az" ? "Azure CLI" : "Access token";
}

/**
 * The account "Use for this project" binds by default: the one whose
 * organization matches the git remote, else the first usable account.
 */
export function preferredAccountId(status: IntegrationStatusView | null): string | null {
  if (!status || status.accounts.length === 0) return null;
  const org = status.project.detected?.org.toLowerCase();
  const matching = org ? status.accounts.find((a) => a.org.toLowerCase() === org) : undefined;
  return (matching ?? status.accounts[0]).id;
}

export function describeDetected(detected: DetectedCoordinates | null): string | null {
  if (!detected) return null;
  return [detected.org, detected.project, detected.repo].filter(Boolean).join(" / ");
}

export function describeAccount(account: IntegrationAccountView): string {
  const parts = [account.org, authMethodLabel(account.authMethod)];
  if (account.user) parts.push(account.user);
  return parts.join(" · ");
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
