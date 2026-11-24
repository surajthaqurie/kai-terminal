import {
  FC,
  KeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MessagesSquare, Plus, Send, Square } from "lucide-react";
import type { JoinedHost, SharedAgentEvent, SharedAgentId } from "../core/sharedAgent/types";
import { onSharedAgentEvent, sendChat, stopChat } from "../services/sharedAgentService";
import type { ChatMsg, ChatSnapshot } from "../services/sharedChatWindow";
import { agentChoices, describeRoute, hostStatusPill } from "./sharedAgentViewModel";

const SUGGESTIONS = ["Explain a regex", "Review this function", "Draft a commit message"];

const newChatId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const shown = (m: ChatMsg): string =>
  m.draft ? (m.text ? `${m.text}\n\n${m.draft}` : m.draft) : m.text;

interface ChatProps {
  hosts: JoinedHost[];
  /** The PC being chatted with. */
  hostId: string | null;
  /** Offered as a picker in the header (the popped-out window); otherwise the panel's list picks. */
  onHostChange?: (id: string) => void;
  /** A conversation to carry on (from the other window). */
  initial?: ChatSnapshot | null;
  /** Called whenever the conversation changes, so it can be handed to another window. */
  onSnapshot?: (snapshot: ChatSnapshot) => void;
  onBusyChange?: (busy: boolean) => void;
  /** Extra header buttons (pop out / dock back). */
  actions?: (state: { busy: boolean; snapshot: ChatSnapshot }) => ReactNode;
}

/** Chat with a joined PC's agent. Shared by the panel and the popped-out window. */
export const SharedAgentChat: FC<ChatProps> = ({
  hosts,
  hostId,
  onHostChange,
  initial,
  onSnapshot,
  onBusyChange,
  actions,
}) => {
  const [messages, setMessages] = useState<ChatMsg[]>(initial?.messages ?? []);
  const [agent, setAgent] = useState<SharedAgentId>(initial?.agent ?? "claude");
  const [input, setInput] = useState("");
  const [busyChat, setBusyChat] = useState<string | null>(null);

  const sessions = useRef<Record<string, string>>({ ...(initial?.sessions ?? {}) });
  const chat = useRef<{
    id: string;
    hostId: string;
    agent: SharedAgentId;
    replyId: number | null;
    /** "Office-PC · Claude Code", kept for the next bubble when the labelled one stayed empty. */
    who?: string;
  } | null>(null);
  const seq = useRef(Math.max(0, ...(initial?.messages ?? []).map((m) => m.id)) + 1);
  const logRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const lastHost = useRef(hostId);

  const host = useMemo(() => hosts.find((h) => h.id === hostId) ?? null, [hosts, hostId]);
  const route = useMemo(() => describeRoute(host), [host]);
  const choices = useMemo(() => agentChoices(host), [host]);
  const canSend = Boolean(host?.connected) && choices.length > 0;

  const snapshot = useMemo<ChatSnapshot>(
    () => ({ hostId, agent, messages, sessions: { ...sessions.current } }),
    // `sessions` is a ref; a new session always arrives with a message change.
    [hostId, agent, messages]
  );

  useEffect(() => {
    onSnapshot?.(snapshot);
  }, [snapshot, onSnapshot]);

  useEffect(() => {
    onBusyChange?.(busyChat !== null);
  }, [busyChat, onBusyChange]);

  // A different PC starts a different conversation.
  useEffect(() => {
    if (lastHost.current === hostId) return;
    lastHost.current = hostId;
    setMessages([]);
  }, [hostId]);

  // The chosen agent must be one that can answer.
  useEffect(() => {
    if (choices.length && !choices.some((a) => a.id === agent)) setAgent(choices[0].id);
  }, [choices, agent]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages]);

  // Closing the window ends a chat still in progress instead of leaving it running unseen.
  useEffect(
    () => () => {
      if (chat.current) void stopChat(chat.current.id);
    },
    []
  );

  const push = useCallback((msg: Omit<ChatMsg, "id">): number => {
    const id = seq.current++;
    setMessages((m) => [...m, { ...msg, id }]);
    return id;
  }, []);

  const patch = (id: number, fn: (m: ChatMsg) => ChatMsg) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  /** Drops the open answer bubble when nothing was written into it. */
  const closeReply = (cur: NonNullable<typeof chat.current>) => {
    const id = cur.replyId;
    cur.replyId = null;
    if (id === null) return;
    const open = messagesRef.current.find((m) => m.id === id);
    if (open && !shown(open) && open.who) cur.who = open.who;
    setMessages((ms) => ms.filter((m) => m.id !== id || shown(m)));
  };

  const reply = (cur: NonNullable<typeof chat.current>): number => {
    if (cur.replyId !== null) return cur.replyId;
    cur.replyId = push({ kind: "agent", text: "", who: cur.who });
    cur.who = undefined;
    return cur.replyId;
  };

  // ---- events from the service ---------------------------------------------
  const onChatEvent = (e: Extract<SharedAgentEvent, { event: "chat" }>) => {
    const cur = chat.current;
    if (!cur || e.chatId !== cur.id) return;
    const text = (k: string) => (typeof e[k] === "string" ? e[k] : "");
    switch (e.kind) {
      case "session":
        if (text("sessionId")) sessions.current[`${cur.hostId}:${cur.agent}`] = text("sessionId");
        break;
      case "delta": {
        const t = text("text");
        patch(reply(cur), (m) => ({ ...m, draft: (m.draft ?? "") + t }));
        break;
      }
      case "text": {
        // The whole block: it replaces whatever was streamed of it.
        const t = text("text");
        patch(reply(cur), (m) => ({
          ...m,
          draft: undefined,
          text: m.text ? `${m.text}\n\n${t}` : t,
        }));
        break;
      }
      case "tool":
        closeReply(cur);
        push({ kind: "tool", text: `${text("name")} ${text("detail")}`.trim() });
        break;
      case "denied":
        push({
          kind: "note",
          text: text("text") || "A tool was blocked: shared agents are read-only.",
        });
        break;
      case "log":
        if (text("text")) push({ kind: "note", text: text("text") });
        break;
      case "end": {
        closeReply(cur);
        const status = text("status");
        if (status && status !== "completed") {
          push({
            kind: "error",
            text:
              status === "stopped" ? "Stopped." : text("error") || `The agent stopped (${status}).`,
          });
        }
        chat.current = null;
        setBusyChat(null);
        break;
      }
      default:
        break;
    }
  };

  const onServiceEvent = (e: SharedAgentEvent) => {
    if (e.event === "chat") onChatEvent(e);
    else if (e.event === "service_exit" && chat.current) {
      chat.current = null;
      setBusyChat(null);
      push({ kind: "error", text: "The Shared Agent service stopped. Send your message again." });
    }
  };

  // Subscribe once; the handler is read through a ref so no event is lost to a re-subscribe.
  const eventHandler = useRef(onServiceEvent);
  eventHandler.current = onServiceEvent;
  useEffect(() => {
    let off = () => {};
    let cancelled = false;
    void onSharedAgentEvent((e) => eventHandler.current(e)).then((unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // ---- actions --------------------------------------------------------------
  const send = async () => {
    const message = input.trim();
    if (!message || busyChat || !canSend || !host) return;
    const id = newChatId();
    const agentName = choices.find((a) => a.id === agent)?.name ?? agent;
    push({ kind: "you", text: message });
    setInput("");
    setBusyChat(id);
    // The answer bubble shows at once, so there is something to look at while the PC starts.
    const replyId = push({ kind: "agent", text: "", who: `${host.name} · ${agentName}` });
    chat.current = { id, hostId: host.id, agent, replyId };
    const res = await sendChat({
      chatId: id,
      hostId: host.id,
      agent,
      message,
      session: sessions.current[`${host.id}:${agent}`] ?? null,
    });
    if (!res.ok) {
      if (chat.current?.id === id) {
        closeReply(chat.current);
        chat.current = null;
      }
      setBusyChat(null);
      push({ kind: "error", text: res.error.message });
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const newChat = () => {
    if (busyChat) return;
    setMessages([]);
    for (const k of Object.keys(sessions.current))
      if (k.startsWith(`${hostId}:`)) delete sessions.current[k];
  };

  const busy = busyChat !== null;
  const lastIsOpenReply = (() => {
    const last = messages[messages.length - 1];
    return last?.kind === "agent" && last.id === chat.current?.replyId;
  })();

  return (
    <section className="sa-chat" aria-labelledby="sa-chat-title">
      <header className="sa-chat-head">
        <div className="sa-chat-who">
          <div className="sa-chat-title">
            <h4 id="sa-chat-title">{host ? `Chat with ${host.name}` : "Chat"}</h4>
            <span className="sa-badge sa-badge-own">read-only · empty folder</span>
          </div>
          <div
            className={`sa-route sa-tone-${route.tone}`}
            aria-live="polite"
            aria-label="Connection"
          >
            <span className="sa-dot" aria-hidden="true" />
            <span className="sa-route-title">{route.title}</span>
            <span className="sa-badge sa-badge-tone">{route.badge}</span>
            {route.detail && <span className="sa-muted sa-route-detail">{route.detail}</span>}
          </div>
        </div>
        <div className="sa-chat-tools">
          {onHostChange && hosts.length > 1 && (
            <select
              className="select-input"
              aria-label="PC"
              value={hostId ?? ""}
              disabled={busy}
              onChange={(e) => onHostChange(e.target.value)}
            >
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} · {hostStatusPill(h).label}
                </option>
              ))}
            </select>
          )}
          {choices.length > 1 && (
            <select
              className="select-input"
              aria-label="Agent"
              value={agent}
              disabled={busy}
              onChange={(e) => setAgent(e.target.value as SharedAgentId)}
            >
              {choices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={newChat}
            disabled={busy || messages.length === 0}
            title="Start a new conversation"
          >
            <Plus size={13} />
            <span>New chat</span>
          </button>
          {actions?.({ busy, snapshot })}
        </div>
      </header>

      <div className="sa-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
        {messages.length === 0 && (
          <div className="sa-log-hint">
            <MessagesSquare size={26} aria-hidden="true" />
            <p>
              {canSend
                ? "Ask anything. The agent can't see your files, and the chat clears when you close this window."
                : host?.connected
                  ? `${host.name} has no agent to answer right now.`
                  : "Join a PC to chat with its agent."}
            </p>
            {canSend && (
              <div className="sa-suggest">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" onClick={() => setInput(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`sa-msg sa-msg-${m.kind}`}>
            {m.who && <small>{m.who}</small>}
            <div className="sa-bubble">
              {m.kind === "agent" && !shown(m) ? (
                <span className="sa-typing" aria-label="Answering">
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <>
                  {shown(m)}
                  {m.draft && <span className="sa-caret" aria-hidden="true" />}
                </>
              )}
            </div>
          </div>
        ))}
        {busy && !lastIsOpenReply && (
          <div className="sa-msg sa-msg-agent">
            <div className="sa-bubble">
              <span className="sa-typing" aria-label="Working">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="sa-composer">
        <textarea
          className="text-input"
          aria-label="Message"
          rows={2}
          value={input}
          maxLength={20000}
          disabled={!canSend}
          placeholder={canSend && host ? `Ask ${host.name}'s agent…` : "Join a PC to chat"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="sa-composer-foot">
          <span className="sa-muted">Enter to send · Shift+Enter for a new line</span>
          {busyChat ? (
            <button
              type="button"
              className="btn btn-secondary btn-small sa-danger"
              onClick={() => void stopChat(busyChat)}
            >
              <Square size={12} />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-small"
              onClick={() => void send()}
              disabled={!input.trim() || !canSend}
            >
              <Send size={12} />
              <span>Send</span>
            </button>
          )}
        </div>
      </div>
    </section>
  );
};
