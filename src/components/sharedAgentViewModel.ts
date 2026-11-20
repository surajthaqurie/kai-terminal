/**
 * Pure view logic for the Shared Agent panel: the joined PC's state and how
 * to say so. No React, no IPC, so the wording and the rules are unit tested.
 */
import {
  totalTokens,
  type AgentView,
  type JoinedHost,
  type TaskStatus,
  type TokenTotals,
} from "../core/sharedAgent/types";

export type RouteTone = "ok" | "warn" | "bad" | "idle";

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
 * The state of the PC being chatted with, and what to tell the person about it.
 * Chat only ever goes to a joined PC: nothing answers on this one.
 */
export function describeRoute(host: JoinedHost | null): RouteView {
  if (!host) {
    return {
      tone: "idle",
      badge: "NOT JOINED",
      title: "No PC joined",
      detail: "Paste an invite link to chat with another PC's agent.",
    };
  }
  if (!host.connected) {
    return {
      tone: "bad",
      badge: "REMOVED",
      title: `${host.name} removed this PC`,
      detail: "Join again with a new invite link.",
    };
  }
  if (host.online === null) {
    return { tone: "idle", badge: "CHECKING", title: `Checking ${host.name}…`, detail: "" };
  }
  if (host.online) {
    return {
      tone: "ok",
      badge: "LIVE",
      title: `Connected to ${host.name}`,
      detail: host.latencyMs === null ? "" : `latency ${host.latencyMs} ms`,
    };
  }
  return {
    tone: "bad",
    badge: "OFFLINE",
    title: `${host.name} is offline`,
    detail: "Send your message again when it is back.",
  };
}

/** Assumed while a PC is still being checked, so the first message need not wait for it. */
const ASSUMED_AGENT: AgentView = { id: "claude", name: "Claude Code", available: true };

/** The agents the person can pick for the next message: only the joined PC's. */
export function agentChoices(host: JoinedHost | null): AgentView[] {
  if (!host?.connected) return [];
  const shared = host.agents.filter((a) => a.available);
  if (shared.length) return shared;
  // Not checked yet: let the person type and send; the PC says if it can't answer.
  return host.online === null ? [ASSUMED_AGENT] : [];
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

/** 184_213 -> "184k", 1_250_000 -> "1.3M" */
export function formatCompact(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** "Amit-Laptop" -> "AL", "office" -> "OF" */
export function initials(name: string): string {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out = parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : (parts[0] ?? name).slice(0, 2);
  return out.toUpperCase() || "?";
}
