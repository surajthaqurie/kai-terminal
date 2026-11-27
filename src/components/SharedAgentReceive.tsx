import { ClipboardEvent, FC, SubmitEvent, useEffect, useMemo, useState } from "react";
import { ClipboardPaste, ExternalLink, Link2, PictureInPicture2 } from "lucide-react";
import { readInviteLink } from "../core/sharedAgent/invite";
import { readClipboardText } from "../services/clipboardService";
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

const IDLE_HINT =
  "Links work once and expire. The secret stays in the #fragment and is never logged.";

/** "192.168.1.20:8765" or "my-pc.example.com" for an origin. */
const addressOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

interface ReceiveProps {
  /** True while this part of the panel is on screen: it loads and refreshes only then. */
  active: boolean;
}

/** "Use a shared agent": join a PC, then chat with its agent (here or in its own window). */
export const SharedAgentReceive: FC<ReceiveProps> = ({ active }) => {
  const { hosts, setHosts, loaded, error: loadError, refresh } = useJoinedHosts(active);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [link, setLink] = useState("");
  // Problems with the link show once it was pasted, left or submitted, not while it is typed.
  const [checked, setChecked] = useState(false);
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
  const reading = useMemo(() => (link.trim() ? readInviteLink(link) : null), [link]);

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

  const onJoin = async (ev: SubmitEvent) => {
    ev.preventDefault();
    setNotice(null);
    setChecked(true);
    if (!reading?.ok || joining) return;
    setJoining(true);
    setJoinError(null);
    const res = await joinHost(reading.link);
    setJoining(false);
    if (!res.ok) {
      setJoinError(res.error.message);
      return;
    }
    setLink("");
    setChecked(false);
    setNotice(`Joined ${res.value.name}.`);
    setHosts((hs) => [...hs.filter((h) => h.id !== res.value.id), res.value]);
    if (!busy) setActiveId(res.value.id);
  };

  /** Keeps just the link from pasted text, so a whole message can be pasted. */
  const takePasted = (pasted: string) => {
    const text = pasted.trim();
    if (!text) return;
    const r = readInviteLink(text);
    setLink(r.ok ? r.link : text);
    setChecked(true);
    setJoinError(null);
    setNotice(null);
  };

  const onPasteLink = (ev: ClipboardEvent<HTMLInputElement>) => {
    const pasted = ev.clipboardData.getData("text");
    if (!pasted.trim()) return;
    ev.preventDefault();
    takePasted(pasted);
  };

  const pasteFromClipboard = async () => {
    try {
      takePasted(await readClipboardText());
    } catch {
      setChecked(true);
      setJoinError(
        "Kai could not read the clipboard. Paste the link into the box instead (Ctrl+V)."
      );
    }
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

  const sameHost =
    reading?.ok === true
      ? hosts.find((h) => h.connected && h.address === addressOf(reading.target.origin))
      : undefined;
  const linkProblem = checked && reading && !reading.ok ? reading.reason : null;

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
        aria-invalid={linkProblem !== null}
        onChange={(e) => {
          setLink(e.target.value);
          setJoinError(null);
          setNotice(null);
        }}
        onPaste={onPasteLink}
        onBlur={() => {
          if (link.trim()) setChecked(true);
        }}
      />
      {!link.trim() && (
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={() => void pasteFromClipboard()}
          title="Paste the invite link from the clipboard"
        >
          <ClipboardPaste size={13} aria-hidden="true" />
          <span>Paste</span>
        </button>
      )}
      <button
        type="submit"
        className="btn btn-primary btn-small"
        disabled={!link.trim() || joining}
      >
        {joining ? "Joining…" : sameHost ? "Join again" : "Join"}
      </button>
    </form>
  );

  const joinMessage =
    joinError || linkProblem ? (
      <p className="error-text sa-rail-msg" role="alert">
        {joinError ?? linkProblem}
      </p>
    ) : notice ? (
      <p className="sa-muted sa-rail-msg" role="status">
        {notice}
      </p>
    ) : reading?.ok ? (
      <p className="sa-muted sa-rail-msg sa-link-ok" role="status">
        {sameHost
          ? `You already joined ${sameHost.name}. Joining again pairs this PC with it anew.`
          : `Invite for ${addressOf(reading.target.origin)} (${reading.target.tunnel ? "internet" : "same network"}). Press Join.`}
      </p>
    ) : (
      <p className="sa-muted sa-rail-msg">{IDLE_HINT}</p>
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
              ? "Ask the other PC for an invite link (Share my agent → Generate invite link), paste it here, and chat with its agent. Pasting the whole message it came in is fine."
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
