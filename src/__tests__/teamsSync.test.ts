import { describe, expect, it } from "vitest";
import type { ChatInfo, TeamsMessage } from "../core/teams/graph";
import {
  DEFAULT_TIMING,
  chatHasUnread,
  mergeLatest,
  mergeOlder,
  newestAt,
  nextDelayMs,
  syncLabel,
  unseenFromOthers,
} from "../cli/teams/sync";

const T0 = Date.parse("2026-11-04T09:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const msg = (id: string, minutes: number, text = id, fromId = "u-other"): TeamsMessage => ({
  id,
  at: at(minutes),
  from: "Someone",
  fromId,
  text,
  images: [],
  files: [],
  system: false,
});

const chat = (over: Partial<ChatInfo> = {}): ChatInfo => ({
  id: "c",
  title: "Priya",
  kind: "oneOnOne",
  lastAt: at(10),
  lastFromId: "u-other",
  lastReadAt: "",
  ...over,
});

describe("nextDelayMs", () => {
  it("refreshes fast while focused and slowly while away", () => {
    expect(nextDelayMs({ focused: true, failures: 0 })).toBe(DEFAULT_TIMING.focusedMs);
    expect(nextDelayMs({ focused: false, failures: 0 })).toBe(DEFAULT_TIMING.idleMs);
  });

  it("doubles the wait for every failure, up to a cap", () => {
    const d = (failures: number) => nextDelayMs({ focused: true, failures });
    expect(d(1)).toBe(DEFAULT_TIMING.focusedMs * 2);
    expect(d(2)).toBe(DEFAULT_TIMING.focusedMs * 4);
    expect(d(3)).toBeGreaterThan(d(2));
    expect(d(50)).toBe(DEFAULT_TIMING.maxBackoffMs);
  });

  it("waits at least a while longer when Microsoft says to slow down", () => {
    expect(nextDelayMs({ focused: true, failures: 1, rateLimited: true })).toBe(
      DEFAULT_TIMING.rateLimitMs
    );
    expect(nextDelayMs({ focused: false, failures: 1, rateLimited: true })).toBe(
      DEFAULT_TIMING.idleMs * 2
    );
  });
});

describe("mergeLatest", () => {
  it("adds new messages and keeps the older ones the user scrolled back to", () => {
    const old = [msg("a", 1), msg("b", 2), msg("c", 3)];
    const merged = mergeLatest(old, [msg("c", 3), msg("d", 4)]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("shows an edit, and drops a message that was deleted inside the newest page", () => {
    const old = [msg("a", 1), msg("b", 2, "before"), msg("c", 3)];
    const merged = mergeLatest(old, [msg("b", 2, "after")]);
    expect(merged.map((m) => `${m.id}:${m.text}`)).toEqual(["a:a", "b:after"]);
  });

  it("keeps everything when the page came back empty", () => {
    const old = [msg("a", 1)];
    expect(mergeLatest(old, [])).toEqual(old);
  });
});

describe("mergeOlder", () => {
  it("puts an older page in front without duplicating anything", () => {
    const merged = mergeOlder([msg("c", 3), msg("d", 4)], [msg("a", 1), msg("b", 2), msg("c", 3)]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("unread", () => {
  it("finds the newest time in a list", () => {
    expect(newestAt([msg("a", 1), msg("b", 5)])).toBe(T0 + 5 * 60_000);
    expect(newestAt([])).toBe(0);
  });

  it("marks a chat unread only when someone else wrote last and you have not seen it", () => {
    expect(chatHasUnread(chat(), "me", 0)).toBe(true);
    expect(chatHasUnread(chat({ lastFromId: "me" }), "me", 0)).toBe(false);
    expect(chatHasUnread(chat({ lastAt: "" }), "me", 0)).toBe(false);
  });

  it("counts what you read here or in any other Teams client as seen", () => {
    expect(chatHasUnread(chat({ lastReadAt: at(10) }), "me", 0)).toBe(false);
    expect(chatHasUnread(chat({ lastReadAt: at(5) }), "me", 0)).toBe(true);
    expect(chatHasUnread(chat(), "me", T0 + 10 * 60_000)).toBe(false);
    expect(chatHasUnread(chat(), "me", T0 + 9 * 60_000)).toBe(true);
  });

  it("picks out messages from others that are newer than what was seen", () => {
    const list = [
      msg("a", 1),
      msg("b", 2, "mine", "me"),
      msg("c", 3),
      { ...msg("d", 4), system: true },
    ];
    expect(unseenFromOthers(list, "me", T0 + 1 * 60_000).map((m) => m.id)).toEqual(["c"]);
    expect(unseenFromOthers(list, "me", T0 + 3 * 60_000)).toEqual([]);
  });
});

describe("syncLabel", () => {
  it("says what the sync is doing", () => {
    const at9 = new Date(2026, 10, 4, 9, 41, 7).getTime();
    expect(syncLabel({ state: "starting" })).toBe("connecting...");
    expect(syncLabel({ state: "syncing" })).toBe("syncing...");
    expect(syncLabel({ state: "syncing", at: at9 })).toBe("syncing... (last 09:41)");
    expect(syncLabel({ state: "ok", at: at9 })).toBe("synced 09:41");
    expect(syncLabel({ state: "offline", retryAt: at9 })).toBe("offline, retry 09:41:07");
    expect(syncLabel({ state: "offline" })).toBe("offline");
    expect(syncLabel({ state: "expired" })).toBe("sign-in expired");
  });
});
