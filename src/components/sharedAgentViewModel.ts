/**
 * Pure view logic for the Shared Agent panel: which Claude is answering and
 * how to say so. No React, no IPC, so the wording and the rules are unit tested.
 */
import {
  totalTokens,
  type AgentView,
  type JoinedHost,
  type TaskStatus,
  type TokenTotals,
} from "../core/sharedAgent/types";

export type RouteTone = "ok" | "warn" | "own" | "bad" | "idle";

export interface RouteView {
  tone: RouteTone;
  badge: string;
  title: string;
  detail: string;
}

export const formatTokens = (n: number): string =>
  Math.max(0, Math.round(n)).toLocaleString("en-US");

export const tokenBreakdown = (t: TokenTotals): string =>
  `Input ${formatTokens(t.input)} · output ${formatTokens(t.output)} · cache read ${formatTokens(
    t.cacheRead
  )} · cache write ${formatTokens(t.cacheWrite)}`;

export const tokensUsed = (t: TokenTotals): string => formatTokens(totalTokens(t));

/** 905 -> "15:05" */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return "never";
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Which Claude answers right now, and what to tell the person about it.
 * Routing is automatic: the joined PC first, this PC's own agent whenever that
 * PC can't answer.
 */
export function describeRoute(input: {
  host: JoinedHost | null;
  ownAvailable: boolean;
}): RouteView {
  const { host, ownAvailable } = input;
  if (!host) {
    return ownAvailable
      ? {
          tone: "own",
          badge: "OWN",
          title: "Using your own Claude",
          detail: "No PC joined yet. Join one below to use its Claude.",
        }
      : {
          tone: "idle",
          badge: "NO AGENT",
          title: "No agent yet",
          detail: "Join a PC below to chat with its Claude.",
        };
  }
  if (!host.connected) {
    return {
      tone: "bad",
      badge: "REMOVED",
      title: `${host.name} removed this PC`,
      detail: `Join again with a new invite link.${ownAvailable ? " Your own Claude answers meanwhile." : ""}`,
    };
  }
  if (host.online === null) {
    return { tone: "idle", badge: "CHECKING", title: `Checking ${host.name}…`, detail: "" };
  }
  if (host.online) {
    return {
      tone: "ok",
      badge: "LIVE",
      title: `Claude is using the shared agent · ${host.name}`,
      detail: [
        host.latencyMs === null ? "" : `latency ${host.latencyMs} ms`,
        ownAvailable ? "switches to your own Claude if it stops answering" : "",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  if (ownAvailable) {
    return {
      tone: "own",
      badge: "FALLBACK",
      title: "Host offline: your own Claude is answering",
      detail: `${host.name} is not responding. It switches back when ${host.name} returns.`,
    };
  }
  return {
    tone: "bad",
    badge: "OFFLINE",
    title: `${host.name} is offline`,
    detail: "Claude isn't installed on this PC, so messages wait until it is back.",
  };
}

/** The agents the person can pick for the next message. */
export function agentChoices(input: {
  host: JoinedHost | null;
  ownAgents: AgentView[];
}): AgentView[] {
  const own = input.ownAgents.filter((a) => a.available);
  if (!input.host?.connected) return own;
  const shared = input.host.agents.filter((a) => a.available);
  // A host that has not answered yet, or is offline, still lets a fallback agent be chosen.
  return shared.length ? shared : own;
}

export const hostStatusPill = (h: JoinedHost): { label: string; tone: RouteTone } => {
  if (!h.connected) return { label: "Removed", tone: "bad" };
  if (h.online === null) return { label: "Checking", tone: "idle" };
  return h.online ? { label: "Connected", tone: "ok" } : { label: "Offline", tone: "bad" };
};

export const formatCost = (usd: number): string =>
  usd > 0 && usd < 0.01 ? "<$0.01" : `$${Math.max(0, usd).toFixed(2)}`;

/** 7.25 -> "7s", 125 -> "2m 05s" */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export const TASK_STATUS_LABELS: Record<TaskStatus, { label: string; cls: string }> = {
  completed: { label: "Done", cls: "sa-badge-ok" },
  failed: { label: "Failed", cls: "sa-badge-bad" },
  stopped: { label: "Stopped", cls: "sa-badge-warn" },
  timeout: { label: "Timed out", cls: "sa-badge-warn" },
};
