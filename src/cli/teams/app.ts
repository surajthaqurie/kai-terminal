import crypto from "crypto";
import fs from "fs";
import path from "path";
import { readClipboardAttachments, splitPastedPaths } from "../../core/teams/clipboard";
import { fileUploadSource } from "../../core/teams/fileSource";
import {
  MAX_FILE_BYTES,
  MAX_UPLOAD_BYTES,
  describeBytes,
  type ChannelInfo,
  type ChatInfo,
  type GraphClient,
  type Target,
  type TeamInfo,
  type TeamsMessage,
} from "../../core/teams/graph";
import { sanitize } from "../../core/teams/html";
import { extensionFor, sniffImage } from "../../core/teams/images";
import { privateTempDir } from "../../core/teams/tempdir";
import type { TeamsAccount } from "../../core/teams/config";
import { IntegrationError } from "../../core/integrations/types";
import { buildTeamsSignal } from "../../core/teamsSignal";
import { openInBrowser } from "../../core/integrations/providers/azure-devops/oauth";
import { InputParser, type InputEvent } from "./input";
import { openPath } from "./open";
import {
  formatSize,
  hitAt,
  layout,
  type Action,
  type Frame,
  type NoticeKind,
  type SearchResult,
  type SidebarItem,
  type ViewMessage,
  type ViewModel,
} from "./render";
import { Screen, supportsInlineImages } from "./screen";
import {
  DEFAULT_TIMING,
  chatHasUnread,
  mergeLatest,
  mergeOlder,
  newestAt,
  nextDelayMs,
  syncLabel,
  unseenFromOthers,
  type SyncStatus,
  type SyncTiming,
} from "./sync";

/**
 * The interactive Teams chat: a sidebar of teams, channels and chats; the
 * conversation with images drawn inline where the terminal can; and a message
 * box. Everything is clickable, and everything also works from the keyboard.
 *
 * It keeps itself up to date: the open conversation refreshes every few
 * seconds (slower while the window is not focused), the chat list refreshes
 * on its own schedule and marks conversations with unseen messages, a failed
 * sync backs off and recovers by itself, and an expired sign-in is reported
 * instead of retried forever.
 */

export interface ChatOptions {
  graph: GraphClient;
  account: TeamsAccount;
  canReadChannels: boolean;
  screen?: Screen;
  env?: NodeJS.ProcessEnv;
  openFile?: (file: string) => void;
  openUrl?: (url: string) => void;
  readClipboard?: () => Promise<string[]>;
  /** Shorthand (mostly for tests): use this one interval for every refresh. */
  pollMs?: number;
  /** Sync timing overrides. */
  sync?: Partial<SyncTiming>;
  tmpDir?: string;
  now?: () => number;
}

interface Attachment {
  name: string;
  /** Where it came from; a large file is read from here, a piece at a time, when it is sent. */
  path: string;
  size: number;
  /** The content, held only for a small file (4 MB or less); null for a large one. */
  bytes: Uint8Array | null;
  mime: string;
  image: boolean;
}

interface Conv {
  key: string;
  title: string;
  teamName?: string;
  target: Target;
}

/** A message sent from here that Teams has not shown back yet. */
interface LocalMessage extends TeamsMessage {
  /** Teams accepted it; it stays until the refreshed list shows it. */
  sent: boolean;
  /** Refreshes that did not show it yet. */
  misses: number;
}

interface ConvData {
  list: TeamsMessage[];
  loading: boolean;
  error: string | null;
  blocked: boolean;
  /** Address of the next older page: a string, null for "no more", undefined for "not known yet". */
  next: string | null | undefined;
  loadingOlder: boolean;
  local: LocalMessage[];
}

interface Draft {
  input: string;
  cursor: number;
  pending: Attachment[];
}

interface ImageEntry {
  state: "loading" | "ready" | "failed";
  b64?: string;
  width?: number;
  height?: number;
}

interface TeamNode {
  team: TeamInfo;
  channels: ChannelInfo[] | null;
  error: string | null;
}

/** A search result and what opening it does. */
type Found = SearchResult & {
  open:
    | { kind: "conv"; key: string }
    | { kind: "person"; name: string }
    | { kind: "message"; key: string; id: string };
};

const MAX_ATTACHMENTS = 4;
const MAX_PEOPLE_RESULTS = 8;
const MAX_CONV_RESULTS = 12;
const MAX_MESSAGE_RESULTS = 40;
/** Pictures fetched per screen when they scroll into view. */
const MAX_VISIBLE_FETCH = 4;
const HIGHLIGHT_MS = 4000;
const MAX_FILE_TEXT = describeBytes(MAX_FILE_BYTES);
const MAX_INLINE_PREFETCH = 8;
const WATCH_FETCH = 5;
const LOCAL_MISS_LIMIT = 3;
const BLOCKED_TEXT =
  "Reading channel messages needs your administrator's approval. You can still send messages here. To ask for the permission, run: kai integration teams --channels";
const EXPIRED_TEXT =
  "Your Microsoft sign-in has expired. Press Esc to leave, then run: kai integration teams";

/** The host of an https address, or "" for anything else. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.hostname : "";
  } catch {
    return "";
  }
}

export function errorText(e: unknown): string {
  if (e instanceof IntegrationError) return e.hint ? `${e.message} ${e.hint}` : e.message;
  return e instanceof Error ? e.message : String(e);
}

const isAuthError = (e: unknown): boolean => e instanceof IntegrationError && e.code === "auth";

/** Worth retrying later: the network, throttling, or something that is not a Teams answer at all. */
const isTransient = (e: unknown): boolean =>
  !(e instanceof IntegrationError) || e.code === "network" || e.code === "rate_limited";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local `HH:MM` and a day label ("Today", "Yesterday" or the date) for an ISO time. */
export function timeParts(iso: string, now: Date): { time: string; day: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { time: "", day: "" };
  const ymd = (x: Date) => `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const day = ymd(d) === ymd(now) ? "Today" : ymd(d) === ymd(yesterday) ? "Yesterday" : ymd(d);
  return { time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`, day };
}

export class ChatApp {
  private readonly screen: Screen;
  private readonly parser = new InputParser();
  private readonly inline: boolean;
  private readonly timing: SyncTiming;
  private readonly now: () => number;
  private readonly openFile: (file: string) => void;
  private readonly openUrl: (url: string) => void;
  private readonly readClipboard: () => Promise<string[]>;

  private teams: TeamNode[] = [];
  private chats: ChatInfo[] | null = null;
  private convs = new Map<string, Conv>();
  private data = new Map<string, ConvData>();
  private images = new Map<string, ImageEntry>();
  private selKey: string | null = null;
  private structureLoaded = false;
  private chatsWarned = false;

  /** Newest message time (ms) the user has seen in each conversation. */
  private seen = new Map<string, number>();
  /**
   * Conversations with messages you have not seen, and how many. 0 means "unread, count not
   * known": the chat list only says the newest message is unseen.
   */
  private unread = new Map<string, number>();
  /** Conversations opened this session, most recent last: kept fresh in the background. */
  private watched: string[] = [];
  private drafts = new Map<string, Draft>();

  private input = "";
  private cursor = 0;
  private pending: Attachment[] = [];
  private notice: { text: string; kind: NoticeKind } | null = null;
  private noticeTimer: NodeJS.Timeout | null = null;
  private scroll = 0;
  /** Sidebar rows scrolled by the wheel; null keeps the selected conversation in view. */
  private sidebarScroll: number | null = null;
  private search: { query: string; cursor: number; selected: number } | null = null;
  private searchCache: { query: string; results: Found[] } | null = null;
  /** Scroll to this message on the next draw (a search result was opened). */
  private focusId: string | null = null;
  private highlight: { id: string; query: string } | null = null;
  private highlightTimer: NodeJS.Timeout | null = null;
  /** Messages that arrived below while the reader was scrolled up. */
  private newBelow = 0;
  /** The newest message drawn and the lines from its start to the end, to keep the reader's place. */
  private anchor: { key: string; id: string; below: number } | null = null;
  /** The unread count last told to the tab bar. */
  private lastSignal: number | null = null;
  private sending = false;
  private localSeq = 0;

  private status: SyncStatus = { state: "starting" };
  private failures = 0;
  private rateLimited = false;
  private focused = true;
  private syncing = false;
  private lastSidebarAt = 0;
  private syncTimer: NodeJS.Timeout | null = null;
  private closed = false;

  private frame: Frame | null = null;
  private renderQueued = false;
  private done: (() => void) | null = null;
  private onData = (chunk: string) => this.handleChunk(chunk);
  private onResize = () => {
    this.screen.invalidate();
    this.render();
  };

  constructor(private readonly opts: ChatOptions) {
    this.screen = opts.screen ?? new Screen();
    this.inline = supportsInlineImages(opts.env ?? process.env);
    this.now = opts.now ?? Date.now;
    this.timing = {
      ...DEFAULT_TIMING,
      ...(opts.pollMs !== undefined
        ? { focusedMs: opts.pollMs, idleMs: opts.pollMs, sidebarMs: opts.pollMs }
        : {}),
      ...opts.sync,
    };
    this.openFile = opts.openFile ?? openPath;
    this.openUrl = opts.openUrl ?? openInBrowser;
    this.readClipboard = opts.readClipboard ?? (() => readClipboardAttachments());
  }

  /** Runs until the user quits. */
  async run(): Promise<void> {
    const finished = new Promise<void>((resolve) => {
      this.done = resolve;
    });
    this.screen.enter(this.onData);
    process.stdout.on("resize", this.onResize);
    const restore = () => this.screen.leave(this.onData);
    process.once("exit", restore);
    this.render();
    void this.syncOnce().finally(() => this.scheduleSync());
    try {
      await finished;
    } finally {
      this.closed = true;
      if (this.syncTimer) clearTimeout(this.syncTimer);
      if (this.noticeTimer) clearTimeout(this.noticeTimer);
      if (this.highlightTimer) clearTimeout(this.highlightTimer);
      process.stdout.off("resize", this.onResize);
      this.screen.signal?.(buildTeamsSignal(null));
      process.off("exit", restore);
      this.screen.leave(this.onData);
    }
  }

  quit(): void {
    this.done?.();
  }

  // ---- sync ------------------------------------------------------------------

  /**
   * One round of syncing: load the sidebar the first time (and again while it
   * could not load), refresh the chat list and watched conversations when due,
   * and refresh the open conversation. A network failure schedules a slower
   * retry; an expired sign-in stops the loop.
   */
  private async syncOnce(): Promise<void> {
    if (this.syncing || this.closed || this.status.state === "expired") return;
    this.syncing = true;
    const startedAt = this.now();
    this.status = {
      ...this.status,
      state: this.status.state === "starting" ? "starting" : "syncing",
    };
    this.render();
    try {
      if (!this.structureLoaded) {
        await this.loadStructure();
        this.lastSidebarAt = startedAt;
      } else if (startedAt - this.lastSidebarAt >= this.timing.sidebarMs) {
        await this.retryFailedTeams();
        await this.refreshChats(false);
        await this.refreshWatched();
        this.lastSidebarAt = startedAt;
      }
      const conv = this.selKey ? this.convs.get(this.selKey) : null;
      if (conv && !this.sending && !this.data.get(conv.key)?.loading) {
        await this.refreshConversation(conv);
      }
      this.failures = 0;
      this.rateLimited = false;
      this.status = { state: "ok", at: this.now() };
    } catch (e) {
      this.onSyncFailure(e);
    } finally {
      this.syncing = false;
      this.render();
    }
  }

  private onSyncFailure(e: unknown): void {
    if (isAuthError(e)) return this.markExpired();
    this.failures++;
    this.rateLimited = e instanceof IntegrationError && e.code === "rate_limited";
    const delay = nextDelayMs({
      focused: this.focused,
      failures: this.failures,
      rateLimited: this.rateLimited,
      timing: this.timing,
    });
    this.status = { state: "offline", at: this.status.at, retryAt: this.now() + delay };
  }

  private markExpired(): void {
    this.status = { state: "expired" };
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.setNotice(EXPIRED_TEXT, "error", 0);
  }

  private scheduleSync(): void {
    if (this.closed || this.status.state === "expired") return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    const delay = nextDelayMs({
      focused: this.focused,
      failures: this.failures,
      rateLimited: this.rateLimited,
      timing: this.timing,
    });
    this.syncTimer = setTimeout(
      () => void this.syncOnce().finally(() => this.scheduleSync()),
      delay
    );
    this.syncTimer.unref?.();
  }

  /** The window gained or lost focus: sync at once on return, and slow down while away. */
  private onFocus(focused: boolean): void {
    this.focused = focused;
    if (!focused || this.closed || this.status.state === "expired") return;
    this.readSelected();
    const stale = this.now() - (this.status.at ?? 0) >= this.timing.focusedMs;
    if (stale && !this.syncing) {
      if (this.syncTimer) clearTimeout(this.syncTimer);
      void this.syncOnce().finally(() => this.scheduleSync());
    }
    this.render();
  }

  // ---- data ------------------------------------------------------------------

  private ensureData(key: string): ConvData {
    let d = this.data.get(key);
    if (!d) {
      d = {
        list: [],
        loading: false,
        error: null,
        blocked: false,
        next: undefined,
        loadingOlder: false,
        local: [],
      };
      this.data.set(key, d);
    }
    return d;
  }

  /** Teams, their channels and the chat list. Throws when the network or the sign-in fails. */
  private async loadStructure(): Promise<void> {
    const teams = await this.opts.graph.joinedTeams();
    this.teams = teams.map((team) => ({ team, channels: null, error: null }));
    this.render();
    const chatsLoad = this.refreshChats(true);
    let next = 0;
    let transient: unknown = null;
    const worker = async () => {
      while (next < this.teams.length) {
        const node = this.teams[next++];
        try {
          await this.loadChannels(node);
        } catch (e) {
          if (isAuthError(e)) throw e;
          if (isTransient(e)) transient ??= e;
        }
        this.render();
      }
    };
    await Promise.all([chatsLoad, ...Array.from({ length: 4 }, worker)]);
    if (transient) throw transient;
    this.structureLoaded = true;
    if (!this.selKey) {
      const first = this.orderedKeys()[0];
      if (first) this.select(first);
    }
  }

  private async loadChannels(node: TeamNode): Promise<void> {
    try {
      node.channels = await this.opts.graph.channels(node.team.id);
      node.error = null;
      for (const ch of node.channels) {
        const key = `ch:${node.team.id}:${ch.id}`;
        this.convs.set(key, {
          key,
          title: ch.name,
          teamName: node.team.name,
          target: { kind: "channel", teamId: node.team.id, channelId: ch.id },
        });
      }
    } catch (e) {
      node.channels = node.channels ?? [];
      node.error = errorText(e);
      throw e;
    }
  }

  /** Teams whose channels could not be loaded earlier get another try. */
  private async retryFailedTeams(): Promise<void> {
    for (const node of this.teams) {
      if (!node.error) continue;
      try {
        await this.loadChannels(node);
      } catch (e) {
        if (isAuthError(e)) throw e;
      }
    }
  }

  /**
   * Reload the chat list: newest activity first, with a marker on every chat
   * that has messages from others you have not seen. The first load is silent;
   * later ones announce a conversation the first time it gets something new.
   */
  private async refreshChats(initial: boolean): Promise<void> {
    let chats: ChatInfo[];
    try {
      chats = await this.opts.graph.chats(this.opts.account.id);
    } catch (e) {
      if (isAuthError(e) || isTransient(e)) throw e;
      // Chats are not available to this account (permission): say so once and carry on.
      this.chats = this.chats ?? [];
      if (!this.chatsWarned) {
        this.chatsWarned = true;
        this.setNotice(`Chats: ${errorText(e)}`, "error", 0);
      }
      return;
    }
    this.chats = [...chats].sort(
      (a, b) => Date.parse(b.lastAt || "") - Date.parse(a.lastAt || "") || 0
    );
    const announce: ChatInfo[] = [];
    for (const chat of this.chats) {
      const key = `chat:${chat.id}`;
      this.convs.set(key, { key, title: chat.title, target: { kind: "chat", chatId: chat.id } });
      if (key === this.selKey && this.focused) {
        this.markSeen(key, Date.parse(chat.lastAt) || 0);
        this.unread.delete(key);
        continue;
      }
      const has = chatHasUnread(chat, this.opts.account.id, this.seen.get(key) ?? 0);
      if (has && !this.unread.has(key) && !initial && key !== this.selKey) announce.push(chat);
      if (has) {
        const n = this.countUnseen(key, Date.parse(chat.lastReadAt) || 0);
        this.unread.set(key, Math.max(n, this.unread.get(key) ?? 0));
      } else this.unread.delete(key);
    }
    this.announce(announce.map((c) => c.title));
    this.render();
  }

  /** Keep the conversations opened this session fresh, so their unread markers are right. */
  private async refreshWatched(): Promise<void> {
    const keys = this.watched.filter((k) => k !== this.selKey).slice(-this.timing.watchedMax);
    for (const key of keys) {
      const conv = this.convs.get(key);
      if (!conv || (conv.target.kind === "channel" && !this.opts.canReadChannels)) continue;
      try {
        const seenAt = this.seen.get(key) ?? 0;
        const page = await this.fetchLatest(conv, WATCH_FETCH);
        if (unseenFromOthers(page, this.opts.account.id, seenAt).length > 0) {
          if (!this.unread.has(key)) this.announce([conv.title]);
          this.unread.set(key, Math.max(this.countUnseen(key), this.unread.get(key) ?? 0));
        }
      } catch (e) {
        if (isAuthError(e) || isTransient(e)) throw e;
      }
    }
    this.render();
  }

  private announce(titles: string[]): void {
    if (titles.length === 0) return;
    this.setNotice(
      titles.length === 1
        ? `New message in ${titles[0]}`
        : `New messages in ${titles.length} conversations`,
      "ok"
    );
    if (!this.focused) this.screen.bell?.();
  }

  private orderedKeys(): string[] {
    const keys: string[] = [];
    for (const t of this.teams) {
      for (const ch of t.channels ?? []) keys.push(`ch:${t.team.id}:${ch.id}`);
    }
    for (const c of this.chats ?? []) keys.push(`chat:${c.id}`);
    return keys;
  }

  /** Messages from others in a loaded conversation newer than what you have seen (0 when not loaded). */
  private countUnseen(key: string, readAt = 0): number {
    const d = this.data.get(key);
    if (!d) return 0;
    const since = Math.max(this.seen.get(key) ?? 0, readAt);
    return unseenFromOthers(d.list, this.opts.account.id, since).length;
  }

  /** The open conversation is on screen in a focused window: everything in it is seen. */
  private readSelected(): void {
    if (!this.selKey) return;
    const d = this.data.get(this.selKey);
    if (d) this.markSeen(this.selKey, newestAt(d.list));
    this.unread.delete(this.selKey);
  }

  private markSeen(key: string, ms: number): void {
    if (ms > (this.seen.get(key) ?? 0)) this.seen.set(key, ms);
  }

  private touchWatched(key: string): void {
    this.watched = [...this.watched.filter((k) => k !== key), key].slice(
      -(this.timing.watchedMax + 1)
    );
  }

  private saveDraft(): void {
    if (!this.selKey) return;
    if (this.input === "" && this.pending.length === 0) this.drafts.delete(this.selKey);
    else
      this.drafts.set(this.selKey, {
        input: this.input,
        cursor: this.cursor,
        pending: this.pending,
      });
  }

  private select(key: string): void {
    const conv = this.convs.get(key);
    if (!conv) return;
    this.saveDraft();
    this.selKey = key;
    const draft = this.drafts.get(key);
    this.input = draft?.input ?? "";
    this.cursor = draft?.cursor ?? 0;
    this.pending = draft?.pending ?? [];
    this.scroll = 0;
    this.newBelow = 0;
    this.anchor = null;
    this.highlight = null;
    this.unread.delete(key);
    this.touchWatched(key);
    this.render();
    void this.openConversation(conv);
  }

  /** The user opened a conversation: show what we have, then load the newest messages. */
  private async openConversation(conv: Conv): Promise<void> {
    const d = this.ensureData(conv.key);
    d.loading = true;
    d.error = null;
    this.render();
    try {
      await this.refreshConversation(conv);
    } catch (e) {
      d.error = errorText(e);
      if (isAuthError(e)) this.markExpired();
    } finally {
      d.loading = false;
      this.render();
    }
  }

  /** Fetch the newest page and merge it in; returns what the page held. */
  private async fetchLatest(conv: Conv, top: number): Promise<TeamsMessage[]> {
    const page = await this.opts.graph.messagesPage(conv.target, { top });
    const d = this.ensureData(conv.key);
    d.list = d.list.length === 0 ? page.messages : mergeLatest(d.list, page.messages);
    if (d.next === undefined && top >= 30) d.next = page.next;
    d.error = null;
    this.reconcileLocal(d);
    return page.messages;
  }

  /** Drop sent messages the refreshed list now shows (or that never showed after a few tries). */
  private reconcileLocal(d: ConvData): void {
    const me = this.opts.account.id;
    d.local = d.local.filter((l) => {
      if (!l.sent) return true;
      const shown = d.list.some(
        (m) =>
          m.fromId === me &&
          Date.parse(m.at) >= Date.parse(l.at) - 60_000 &&
          (m.text === l.text || (l.text === "" && m.text === ""))
      );
      if (shown) return false;
      l.misses++;
      return l.misses < LOCAL_MISS_LIMIT;
    });
  }

  /** Refresh the open conversation. Network and sign-in problems are thrown; other errors are shown in the pane. */
  private async refreshConversation(conv: Conv): Promise<void> {
    if (conv.target.kind === "channel" && !this.opts.canReadChannels) {
      this.ensureData(conv.key).blocked = true;
      this.render();
      return;
    }
    const d = this.ensureData(conv.key);
    const before = d.list;
    const seenBefore = this.seen.get(conv.key) ?? newestAt(before);
    try {
      const page = await this.fetchLatest(conv, 30);
      if (conv.key === this.selKey) {
        // Only what arrived since the last refresh is news (not everything still unseen).
        const fresh =
          before.length > 0
            ? unseenFromOthers(page, this.opts.account.id, Math.max(seenBefore, newestAt(before)))
            : [];
        if (fresh.length > 0) {
          if (this.scroll > 0) this.newBelow += fresh.length;
          this.setNotice(`New message from ${fresh[fresh.length - 1].from}`, "ok");
          if (!this.focused) this.screen.bell?.();
        }
        if (this.focused) {
          this.markSeen(conv.key, newestAt(d.list));
          this.unread.delete(conv.key);
        } else {
          // Another tab or app has focus: what arrives here is not read yet.
          const n = this.countUnseen(conv.key);
          if (n > 0) this.unread.set(conv.key, n);
        }
      }
      this.prefetchImages(page);
    } catch (e) {
      if (isAuthError(e) || isTransient(e)) throw e;
      d.error = errorText(e);
    }
    this.render();
  }

  /** Load the page of messages before the oldest one shown. */
  private async loadOlder(conv: Conv): Promise<void> {
    const d = this.data.get(conv.key);
    if (!d || !d.next || d.loadingOlder) return;
    d.loadingOlder = true;
    this.render();
    try {
      const page = await this.opts.graph.messagesPage(conv.target, { pageUrl: d.next });
      d.list = mergeOlder(d.list, page.messages);
      d.next = page.next;
      this.prefetchImages(page.messages);
    } catch (e) {
      if (isAuthError(e)) this.markExpired();
      else this.setNotice(`Could not load earlier messages: ${errorText(e)}`, "error");
    } finally {
      d.loadingOlder = false;
      this.render();
    }
  }

  private prefetchImages(list: TeamsMessage[]): void {
    if (!this.inline) return;
    const wanted: string[] = [];
    for (const m of [...list].reverse()) {
      for (const img of m.images) {
        if (img.fetchable && !this.images.has(img.url) && wanted.length < MAX_INLINE_PREFETCH) {
          wanted.push(img.url);
        }
      }
    }
    for (const url of wanted) this.fetchImage(url);
  }

  /** Pictures in messages on screen that were not loaded yet (scrolled back to): load them now. */
  private loadVisibleImages(frame: Frame): void {
    if (!this.inline || !this.selKey || !frame.visibleIds?.length) return;
    const d = this.data.get(this.selKey);
    if (!d) return;
    const ids = new Set(frame.visibleIds);
    let started = 0;
    for (const m of d.list) {
      if (!ids.has(m.id)) continue;
      for (const img of m.images) {
        if (started >= MAX_VISIBLE_FETCH) return;
        if (img.fetchable && !this.images.has(img.url)) {
          this.fetchImage(img.url);
          started++;
        }
      }
    }
  }

  private fetchImage(url: string): void {
    {
      this.images.set(url, { state: "loading" });
      void this.opts.graph
        .image(url)
        .then(({ bytes }) => {
          const info = sniffImage(bytes);
          // Terminals draw PNG, JPEG and GIF inline; anything else (WebP) stays a clickable line.
          const drawable = info !== null && info.kind !== "webp";
          this.images.set(
            url,
            info && drawable
              ? {
                  state: "ready",
                  b64: Buffer.from(bytes).toString("base64"),
                  width: info.width,
                  height: info.height,
                }
              : { state: "failed" }
          );
        })
        .catch(() => this.images.set(url, { state: "failed" }))
        .finally(() => this.render());
    }
  }

  // ---- view ------------------------------------------------------------------

  private viewMessage(m: TeamsMessage, now: Date, pending: boolean): ViewMessage {
    const { time, day } = timeParts(m.at, now);
    return {
      id: m.id,
      time,
      day,
      from: m.from,
      mine: m.fromId !== "" && m.fromId === this.opts.account.id,
      system: m.system,
      text: m.text,
      pending,
      images: m.images.map((img) => {
        const e = this.images.get(img.url);
        return e?.state === "ready"
          ? {
              name: img.alt || "image",
              state: "inline" as const,
              b64: e.b64,
              width: e.width,
              height: e.height,
            }
          : {
              name: img.alt || "image",
              state: "link" as const,
              ...(img.fetchable ? {} : { host: hostOf(img.url) }),
            };
      }),
      files: m.files.map((f) => ({ name: f.name, ...(f.url ? { host: hostOf(f.url) } : {}) })),
    };
  }

  private viewModel(): ViewModel {
    const conv = this.selKey ? this.convs.get(this.selKey) : undefined;
    const d = conv ? this.data.get(conv.key) : undefined;
    const now = new Date(this.now());

    const sidebar: SidebarItem[] = [];
    sidebar.push({ kind: "heading", label: "Teams" });
    if (this.teams.length === 0) sidebar.push({ kind: "note", label: "Loading..." });
    for (const t of this.teams) {
      sidebar.push({ kind: "team", label: t.team.name });
      if (t.channels === null) sidebar.push({ kind: "note", label: "Loading..." });
      else if (t.error) sidebar.push({ kind: "note", label: "Could not load" });
      for (const ch of t.channels ?? []) {
        const key = `ch:${t.team.id}:${ch.id}`;
        sidebar.push({
          kind: "item",
          label: `# ${ch.name}`,
          key,
          selected: key === this.selKey,
          unread: this.unreadMark(key),
        });
      }
    }
    sidebar.push({ kind: "heading", label: "Chats" });
    if (this.chats === null) sidebar.push({ kind: "note", label: "Loading..." });
    for (const c of this.chats ?? []) {
      const key = `chat:${c.id}`;
      sidebar.push({
        kind: "item",
        label: c.title,
        key,
        selected: key === this.selKey,
        unread: this.unreadMark(key),
      });
    }

    const messages: ViewMessage[] = [
      ...(d?.list ?? []).map((m) => this.viewMessage(m, now, false)),
      ...(d?.local ?? []).map((m) => this.viewMessage(m, now, !m.sent)),
    ];

    let convNote: ViewModel["convNote"] = null;
    if (!conv) convNote = { text: "Pick a channel or a chat on the left.", kind: "info" };
    else if (d?.blocked) convNote = { text: BLOCKED_TEXT, kind: "info" };
    else if (d?.error && messages.length === 0) convNote = { text: d.error, kind: "error" };
    else if (!d || (d.loading && messages.length === 0))
      convNote = { text: "Loading messages...", kind: "info" };
    else if (messages.length === 0)
      convNote = { text: "No messages yet. Say hello.", kind: "info" };

    const title = conv
      ? `${conv.teamName ? `${conv.teamName} › # ` : ""}${conv.title}`
      : "kai teams";
    return {
      headerLeft: conv ? title : "kai teams",
      headerRight: `${syncLabel(this.status)}  ● ${this.opts.account.name}`,
      sidebar,
      convTitle: conv ? `Message ${conv.teamName ? "# " : ""}${conv.title}` : "",
      messages,
      convNote,
      older: d?.loadingOlder ? "loading" : d?.next ? "available" : "none",
      scroll: this.scroll,
      input: this.input,
      cursor: this.cursor,
      pending: this.pending.map((p) => ({
        name: p.name,
        size: formatSize(p.size),
        image: p.image,
      })),
      notice: this.notice,
      typing: "",
      sidebarScroll: this.sidebarScroll ?? undefined,
      search: this.search
        ? {
            query: this.search.query,
            cursor: this.search.cursor,
            selected: this.search.selected,
            results: this.searchResults(),
            scopeNote: this.searchScopeNote(),
          }
        : null,
      focusId: this.focusId,
      highlightId: this.highlight?.id ?? null,
      highlightQuery: this.highlight?.query ?? "",
      newBelow: this.newBelow,
      unreadTotal: this.unreadTotal(),
    };
  }

  /** What the sidebar shows for a conversation: a count, a dot (count not known), or nothing. */
  private unreadMark(key: string): number | boolean | undefined {
    const n = this.unread.get(key);
    if (n === undefined) return undefined;
    return n > 0 ? n : true;
  }

  /** Unread messages in all: a conversation whose count is not known counts once. */
  private unreadTotal(): number {
    let total = 0;
    for (const n of this.unread.values()) total += Math.max(1, n);
    return total;
  }

  private render(): void {
    if (this.renderQueued || this.closed) return;
    this.renderQueued = true;
    setImmediate(() => {
      this.renderQueued = false;
      if (this.closed) return;
      const { cols, rows } = this.screen.size();
      let frame = layout(this.viewModel(), cols, rows);
      // Lines added under the reader (new messages, a picture that loaded) would push what
      // they are reading up: move the scroll with them so the view stays put.
      const a = this.anchor;
      if (this.scroll > 0 && !this.focusId && a && a.key === this.selKey && frame.msgStart) {
        const start = frame.msgStart[a.id];
        const grew = start === undefined ? 0 : (frame.totalLines ?? 0) - start - a.below;
        if (grew > 0) {
          this.scroll += grew;
          frame = layout(this.viewModel(), cols, rows);
        }
      }
      if (frame.scroll !== undefined) this.scroll = frame.scroll;
      else if (this.scroll > frame.maxScroll) this.scroll = frame.maxScroll;
      this.focusId = null;
      if (this.scroll === 0) this.newBelow = 0;
      this.rememberAnchor(frame);
      this.frame = frame;
      this.screen.draw(frame);
      this.loadVisibleImages(frame);
      this.signalUnread();
    });
  }

  private rememberAnchor(frame: Frame): void {
    let id: string | null = null;
    let start = -1;
    for (const [k, v] of Object.entries(frame.msgStart ?? {})) {
      if (v > start) {
        start = v;
        id = k;
      }
    }
    this.anchor =
      id && this.selKey ? { key: this.selKey, id, below: (frame.totalLines ?? 0) - start } : null;
  }

  /** Tell Kai Terminal's tab bar how many messages are unread (only when it changes). */
  private signalUnread(): void {
    const total = this.unreadTotal();
    if (total === this.lastSignal) return;
    this.lastSignal = total;
    this.screen.signal?.(buildTeamsSignal(total));
  }

  private setNotice(text: string, kind: NoticeKind, ms = 6000): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.notice = { text, kind };
    if (ms > 0) {
      this.noticeTimer = setTimeout(() => {
        this.notice = null;
        this.render();
      }, ms);
      this.noticeTimer.unref?.();
    }
    this.render();
  }

  // ---- input -----------------------------------------------------------------

  private handleChunk(chunk: string): void {
    for (const ev of this.parser.feed(chunk)) this.handleEvent(ev);
  }

  /** Public for tests: drive the app with parsed events. */
  handleEvent(ev: InputEvent): void {
    if (this.search && ev.type !== "mouse" && ev.type !== "focus") return this.searchEvent(ev);
    if (ev.type === "text") return this.insert(ev.text);
    if (ev.type === "paste") return this.paste(ev.text);
    if (ev.type === "mouse") return this.mouse(ev);
    if (ev.type === "focus") return this.onFocus(ev.focused);
    if (ev.type === "ctrl") {
      if (ev.letter === "c" || ev.letter === "q") return this.quit();
      if (ev.letter === "v") return void this.attachFromClipboard();
      if (ev.letter === "j") return this.insert("\n");
      if (ev.letter === "u") return this.edit("", 0);
      if (ev.letter === "a") return this.moveTo(0);
      if (ev.letter === "e") return this.moveTo(this.input.length);
      if (ev.letter === "w") return this.deleteWord();
      if (ev.letter === "k" || ev.letter === "f") return this.openSearch();
      return;
    }
    switch (ev.key) {
      case "enter":
        return void this.send();
      case "newline":
        return this.insert("\n");
      case "backspace":
        return this.backspace();
      case "delete":
        return this.del();
      case "left":
        return this.moveTo(this.prevBoundary(this.cursor));
      case "right":
        return this.moveTo(this.nextBoundary(this.cursor));
      case "home":
        return this.moveTo(0);
      case "end":
        // With nothing typed, End jumps to the newest message.
        if (this.input === "" && this.scroll > 0) return this.jumpToLatest();
        return this.moveTo(this.input.length);
      case "up":
      case "down":
        if (this.input === "") this.switchConv(ev.key === "down" ? 1 : -1);
        return;
      case "pageup":
        return this.scrollBy(this.pageSize());
      case "pagedown":
        return this.scrollBy(-this.pageSize());
      case "escape":
        if (this.pending.length > 0) {
          this.pending = [];
          return this.render();
        }
        if (this.input !== "") return this.edit("", 0);
        return this.quit();
      default:
        return;
    }
  }

  private pageSize(): number {
    return Math.max(3, this.screen.size().rows - 8);
  }

  private scrollBy(delta: number): void {
    const max = this.frame?.maxScroll ?? 0;
    this.scroll = Math.max(0, Math.min(this.scroll + delta, max));
    // Reaching the top loads the page before it.
    if (delta > 0 && this.scroll >= max) {
      const conv = this.selKey ? this.convs.get(this.selKey) : null;
      if (conv) void this.loadOlder(conv);
    }
    this.render();
  }

  private switchConv(delta: number): void {
    const keys = this.orderedKeys();
    if (keys.length === 0) return;
    const i = this.selKey ? keys.indexOf(this.selKey) : -1;
    this.sidebarScroll = null;
    this.select(keys[(i + delta + keys.length) % keys.length]);
  }

  private jumpToLatest(): void {
    this.scroll = 0;
    this.newBelow = 0;
    this.render();
  }

  // ---- search ----------------------------------------------------------------

  private openSearch(): void {
    if (this.search) return this.closeSearch();
    this.search = { query: "", cursor: 0, selected: 0 };
    this.render();
  }

  private closeSearch(): void {
    this.search = null;
    this.searchCache = null;
    this.render();
  }

  /** Keys and typing while search is open go to the search field. */
  private searchEvent(ev: InputEvent): void {
    const s = this.search;
    if (!s) return;
    const setQuery = (query: string, cursor: number) => {
      s.query = query;
      s.cursor = Math.max(0, Math.min(cursor, query.length));
      s.selected = 0;
      this.render();
    };
    if (ev.type === "text" || ev.type === "paste") {
      const clean = sanitize(ev.text.replace(/\s+/g, " "));
      if (!clean) return;
      return setQuery(
        s.query.slice(0, s.cursor) + clean + s.query.slice(s.cursor),
        s.cursor + clean.length
      );
    }
    if (ev.type === "ctrl") {
      if (ev.letter === "c" || ev.letter === "q") return this.quit();
      if (ev.letter === "k" || ev.letter === "f") return this.closeSearch();
      if (ev.letter === "u") return setQuery("", 0);
      if (ev.letter === "a") return setQuery(s.query, 0);
      if (ev.letter === "e") return setQuery(s.query, s.query.length);
      return;
    }
    if (ev.type !== "key") return;
    const count = this.searchResults().length;
    const move = (d: number) => {
      if (count === 0) return;
      s.selected = Math.max(0, Math.min(count - 1, s.selected + d));
      this.render();
    };
    switch (ev.key) {
      case "escape":
        return this.closeSearch();
      case "enter":
      case "newline":
        return this.openResult(s.selected);
      case "up":
        return move(-1);
      case "down":
      case "tab":
        return move(1);
      case "pageup":
        return move(-8);
      case "pagedown":
        return move(8);
      case "backspace":
        if (s.cursor === 0) return;
        return setQuery(s.query.slice(0, s.cursor - 1) + s.query.slice(s.cursor), s.cursor - 1);
      case "delete":
        return setQuery(s.query.slice(0, s.cursor) + s.query.slice(s.cursor + 1), s.cursor);
      case "left":
        s.cursor = Math.max(0, s.cursor - 1);
        return this.render();
      case "right":
        s.cursor = Math.min(s.query.length, s.cursor + 1);
        return this.render();
      case "home":
        s.cursor = 0;
        return this.render();
      case "end":
        s.cursor = s.query.length;
        return this.render();
      default:
        return;
    }
  }

  private searchScopeNote(): string | undefined {
    const loaded = [...this.data.values()].filter((d) => d.list.length > 0).length;
    if (!this.search?.query.trim()) return undefined;
    return `Messages are searched in the ${loaded} conversation${loaded === 1 ? "" : "s"} opened this session, as far back as they are loaded.`;
  }

  /**
   * People (by name, from chat members and message senders), chats and channels (by name or
   * member), then messages (by text, sender or attachment name) in what is loaded here.
   */
  private searchResults(): Found[] {
    const q = this.search?.query.trim().toLowerCase() ?? "";
    if (!q) return [];
    if (this.searchCache?.query === q) return this.searchCache.results;
    const me = this.opts.account.id;
    const myName = this.opts.account.name.toLowerCase();
    const now = new Date(this.now());

    const people = new Map<string, { name: string; keys: Set<string> }>();
    const addPerson = (name: string, key: string) => {
      const k = name.trim().toLowerCase();
      if (!k || k === myName) return;
      const p = people.get(k) ?? { name: name.trim(), keys: new Set<string>() };
      p.keys.add(key);
      people.set(k, p);
    };
    for (const c of this.chats ?? []) for (const n of c.members ?? []) addPerson(n, `chat:${c.id}`);
    for (const [key, d] of this.data) {
      for (const m of d.list) if (!m.system && m.fromId !== me && m.from) addPerson(m.from, key);
    }
    const rank = (text: string) => (text.toLowerCase().startsWith(q) ? 0 : 1);
    const personHits: Found[] = [...people.values()]
      .filter((p) => p.name.toLowerCase().includes(q))
      .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
      .slice(0, MAX_PEOPLE_RESULTS)
      .map((p) => ({
        kind: "person" as const,
        title: p.name,
        detail: `${p.keys.size} conversation${p.keys.size === 1 ? "" : "s"}`,
        open: { kind: "person" as const, name: p.name },
      }));

    const membersOf = (key: string): string[] =>
      key.startsWith("chat:")
        ? ((this.chats ?? []).find((c) => `chat:${c.id}` === key)?.members ?? [])
        : [];
    const convHits: Found[] = [];
    for (const key of this.orderedKeys()) {
      const conv = this.convs.get(key);
      if (!conv) continue;
      const members = membersOf(key);
      const hay = [conv.title, conv.teamName ?? "", ...members].join(" ").toLowerCase();
      if (!hay.includes(q)) continue;
      const n = this.unread.get(key);
      const kindLabel = conv.teamName
        ? `channel in ${conv.teamName}`
        : members.length > 1
          ? members.join(", ")
          : "chat";
      convHits.push({
        kind: "conv",
        title: conv.teamName ? `${conv.teamName} › ${conv.title}` : conv.title,
        detail: n === undefined ? kindLabel : `${n > 0 ? n : "new"} unread · ${kindLabel}`,
        open: { kind: "conv", key },
      });
      if (convHits.length >= MAX_CONV_RESULTS) break;
    }

    const messageHits: Array<Found & { at: number }> = [];
    for (const [key, d] of this.data) {
      const conv = this.convs.get(key);
      if (!conv) continue;
      for (const m of d.list) {
        if (m.system) continue;
        const names = [...m.images.map((i) => i.alt), ...m.files.map((f) => f.name)].join(" ");
        const inText = m.text.toLowerCase().includes(q);
        if (!inText && !m.from.toLowerCase().includes(q) && !names.toLowerCase().includes(q))
          continue;
        const { time, day } = timeParts(m.at, now);
        const flat = (m.text || names || "(attachment)").replace(/\s+/g, " ");
        const at = inText ? flat.toLowerCase().indexOf(q) : 0;
        const from = Math.max(0, at - 24);
        const snippet = `${from > 0 ? "…" : ""}${flat.slice(from, from + 160)}`;
        messageHits.push({
          kind: "message",
          title: `${m.fromId === me ? "You" : m.from || "Someone"} in ${conv.title} · ${day} ${time}`,
          detail: snippet,
          open: { kind: "message", key, id: m.id },
          at: Date.parse(m.at) || 0,
        });
      }
    }
    messageHits.sort((a, b) => b.at - a.at);
    const results: Found[] = [
      ...personHits,
      ...convHits,
      ...messageHits.slice(0, MAX_MESSAGE_RESULTS).map(({ at: _at, ...r }) => r),
    ];
    this.searchCache = { query: q, results };
    return results;
  }

  /** The chat to open for a person: your 1:1 with them, else the newest chat they are in. */
  private chatWith(name: string): string | null {
    const lower = name.toLowerCase();
    const chats = this.chats ?? [];
    const has = (c: ChatInfo) => (c.members ?? []).some((m) => m.toLowerCase() === lower);
    const direct = chats.find((c) => c.kind === "oneOnOne" && has(c));
    if (direct) return `chat:${direct.id}`;
    const any = chats.find(has);
    if (any) return `chat:${any.id}`;
    for (const [key, d] of this.data) {
      if (d.list.some((m) => m.from.toLowerCase() === lower)) return key;
    }
    return null;
  }

  private openResult(index: number): void {
    const r = this.searchResults()[index];
    if (!r) return;
    const query = this.search?.query.trim() ?? "";
    this.search = null;
    this.searchCache = null;
    if (r.open.kind === "conv") return this.select(r.open.key);
    if (r.open.kind === "person") {
      const key = this.chatWith(r.open.name);
      if (key) return this.select(key);
      return this.setNotice(`No chat with ${r.open.name} here yet.`, "info");
    }
    if (r.open.key !== this.selKey) this.select(r.open.key);
    this.focusId = r.open.id;
    this.highlight = { id: r.open.id, query };
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(() => {
      this.highlight = null;
      this.render();
    }, HIGHLIGHT_MS);
    this.highlightTimer.unref?.();
    this.render();
  }

  private mouse(ev: Extract<InputEvent, { type: "mouse" }>): void {
    const f = this.frame;
    if (!f) return;
    if (ev.action === "wheelup" || ev.action === "wheeldown") {
      const up = ev.action === "wheelup";
      const inBox = (b?: { x1: number; y1: number; x2: number; y2: number }) =>
        !!b && ev.x >= b.x1 && ev.x <= b.x2 && ev.y >= b.y1 && ev.y <= b.y2;
      if (inBox(f.sidebarPane)) {
        const from = this.sidebarScroll ?? f.sidebarTop ?? 0;
        this.sidebarScroll = Math.max(0, Math.min(from + (up ? -3 : 3), f.maxSidebarScroll ?? 0));
        return this.render();
      }
      if (inBox(f.pane)) {
        if (this.search) {
          const count = this.searchResults().length;
          this.search.selected = Math.max(
            0,
            Math.min(count - 1, this.search.selected + (up ? -1 : 1))
          );
          return this.render();
        }
        this.scrollBy(up ? 3 : -3);
      }
      return;
    }
    if (ev.action !== "press") return;
    const action = hitAt(f, ev.x, ev.y);
    if (action) void this.perform(action);
  }

  private async perform(a: Action): Promise<void> {
    if (a.type === "select") return this.select(a.key);
    if (a.type === "attach") return this.attachFromClipboard();
    if (a.type === "send") return this.send();
    if (a.type === "unattach") {
      this.pending.splice(a.index, 1);
      return this.render();
    }
    if (a.type === "older") {
      const conv = this.selKey ? this.convs.get(this.selKey) : null;
      return conv ? this.loadOlder(conv) : undefined;
    }
    if (a.type === "search") return this.openSearch();
    if (a.type === "result") return this.openResult(a.index);
    if (a.type === "jump") return this.jumpToLatest();
    return this.openRef(a.messageId, a.kind, a.index);
  }

  // ---- editing (code-point aware) --------------------------------------------

  private prevBoundary(i: number): number {
    if (i <= 0) return 0;
    const low = this.input.charCodeAt(i - 1);
    const high = i >= 2 ? this.input.charCodeAt(i - 2) : 0;
    return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? i - 2 : i - 1;
  }

  private nextBoundary(i: number): number {
    if (i >= this.input.length) return this.input.length;
    const c = this.input.charCodeAt(i);
    return c >= 0xd800 && c <= 0xdbff && i + 1 < this.input.length ? i + 2 : i + 1;
  }

  private edit(text: string, cursor: number): void {
    this.input = text;
    this.cursor = Math.max(0, Math.min(cursor, text.length));
    this.render();
  }

  private moveTo(i: number): void {
    this.cursor = Math.max(0, Math.min(i, this.input.length));
    this.render();
  }

  private insert(text: string): void {
    // eslint-disable-next-line no-control-regex -- \u0001 is a placeholder that carries newlines through sanitize()
    const clean = sanitize(text.replace(/\n/g, "\u0001")).replace(/\u0001/g, "\n");
    if (!clean) return;
    this.edit(
      this.input.slice(0, this.cursor) + clean + this.input.slice(this.cursor),
      this.cursor + clean.length
    );
  }

  private backspace(): void {
    if (this.input === "" && this.pending.length > 0) {
      this.pending.pop();
      return this.render();
    }
    const from = this.prevBoundary(this.cursor);
    this.edit(this.input.slice(0, from) + this.input.slice(this.cursor), from);
  }

  private del(): void {
    const to = this.nextBoundary(this.cursor);
    this.edit(this.input.slice(0, this.cursor) + this.input.slice(to), this.cursor);
  }

  private deleteWord(): void {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.input[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.input[i - 1])) i--;
    this.edit(this.input.slice(0, i) + this.input.slice(this.cursor), i);
  }

  /** Pasted text: file paths become attachments (Kai Terminal pastes copied files as paths); anything else is typed in. */
  private paste(text: string): void {
    const tokens = splitPastedPaths(text.trim());
    if (tokens.length > 0 && tokens.length <= MAX_ATTACHMENTS) {
      const files = tokens.filter((t) => {
        try {
          return fs.statSync(t).isFile();
        } catch {
          return false;
        }
      });
      if (files.length === tokens.length) return void this.attachPaths(files);
    }
    this.insert(text);
  }

  // ---- attachments -----------------------------------------------------------

  private async attachFromClipboard(): Promise<void> {
    try {
      const paths = await this.readClipboard();
      if (paths.length === 0) {
        this.setNotice("Nothing to attach. Copy a file or an image first.", "info");
        return;
      }
      this.attachPaths(paths);
    } catch (e) {
      this.setNotice(`Could not read the clipboard: ${errorText(e)}`, "error");
    }
  }

  private attachPaths(paths: string[]): void {
    let added = 0;
    for (const p of paths) {
      if (this.pending.length >= MAX_ATTACHMENTS) {
        this.setNotice(`You can attach up to ${MAX_ATTACHMENTS} things per message.`, "error");
        break;
      }
      const name = sanitize(path.basename(p));
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) {
          this.setNotice(`${name} is a folder, not a file.`, "error");
          continue;
        }
        if (st.size > MAX_FILE_BYTES) {
          this.setNotice(
            `${name} is larger than ${MAX_FILE_TEXT}, which is the most Kai can send.`,
            "error"
          );
          continue;
        }
        // Only a small file is read now (it may be a picture that goes inside the message). A
        // larger one is read from disk a piece at a time while it uploads, so what is attached
        // never takes memory in proportion to its size.
        if (st.size <= MAX_UPLOAD_BYTES) {
          const bytes = fs.readFileSync(p);
          const info = sniffImage(bytes);
          this.pending.push({
            name,
            path: p,
            size: bytes.byteLength,
            bytes,
            mime: info?.mime ?? "application/octet-stream",
            image: info !== null,
          });
        } else {
          // A picture over 4 MB cannot ride inside the message; it is uploaded and sent as a link like any file.
          this.pending.push({
            name,
            path: p,
            size: st.size,
            bytes: null,
            mime: "application/octet-stream",
            image: false,
          });
        }
        added++;
      } catch {
        this.setNotice(`Could not read ${name}.`, "error");
      }
    }
    if (added > 0)
      this.setNotice(
        `Attached ${added === 1 ? "1 item" : `${added} items`}. Add a message, or press Enter to send.`,
        "ok"
      );
    this.render();
  }

  // ---- sending ---------------------------------------------------------------

  /**
   * Send what is in the box. The message appears at once, marked "sending",
   * and the box is free for the next one; if Teams refuses it, the message
   * disappears and the text and attachments come back so nothing is lost.
   */
  private async send(): Promise<void> {
    const conv = this.selKey ? this.convs.get(this.selKey) : null;
    if (!conv) return this.setNotice("Pick a channel or a chat first.", "info");
    const text = this.input.trim();
    if (!text && this.pending.length === 0) return;
    if (this.sending) return;
    this.sending = true;
    const attachments = this.pending.slice();
    const d = this.ensureData(conv.key);
    const local: LocalMessage = {
      id: `local-${++this.localSeq}`,
      at: new Date(this.now()).toISOString(),
      from: this.opts.account.name,
      fromId: this.opts.account.id,
      text,
      images: [],
      files: attachments.map((a) => ({ name: a.name })),
      system: false,
      sent: false,
      misses: 0,
    };
    d.local.push(local);
    this.input = "";
    this.cursor = 0;
    this.pending = [];
    this.scroll = 0;
    this.render();
    try {
      const images = attachments.filter((a) => a.image);
      const files = attachments.filter((a) => !a.image);
      const links: Array<{ name: string; url: string }> = [];
      for (const f of files) {
        this.setNotice(`Uploading ${f.name}...`, "info", 0);
        let shown = -1;
        const content = f.bytes ?? fileUploadSource(f.path, f.size);
        const url = await this.opts.graph.uploadFile(f.name, content, (sent, total) => {
          const pct = total > 0 ? Math.floor((sent / total) * 100) : 100;
          if (total <= MAX_UPLOAD_BYTES || pct === shown || pct >= 100) return;
          shown = pct;
          this.setNotice(`Uploading ${f.name}... ${pct}%`, "info", 0);
        });
        links.push({ name: f.name, url });
      }
      this.setNotice("Sending...", "info", 0);
      await this.opts.graph.send(conv.target, {
        text,
        images: images.flatMap((a) =>
          a.bytes ? [{ name: a.name, bytes: a.bytes, contentType: a.mime }] : []
        ),
        links,
      });
      local.sent = true;
      this.setNotice("Sent.", "ok", 2500);
      try {
        await this.refreshConversation(conv);
      } catch {
        // The next sync shows it; the message stays visible until then.
      }
    } catch (e) {
      d.local = d.local.filter((m) => m !== local);
      this.giveBack(conv.key, text, attachments);
      if (isAuthError(e)) this.markExpired();
      else this.setNotice(errorText(e), "error", 10_000);
    } finally {
      this.sending = false;
      this.render();
    }
  }

  /** Put an unsent message back where it was typed (the box, or that conversation's draft). */
  private giveBack(key: string, text: string, attachments: Attachment[]): void {
    if (key === this.selKey) {
      if (this.input === "" && this.pending.length === 0) {
        this.input = text;
        this.cursor = text.length;
        this.pending = attachments;
      } else {
        // Something new was typed meanwhile: keep it, and put the old text before it.
        this.input = text + (this.input ? `\n${this.input}` : "");
        this.cursor = this.input.length;
        this.pending = [...attachments, ...this.pending].slice(0, MAX_ATTACHMENTS);
      }
    } else {
      this.drafts.set(key, { input: text, cursor: text.length, pending: attachments });
    }
  }

  // ---- opening ---------------------------------------------------------------

  private async openRef(messageId: string, kind: "image" | "file", index: number): Promise<void> {
    const conv = this.selKey ? this.convs.get(this.selKey) : null;
    const msg = conv ? this.data.get(conv.key)?.list.find((m) => m.id === messageId) : undefined;
    if (!msg) return;
    try {
      if (kind === "file") {
        const url = msg.files[index]?.url;
        if (url && /^https:\/\//i.test(url)) {
          this.openUrl(url);
          return this.setNotice("Opened in your browser.", "ok", 3000);
        }
        return this.setNotice("This file has no address to open.", "error");
      }
      const img = msg.images[index];
      if (!img) return;
      if (!img.fetchable) {
        if (/^https:\/\//i.test(img.url)) {
          this.openUrl(img.url);
          return this.setNotice("Opened in your browser.", "ok", 3000);
        }
        return this.setNotice("This image cannot be opened from here.", "error");
      }
      this.setNotice("Opening image...", "info", 0);
      const cached = this.images.get(img.url);
      const bytes =
        cached?.state === "ready" && cached.b64
          ? new Uint8Array(Buffer.from(cached.b64, "base64"))
          : (await this.opts.graph.image(img.url)).bytes;
      const info = sniffImage(bytes);
      if (!info) return this.setNotice("This image is not in a format Kai can open.", "error");
      const dir = this.opts.tmpDir ?? privateTempDir("kai-teams");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(
        dir,
        `${crypto.createHash("sha1").update(img.url).digest("hex").slice(0, 12)}.${extensionFor(info.kind)}`
      );
      fs.writeFileSync(file, bytes);
      this.openFile(file);
      this.setNotice("Opened in your image viewer.", "ok", 3000);
    } catch (e) {
      if (isAuthError(e)) this.markExpired();
      else this.setNotice(errorText(e), "error");
    }
  }
}

/** Run the chat to completion. */
export async function runChat(opts: ChatOptions): Promise<number> {
  const app = new ChatApp(opts);
  await app.run();
  return 0;
}
