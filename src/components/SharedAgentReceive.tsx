import { ClipboardEvent, FC, FormEvent, useEffect, useState } from "react";
import { ExternalLink, Link2, PictureInPicture2 } from "lucide-react";
import { parseInviteLink } from "../core/sharedAgent/invite";
import { joinHost, leaveHost } from "../services/sharedAgentService";
import {
  closeChatWindow,
  isChatPoppedOut,
  loadChatHandoff,
  onChatPoppedOut,
  popOutChat,
  type ChatSnapshot,
} from "../services/sharedChatWindow";
import { isTauriAvailable } from "../services/ptyService";
import { useJoinedHosts } from "../hooks/useJoinedHosts";
import { SharedAgentChat } from "./SharedAgentChat";
import { hostStatusPill, tokenBreakdown, tokensUsed } from "./sharedAgentViewModel";

const BAD_LINK =
  "That is not a valid invite link. It looks like http://192.168.1.20:8765/join#… (same network) or https://<tunnel address>/join#… (internet).";

interface ReceiveProps {
  /** True while this part of the panel is on screen: it loads and refreshes only then. */
  active: boolean;
}

/** "Use a shared agent": join a PC, then chat with its agent (here or in its own window). */
export const SharedAgentReceive: FC<ReceiveProps> = ({ active }) => {
  const { hosts, setHosts, loaded, error: loadError, refresh } = useJoinedHosts(active);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [poppedOut, setPoppedOut] = useState(isChatPoppedOut);
  // Remounts the chat with the conversation the popped-out window hands back.
  const [restored, setRestored] = useState<{ key: number; snapshot: ChatSnapshot | null }>({
    key: 0,
    snapshot: null,
  });

  // Pick a PC to talk to once there is one, and drop one that was left.
  useEffect(() => {
    if (activeId && hosts.some((h) => h.id === activeId)) return;
    setActiveId(hosts.find((h) => h.connected)?.id ?? hosts[0]?.id ?? null);
  }, [hosts, activeId]);

  useEffect(
    () =>
      onChatPoppedOut((open) => {
        setPoppedOut(open);
        if (open) return;
        const back = loadChatHandoff();
        if (back?.hostId && hosts.some((h) => h.id === back.hostId)) setActiveId(back.hostId);
        setRestored((r) => ({ key: r.key + 1, snapshot: back }));
      }),
    [hosts]
  );

  const onJoin = async (ev: FormEvent) => {
    ev.preventDefault();
    setNotice(null);
    if (!parseInviteLink(link)) {
      setJoinError(BAD_LINK);
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
    if (!busy) setActiveId(res.value.id);
  };

  // A pasted link replaces the box (stray spaces and newlines dropped) and is checked at once,
  // so a wrong one is flagged before Join is pressed.
  const onPasteLink = (ev: ClipboardEvent<HTMLInputElement>) => {
    const pasted = ev.clipboardData.getData("text").trim();
    if (!pasted) return;
    ev.preventDefault();
    setLink(pasted);
    const target = parseInviteLink(pasted);
    if (!target) {
      setNotice(null);
      setJoinError(BAD_LINK);
      return;
    }
    setJoinError(null);
    setNotice(`Valid invite link for ${target.origin}. Press Join.`);
  };

  const selectHost = (id: string) => {
    if (id === activeId || busy) return;
    setActiveId(id);
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
    setHosts((hs) => hs.filter((h) => h.id !== id));
    void refresh();
  };

  const joinForm = (
    <form className="sa-join" onSubmit={(e) => void onJoin(e)}>
      <input
        type="text"
        className="text-input sa-mono"
        aria-label="Invite link"
        placeholder="Paste invite link…"
        title="e.g. http://192.168.1.20:8765/join#…"
        value={link}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={joinError === BAD_LINK}
        onChange={(e) => {
          setLink(e.target.value);
          setJoinError(null);
          setNotice(null);
        }}
        onPaste={onPasteLink}
        onBlur={() => {
          if (link.trim() && !parseInviteLink(link)) setJoinError(BAD_LINK);
        }}
      />
      <button
        type="submit"
        className="btn btn-primary btn-small"
        disabled={!link.trim() || joining}
      >
        {joining ? "Joining…" : "Join"}
      </button>
    </form>
  );

  const joinMessage = joinError ? (
    <p className="error-text sa-rail-msg" role="alert">
      {joinError}
    </p>
  ) : notice ? (
    <p className="sa-muted sa-rail-msg">{notice}</p>
  ) : (
    <p className="sa-muted sa-rail-msg">
      Links work once and expire. The secret stays in the #fragment and is never logged.
    </p>
  );

  if (loaded && loadError && !hosts.length) {
    return (
      <div className="sa-receive-error">
        <p className="sa-empty" role="alert">
          {loadError}
        </p>
      </div>
    );
  }

  // Nothing joined yet: only the way to join. Chat appears once a PC is joined.
  if (!hosts.length) {
    return (
      <div className="sa-join-only">
        <div className="sa-join-card">
          <span className="sa-join-icon" aria-hidden="true">
            <Link2 size={20} />
          </span>
          <h4 id="sa-join-title">Join a shared agent</h4>
          <p className="sa-muted">
            {loaded
              ? "Ask the other PC for an invite link (Share my agent → Create invite), paste it here, and chat with its agent."
              : "Loading…"}
          </p>
          {joinForm}
          {joinMessage}
        </div>
      </div>
    );
  }

  return (
    <div className="sa-receive">
      {/* Every PC already joined, with the tokens used through it, and a box to join another */}
      <aside className="sa-rail" aria-labelledby="sa-join-title">
        <div className="sa-rail-head">
          <h4 id="sa-join-title">PCs you joined</h4>
          <span className="sa-badge">{hosts.length}</span>
        </div>
        {joinForm}
        {joinMessage}
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
                    {h.safetyCode && (
                      <span
                        className="sa-muted sa-safety"
                        title="End-to-end encrypted. This code should match the one on the host's Share screen."
                      >
                        Safety code <code>{h.safetyCode}</code>
                      </span>
                    )}
                    <span className="sa-muted">
                      {agents.length ? `${agents.map((a) => a.name).join(", ")} · ` : ""}
                      <span className="sa-tokens" title={tokenBreakdown(h.usage)}>
                        <b>{tokensUsed(h.usage)}</b> tokens used
                      </span>
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-small sa-danger sa-leave"
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
      </aside>

      {poppedOut ? (
        <section className="sa-chat sa-chat-away" aria-label="Chat">
          <div className="sa-log-hint">
            <ExternalLink size={26} aria-hidden="true" />
            <p>The chat is open in its own window.</p>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => void closeChatWindow()}
            >
              Bring it back here
            </button>
          </div>
        </section>
      ) : (
        <SharedAgentChat
          key={restored.key}
          hosts={hosts}
          hostId={activeId}
          initial={restored.snapshot}
          onBusyChange={setBusy}
          actions={({ busy: chatBusy, snapshot: s }) =>
            isTauriAvailable() ? (
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => void popOutChat(s)}
                disabled={chatBusy}
                title={
                  chatBusy ? "Wait for the answer, then pop out" : "Open the chat in its own window"
                }
                aria-label="Pop out chat"
              >
                <PictureInPicture2 size={13} />
                <span>Pop out</span>
              </button>
            ) : null
          }
        />
      )}
    </div>
  );
};
