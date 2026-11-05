import type {
  IntegrationErrorBody,
  TeamsAccessView,
  TeamsStatusView,
} from "../core/integrations/rpcTypes";

/** Pure view logic for the Microsoft Teams card of the Integrations tab. */

export type TeamsCardState =
  /** Not asked yet. */
  | "loading"
  /** This build has no Microsoft Entra app, so sign-in cannot start. */
  | "not_configured"
  | "signed_out"
  | "signed_in";

export interface TeamsBadge {
  label: string;
  tone: "ok" | "warn" | "neutral";
}

export function deriveTeamsState(status: TeamsStatusView | null): TeamsCardState {
  if (!status) return "loading";
  if (status.account) return "signed_in";
  return status.configured ? "signed_out" : "not_configured";
}

export function teamsBadge(state: TeamsCardState): TeamsBadge {
  switch (state) {
    case "signed_in":
      return { label: "Signed in", tone: "ok" };
    case "signed_out":
      return { label: "Not signed in", tone: "neutral" };
    case "not_configured":
      return { label: "Not set up", tone: "warn" };
    default:
      return { label: "Checking…", tone: "neutral" };
  }
}

/** "Ada Lovelace (ada@contoso.com)", or just the name when there is no address. */
export function describeTeamsAccount(account: { name: string; email?: string }): string {
  return account.email && account.email !== account.name
    ? `${account.name} (${account.email})`
    : account.name;
}

/** The line shown after "Test connection". */
export function describeAccess(access: TeamsAccessView): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [`${plural(access.teams, "team")}`];
  parts.push(access.chats === null ? "chats unavailable" : plural(access.chats, "chat"));
  return `Signed in as ${access.user.email ?? access.user.name}: ${parts.join(", ")}.`;
}

/**
 * The error to show for a failed Teams call. A sign-in the build cannot start
 * (no Microsoft app registered) is a maintainer problem, so say so plainly
 * instead of leaving a person to retry a button that cannot work.
 */
export function explainTeamsError(error: IntegrationErrorBody): IntegrationErrorBody {
  if (error.code === "forbidden") {
    return {
      ...error,
      hint: "Your Teams sign-in is private to you: use it from Kai's own window, not from an agent.",
    };
  }
  if (error.code === "config") {
    const next = "This build of Kai has no Microsoft app registered for Teams yet.";
    return { ...error, hint: error.hint ? `${next} (Maintainers: ${error.hint})` : next };
  }
  return error;
}

/** Shown only when channel messages were not granted. Nothing is shown when they were. */
export const CHANNELS_NOTE = "Channel messages need admin approval.";
