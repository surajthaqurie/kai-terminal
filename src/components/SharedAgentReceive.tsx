import {
  FC,
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Send, Square, Plus } from "lucide-react";
import { parseInviteLink } from "../core/sharedAgent/invite";
import {
  type AgentView,
  type JoinedHost,
  type SharedAgentEvent,
  type SharedAgentId,
} from "../core/sharedAgent/types";
import {
  joinHost,
  leaveHost,
  listHosts,
  onSharedAgentEvent,
  sendChat,
  stopChat,
} from "../services/sharedAgentService";
import {
  agentChoices,
  describeRoute,
  hostStatusPill,
  tokenBreakdown,
  tokensUsed,
} from "./sharedAgentViewModel";

type Msg = {
  id: number;
  kind: "you" | "agent" | "tool" | "note" | "error";
  text: string;
  who?: string;
};

const newChatId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;

interface ReceiveProps {
  /** True while this part of the panel is on screen: it loads and refreshes only then. */
  active: boolean;
}

/** "Use a shared agent": join PCs, see which Claude answers, chat. */
export const SharedAgentReceive: FC<ReceiveProps> = ({ active }) => {
  const [hosts, setHosts] = useState<JoinedHost[]>([]);
  const [ownAgents, setOwnAgents] = useState<AgentView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [agent, setAgent] = useState<SharedAgentId>("claude");
  const [link, setLink] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busyChat, setBusyChat] = useState<string | null>(null);

  const sessions = useRef<Record<string, string>>({}); // "<hostId>:<agent>" -> host session
  const chat = useRef<{
    id: string;
    hostId: string | null;
    agent: SharedAgentId;
    replyId: number | null;
  } | null>(null);
  const seq = useRef(1);
  const logRef = useRef<HTMLDivElement>(null);

  const activeHost = useMemo(() => hosts.find((h) => h.id === activeId) ?? null, [hosts, activeId]);
  const ownAvailable = ownAgents.some((a) => a.available);
  const route = useMemo(
    () => describeRoute({ host: activeHost, ownAvailable }),
    [activeHost, ownAvailable]
  );
  const choices = useMemo(
    () => agentChoices({ host: activeHost, ownAgents }),
    [activeHost, ownAgents]
  );

  const push = useCallback((msg: Omit<Msg, "id">): number => {
    const id = seq.current++;
    setMessages((m) => [...m, { ...msg, id }]);
    return id;
  }, []);

  // ---- loading ------------------------------------------------------------
  const refresh = useCallback(async (force = false) => {
    const res = await listHosts(force);
    if (!res.ok) {
      setLoadError(res.error.message);
      setLoaded(true);
      return;
    }
    setLoadError(null);
    setHosts(res.value.hosts);
    setOwnAgents(res.value.ownAgents);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (active) void refresh(true);
  }, [active, refresh]);

  // Pick a PC to talk to once there is one, and drop one that was left.
  useEffect(() => {
    if (activeId && hosts.some((h) => h.id === activeId)) return;
    setActiveId(hosts.find((h) => h.connected)?.id ?? hosts[0]?.id ?? null);
  }, [hosts, activeId]);

  // Closing the window ends a chat still in progress instead of leaving it running unseen.
  useEffect(
    () => () => {
      if (chat.current) void stopChat(chat.current.id);
    },
    []
  );

  // The chosen agent must be one that can answer.
  useEffect(() => {
    if (choices.length && !choices.some((a) => a.id === agent)) setAgent(choices[0].id);
  }, [choices, agent]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages]);

  // ---- events from the service ---------------------------------------------
  const onChatEvent = (e: Extract<SharedAgentEvent, { event: "chat" }>) => {
    const cur = chat.current;
    if (!cur || e.chatId !== cur.id) return;
    const text = (k: string) => (typeof e[k] === "string" ? (e[k] as string) : "");
    switch (e.kind) {
      case "route": {
        const own = e.route === "own";
        const name = hosts.find((h) => h.id === cur.hostId)?.name ?? text("hostName");
        cur.replyId = push({
          kind: "agent",
          text: "",
          who: own ? "My own Claude" : `${name} · ${cur.agent}`,
        });
        break;
      }
      case "session":
        if (cur.hostId && text("sessionId"))
          sessions.current[`${cur.hostId}:${cur.agent}`] = text("sessionId");
        break;
      case "text": {
        const id = cur.replyId ?? (cur.replyId = push({ kind: "agent", text: "" }));
        const t = text("text");
        setMessages((m) =>
          m.map((x) => (x.id === id ? { ...x, text: x.text ? `${x.text}\n\n${t}` : t } : x))
        );
        break;
      }
      case "tool":
        push({ kind: "tool", text: `${text("name")} ${text("detail")}`.trim() });
        break;
      case "denied":
        push({
          kind: "note",
          text: text("text") || "A tool was blocked: shared agents are read-only.",
        });
        break;
      case "log":
        push({ kind: "note", text: text("text") });
        break;
      case "end": {
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
    if (e.event === "hosts") setHosts(e.hosts);
    else if (e.event === "chat") onChatEvent(e);
    else if (e.event === "service_exit" && chat.current) {
      chat.current = null;
      setBusyChat(null);
      push({ kind: "error", text: "The Shared Agent service stopped. Send your message again." });
    }
  };

  // Subscribe once. The handler is read through a ref, so it always sees the current state
  // without ever re-subscribing: listening is asynchronous, and an event that arrived in the
  // gap of a re-subscribe (a chat's text, say) would be lost.
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
  const onJoin = async (ev: FormEvent) => {
    ev.preventDefault();
    setNotice(null);
    if (!parseInviteLink(link)) {
      setJoinError(
        "That is not a valid invite link. It looks like http://192.168.1.20:8765/join#… (same network) or https://<tunnel address>/join#… (internet)."
      );
      return;
    }
    setJoining(true);
    setJoinError(null);
    const res = await joinHost(link.trim());
    setJoining(false);
    if (!res.ok) {
      setJoinError(res.error.message);
      return;
    }
    setLink("");
    setNotice(`Joined ${res.value.name}.`);
    setHosts((hs) => [...hs.filter((h) => h.id !== res.value.id), res.value]);
    selectHost(res.value.id);
    void refresh();
  };

  const selectHost = (id: string) => {
    if (id === activeId || busyChat) return;
    setActiveId(id);
    setMessages([]);
  };

  const onLeave = async (id: string) => {
    if (leaving !== id) {
      setLeaving(id);
      return;
    }
    setLeaving(null);
    const res = await leaveHost(id);
    if (!res.ok) {
      setNotice(res.error.message);
      return;
    }
    if (id === activeId) setMessages([]);
    await refresh();
  };

  const canSend = choices.length > 0;

  const send = async () => {
    const message = input.trim();
    if (!message || busyChat || !canSend) return;
    const id = newChatId();
    const host = activeHost?.connected ? activeHost : null;
    push({ kind: "you", text: message });
    setInput("");
    setBusyChat(id);
    chat.current = { id, hostId: host?.id ?? null, agent, replyId: null };
    const res = await sendChat({
      chatId: id,
      hostId: host?.id ?? null,
      agent,
      message,
      session: host ? (sessions.current[`${host.id}:${agent}`] ?? null) : null,
    });
    if (!res.ok) {
      chat.current = null;
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
      if (k.startsWith(`${activeId}:`)) delete sessions.current[k];
  };

  if (loaded && loadError && !hosts.length) {
    return (
      <div className="sa-stack">
        <p className="sa-empty" role="alert">
          {loadError}
        </p>
      </div>
    );
  }

  return (
    <div className="sa-stack">
      {/* Which Claude answers right now */}
      <section
        className={`sa-route sa-tone-${route.tone}`}
        aria-live="polite"
        aria-label="Which Claude is answering"
      >
        <div className="sa-route-head">
          <span className="sa-dot" aria-hidden="true" />
          <h4>{route.title}</h4>
          <span className="sa-badge sa-badge-tone">{route.badge}</span>
          {route.detail && <span className="sa-muted sa-route-detail">{route.detail}</span>}
        </div>
      </section>

      {/* Join a PC, and every PC already joined with the tokens used through it */}
      <section className="sa-card" aria-labelledby="sa-join-title">
        <header className="sa-card-head">
          <h4 id="sa-join-title">Join a PC</h4>
          <span className="sa-muted">
            Links work once and expire. The secret stays in the #fragment and is never logged.
          </span>
        </header>
        <form className="sa-join-row" onSubmit={(e) => void onJoin(e)}>
          <input
            type="text"
            className="text-input"
            aria-label="Invite link"
            placeholder="Paste invite link, e.g. http://192.168.1.20:8765/join#…"
            value={link}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setLink(e.target.value);
              setJoinError(null);
            }}
          />
          <button type="submit" className="btn btn-primary" disabled={!link.trim() || joining}>
            {joining ? "Joining…" : "Join"}
          </button>
        </form>
        {joinError && (
          <p className="error-text sa-line" role="alert">
            {joinError}
          </p>
        )}
        {notice && !joinError && <p className="sa-muted sa-line">{notice}</p>}

        {hosts.length ? (
          <ul className="sa-hosts" aria-label="Joined PCs">
            {hosts.map((h) => {
              const pill = hostStatusPill(h);
              const agents = h.agents.filter((a) => a.available);
              return (
                <li key={h.id} className={`sa-host ${h.id === activeId ? "is-active" : ""}`}>
                  <button
                    type="button"
                    className="sa-host-select"
                    onClick={() => selectHost(h.id)}
                    aria-pressed={h.id === activeId}
                    aria-label={`Chat with ${h.name}`}
                  >
                    <span className={`sa-dot sa-dot-${pill.tone}`} aria-hidden="true" />
                    <span className="sa-host-main">
                      <strong>{h.name}</strong>
                      <span className="sa-muted">
                        {h.address}
                        {h.internet ? " · internet" : ""} · {pill.label}
                      </span>
                    </span>
                    <span className="sa-host-agents">
                      {agents.map((a) => (
                        <span key={a.id} className="sa-badge sa-badge-ok">
                          {a.id}
                        </span>
                      ))}
                    </span>
                    <span className="sa-tokens" title={tokenBreakdown(h.usage)}>
                      <b>{tokensUsed(h.usage)}</b>
                      <span className="sa-muted">tokens used</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small sa-danger"
                    onClick={() => void onLeave(h.id)}
                    onBlur={() => setLeaving((l) => (l === h.id ? null : l))}
                    aria-label={`${leaving === h.id ? "Confirm leaving" : "Leave"} ${h.name}`}
                  >
                    {leaving === h.id ? "Confirm leave" : "Leave"}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="sa-empty">
            {loaded
              ? "No PCs joined yet. Paste an invite link above to chat with another PC's Claude."
              : "Loading…"}
          </p>
        )}
      </section>

      {/* Chat */}
      <section className="sa-card" aria-labelledby="sa-chat-title">
        <header className="sa-chat-head">
          <div className="sa-chat-title">
            <h4 id="sa-chat-title">
              {activeHost?.connected ? `Chat with ${activeHost.name}` : "Chat"}
            </h4>
            <span className="sa-badge sa-badge-own">read-only · empty folder</span>
          </div>
          <div className="sa-chat-tools">
            <label htmlFor="sa-agent" className="sa-muted">
              Agent
            </label>
            <select
              id="sa-agent"
              className="select-input"
              value={agent}
              disabled={!choices.length || Boolean(busyChat)}
              onChange={(e) => setAgent(e.target.value as SharedAgentId)}
            >
              {choices.length ? (
                choices.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))
              ) : (
                <option value="">none available</option>
              )}
            </select>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={newChat}
              disabled={Boolean(busyChat)}
            >
              <Plus size={13} />
              <span>New chat</span>
            </button>
          </div>
        </header>

        <div
          className="sa-log"
          ref={logRef}
          role="log"
          aria-live="polite"
          aria-label="Conversation"
        >
          {messages.length === 0 && (
            <p className="sa-log-hint">
              {canSend
                ? "Ask anything. The agent can't see your files, and the chat clears when you close this window."
                : "No agent found. Join a PC, or install Claude Code on this PC."}
            </p>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`sa-msg sa-msg-${m.kind}`}>
              {m.who && <small>{m.who}</small>}
              <span>{m.kind === "agent" && !m.text ? "…" : m.text}</span>
            </div>
          ))}
        </div>

        <div className="sa-composer">
          <textarea
            className="text-input"
            aria-label="Message"
            rows={2}
            value={input}
            maxLength={20000}
            disabled={!canSend}
            placeholder={
              canSend
                ? "Ask the agent…  (Enter to send, Shift+Enter for a new line)"
                : "No agent available"
            }
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
          />
          {busyChat ? (
            <button
              type="button"
              className="btn btn-secondary sa-danger"
              onClick={() => void stopChat(busyChat)}
            >
              <Square size={13} />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void send()}
              disabled={!input.trim() || !canSend}
            >
              <Send size={13} />
              <span>Send</span>
            </button>
          )}
        </div>
      </section>
    </div>
  );
};
