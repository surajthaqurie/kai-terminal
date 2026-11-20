/**
 * The Shared Agent chat popped out into its own desktop window. The conversation
 * travels between the panel and the window through localStorage (both windows load
 * the same origin), so it carries on wherever the person moves it.
 */
import { isTauriAvailable } from "./ptyService";
import type { SharedAgentId } from "../core/sharedAgent/types";

/** One line of the conversation as the chat shows it. */
export interface ChatMsg {
  id: number;
  kind: "you" | "agent" | "tool" | "note" | "error";
  text: string;
  who?: string;
  /** Text still being written (streamed); joins `text` when its block is complete. */
  draft?: string;
}

/** Everything needed to carry a conversation on in another window. */
export interface ChatSnapshot {
  hostId: string | null;
  agent: SharedAgentId;
  messages: ChatMsg[];
  /** "<hostId>:<agent>" -> the host's session, so the agent remembers the conversation. */
  sessions: Record<string, string>;
}

const HANDOFF_KEY = "kai_shared_chat_handoff";
const CLOSED_EVENT = "kai-shared-chat:closed";
/** Keeps the handoff small: the latest messages are the ones that matter. */
const MAX_HANDOFF_MESSAGES = 300;

export function saveChatHandoff(snapshot: ChatSnapshot): void {
  try {
    const messages = snapshot.messages
      .slice(-MAX_HANDOFF_MESSAGES)
      .map(({ draft, ...m }) =>
        draft ? { ...m, text: m.text ? `${m.text}\n\n${draft}` : draft } : m
      );
    localStorage.setItem(HANDOFF_KEY, JSON.stringify({ ...snapshot, messages }));
  } catch {
    // Storage full or blocked: the other window starts a fresh conversation.
  }
}

export function loadChatHandoff(): ChatSnapshot | null {
  try {
    const raw = localStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ChatSnapshot>;
    if (!v || !Array.isArray(v.messages) || typeof v.agent !== "string") return null;
    return {
      hostId: typeof v.hostId === "string" ? v.hostId : null,
      agent: v.agent,
      messages: v.messages.filter(
        (m) => m && typeof m.text === "string" && typeof m.id === "number"
      ),
      sessions: v.sessions && typeof v.sessions === "object" ? v.sessions : {},
    };
  } catch {
    return null;
  }
}

/** True when this page was opened as the popped-out chat window. */
export function isSharedChatWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("window") === "shared-chat";
  } catch {
    return false;
  }
}

async function call(cmd: string): Promise<boolean> {
  if (!isTauriAvailable()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(cmd);
    return true;
  } catch (err) {
    console.warn(`Shared Agent chat window: ${cmd} failed:`, err);
    return false;
  }
}

// ---- whether the chat is popped out (shared by every panel in the main window) ----

let poppedOut = false;
let listening = false;
const listeners = new Set<(open: boolean) => void>();

function setPoppedOut(open: boolean): void {
  if (poppedOut === open) return;
  poppedOut = open;
  for (const l of [...listeners]) l(open);
}

function listenForClose(): void {
  if (listening || !isTauriAvailable()) return;
  listening = true;
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen(CLOSED_EVENT, () => setPoppedOut(false)))
    .catch(() => {
      listening = false;
    });
}

export const isChatPoppedOut = (): boolean => poppedOut;

/** Calls `fn` whenever the chat moves into or out of its own window. */
export function onChatPoppedOut(fn: (open: boolean) => void): () => void {
  listenForClose();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Moves the conversation into its own window. False when the window could not open. */
export async function popOutChat(snapshot: ChatSnapshot): Promise<boolean> {
  listenForClose();
  saveChatHandoff(snapshot);
  const ok = await call("open_shared_chat_window");
  if (ok) setPoppedOut(true);
  return ok;
}

/** Closes the chat window; the conversation comes back to the panel. */
export const closeChatWindow = (): Promise<boolean> => call("close_shared_chat_window");
