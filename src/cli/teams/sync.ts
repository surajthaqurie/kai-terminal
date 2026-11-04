import type { ChatInfo, TeamsMessage } from "../../core/teams/graph";

/**
 * The rules behind the chat's automatic sync, kept as plain functions so they
 * can be tested without a terminal or a network: how often to refresh, how to
 * merge what arrives with what is on screen, and who has unread messages.
 */

export interface SyncTiming {
  /** How often the open conversation refreshes while the window has focus. */
  focusedMs: number;
  /** ...and while it does not. */
  idleMs: number;
  /** How often the chat list (order, unread markers) and watched conversations refresh. */
  sidebarMs: number;
  /** The longest wait after repeated failures. */
  maxBackoffMs: number;
  /** The shortest wait after Microsoft says to slow down. */
  rateLimitMs: number;
  /** How many conversations opened this session are kept up to date in the background. */
  watchedMax: number;
}

export const DEFAULT_TIMING: SyncTiming = {
  focusedMs: 6_000,
  idleMs: 30_000,
  sidebarMs: 20_000,
  maxBackoffMs: 120_000,
  rateLimitMs: 45_000,
  watchedMax: 6,
};

/** The wait before the next sync: the normal interval, doubled per failure up to a cap. */
export function nextDelayMs(o: {
  focused: boolean;
  failures: number;
  rateLimited?: boolean;
  timing?: SyncTiming;
}): number {
  const t = o.timing ?? DEFAULT_TIMING;
  const base = o.focused ? t.focusedMs : t.idleMs;
  if (o.failures <= 0) return base;
  const backoff = Math.min(t.maxBackoffMs, base * 2 ** Math.min(o.failures, 16));
  return o.rateLimited ? Math.max(backoff, t.rateLimitMs) : backoff;
}

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

const byTime = (a: TeamsMessage, b: TeamsMessage): number =>
  time(a.at) - time(b.at) || a.id.localeCompare(b.id);

/**
 * Merge the newest page into what is already loaded. Messages inside the new
 * page replace their old copies (so edits show) and old copies that are no
 * longer in it are dropped (deleted); anything older than the page stays, so
 * earlier messages the user scrolled back to are not lost.
 */
export function mergeLatest(
  old: readonly TeamsMessage[],
  fresh: readonly TeamsMessage[]
): TeamsMessage[] {
  if (fresh.length === 0) return [...old];
  const windowStart = Math.min(...fresh.map((m) => time(m.at)));
  const kept = old.filter((m) => time(m.at) < windowStart);
  return [...kept, ...fresh].sort(byTime);
}

/** Add an older page in front, ignoring messages already loaded. */
export function mergeOlder(
  old: readonly TeamsMessage[],
  older: readonly TeamsMessage[]
): TeamsMessage[] {
  const have = new Set(old.map((m) => m.id));
  return [...older.filter((m) => !have.has(m.id)), ...old].sort(byTime);
}

/** When the newest message in a list was sent (ms), or 0. */
export function newestAt(list: readonly TeamsMessage[]): number {
  let n = 0;
  for (const m of list) n = Math.max(n, time(m.at));
  return n;
}

/**
 * Whether a chat has something you have not seen: its newest message is from
 * someone else and newer than both what you read in any Teams client and what
 * you have seen here.
 */
export function chatHasUnread(chat: ChatInfo, myId: string, seenAt: number): boolean {
  const last = time(chat.lastAt);
  if (last === 0 || (chat.lastFromId !== "" && chat.lastFromId === myId)) return false;
  return last > Math.max(seenAt, time(chat.lastReadAt));
}

/** Messages from other people that are newer than `seenAt`. */
export function unseenFromOthers(
  list: readonly TeamsMessage[],
  myId: string,
  seenAt: number
): TeamsMessage[] {
  return list.filter((m) => !m.system && m.fromId !== myId && time(m.at) > seenAt);
}

export type SyncState = "starting" | "syncing" | "ok" | "offline" | "expired";

export interface SyncStatus {
  state: SyncState;
  /** When the last sync finished (ms). */
  at?: number;
  /** When the next attempt is due after a failure (ms). */
  retryAt?: number;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const clock = (ms: number, seconds = false): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${seconds ? `:${pad2(d.getSeconds())}` : ""}`;
};

/** The short status shown in the header. */
export function syncLabel(s: SyncStatus): string {
  switch (s.state) {
    case "starting":
      return "connecting...";
    case "syncing":
      return s.at ? `syncing... (last ${clock(s.at)})` : "syncing...";
    case "ok":
      return s.at ? `synced ${clock(s.at)}` : "synced";
    case "offline":
      return s.retryAt ? `offline, retry ${clock(s.retryAt, true)}` : "offline";
    case "expired":
      return "sign-in expired";
  }
}
