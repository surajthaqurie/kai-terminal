import { FC, useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Copy,
  Globe,
  Lock,
  Play,
  Share2,
  Square,
} from "lucide-react";
import {
  INVITE_MINUTES,
  MAX_SHARE_PORT,
  MIN_SHARE_PORT,
  parseSharePort,
  totalTokens,
  type InviteMinutes,
  type ShareDevice,
  type ShareStatus,
} from "../core/sharedAgent/types";
import {
  cancelInvite,
  checkPort,
  createInvite,
  disconnectDevice,
  getShareStatus,
  onSharedAgentEvent,
  removeDevice,
  setAgentShared,
  setPublicUrl,
  setSharing,
  stopHostRun,
  type SharedResult,
} from "../services/sharedAgentService";
import { parsePublicUrl } from "../core/sharedAgent/invite";
import {
  formatAgo,
  formatCompact,
  formatCost,
  formatCountdown,
  initials,
  tokenBreakdown,
  tokensUsed,
} from "./sharedAgentViewModel";
import { DevicePermissions, DeviceUsage } from "./SharedAgentDevice";

type DetailPanel = "usage" | "permissions";
type DeviceFilter = "all" | "active" | "disconnected";

const MINUTE_LABELS: Record<InviteMinutes, string> = {
  5: "5 minutes",
  15: "15 minutes",
  60: "1 hour",
  0: "Until I turn it off",
};

interface ShownInvite {
  id: string;
  link: string;
  internetLink?: string;
  /** null = no time limit: valid until used, cancelled or sharing stops. */
  expiresAt: number | null;
  totalSeconds: number | null;
}

/** What the port box last learned: checked, being checked, or a message after stopping. */
type PortNote = { tone: "ok" | "bad" | "muted"; text: string } | null;

interface ShareProps {
  active: boolean;
}

const deviceTone = (d: ShareDevice) =>
  d.state === "connected"
    ? { label: "Connected", tone: "ok" }
    : d.state === "offline"
      ? { label: "Offline", tone: "warn" }
      : { label: "Disconnected", tone: "bad" };

/** One-click copy with a short "copied" tick. */
const useCopy = () => {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      // The text stays selectable.
    }
  };
  return { copied, copy, reset: () => setCopied(null) };
};

/** "Share my agent": turn sharing on, pick agents, invite PCs, watch who is using them. */
export const SharedAgentShare: FC<ShareProps> = ({ active }) => {
  const [share, setShare] = useState<ShareStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [minutes, setMinutes] = useState<InviteMinutes>(15);
  const [invite, setInvite] = useState<ShownInvite | null>(null);
  const [tunnelInput, setTunnelInput] = useState("");
  const [netOpen, setNetOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ id: string; panel: DetailPanel } | null>(null);
  const [filter, setFilter] = useState<DeviceFilter>("all");
  const [portText, setPortText] = useState("");
  const [portNote, setPortNote] = useState<PortNote>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { copied, copy, reset: resetCopied } = useCopy();

  const apply = useCallback((res: SharedResult<ShareStatus>): boolean => {
    if (!res.ok) {
      setError(res.error.message);
      return false;
    }
    setError(null);
    setShare(res.value);
    return true;
  }, []);

  const refresh = useCallback(async () => {
    apply(await getShareStatus());
  }, [apply]);

  useEffect(() => {
    if (active) void getShareStatus(true).then(apply);
  }, [active, apply]);

  // Refetch when the service says something changed; coalesced so a burst is one request.
  useEffect(() => {
    let off = () => {};
    let cancelled = false;
    void onSharedAgentEvent((e) => {
      if (e.event !== "share") return;
      if (refreshTimer.current) return;
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        void refresh();
      }, 150);
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    });
    return () => {
      cancelled = true;
      off();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh]);

  // "Last seen" and invite countdowns move on their own.
  useEffect(() => {
    if (!active || !share?.enabled) return;
    const t = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 10_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(t);
      clearInterval(tick);
    };
  }, [active, share?.enabled, refresh]);

  // An invite that is gone from the host's list was used, cancelled or expired.
  useEffect(() => {
    if (invite && share && !share.invites.some((i) => i.id === invite.id)) setInvite(null);
  }, [share, invite]);

  // The port box follows the saved port until the person types in it.
  const savedPort = share?.port;
  useEffect(() => {
    if (savedPort !== undefined) setPortText((t) => (t === "" ? String(savedPort) : t));
  }, [savedPort]);

  const runPortCheck = async (port: number): Promise<boolean> => {
    setPortNote({ tone: "muted", text: `Checking port ${port}…` });
    const res = await checkPort(port);
    if (!res.ok) {
      setPortNote({ tone: "bad", text: res.error.message });
      return false;
    }
    setPortNote({ tone: res.value.available ? "ok" : "bad", text: res.value.message });
    return res.value.available;
  };

  const start = async () => {
    const port = parseSharePort(portText);
    if (port === null) return;
    setBusy(true);
    // Check first, so a taken port is explained before anything starts.
    if (await runPortCheck(port)) {
      if (apply(await setSharing(true, port))) setPortNote(null);
    }
    setBusy(false);
  };

  const stop = async () => {
    const port = share?.listening?.port ?? null;
    setBusy(true);
    setInvite(null);
    const okay = apply(await setSharing(false));
    if (okay && port !== null) {
      // Confirm the port really is free again for other programs.
      const res = await checkPort(port);
      setPortNote(
        res.ok && res.value.available
          ? { tone: "ok", text: `Sharing stopped. Port ${port} was released.` }
          : { tone: "bad", text: `Sharing stopped, but port ${port} is still in use.` }
      );
    }
    setBusy(false);
  };

  const makeInvite = async () => {
    setBusy(true);
    const res = await createInvite(minutes);
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setError(null);
    setShare(res.value.share);
    resetCopied();
    setNow(Date.now());
    setInvite({
      id: res.value.invite.id,
      link: res.value.invite.link,
      internetLink: res.value.invite.internetLink,
      expiresAt:
        res.value.invite.expiresInSeconds === null
          ? null
          : Date.now() + res.value.invite.expiresInSeconds * 1000,
      totalSeconds: res.value.invite.expiresInSeconds,
    });
  };

  const saveTunnel = async () => {
    setBusy(true);
    const okay = apply(await setPublicUrl(tunnelInput.trim()));
    setBusy(false);
    if (okay) setTunnelInput("");
  };

  const removeTunnel = async () => {
    setBusy(true);
    // Links already shown may name the old address; hide them.
    setInvite((i) => (i ? { ...i, internetLink: undefined } : i));
    apply(await setPublicUrl(null));
    setBusy(false);
  };

  const run = async (fn: () => Promise<SharedResult<ShareStatus>>) => {
    apply(await fn());
  };

  const toggleDetail = (id: string, panel: DetailPanel) =>
    setDetail((d) => (d?.id === id && d.panel === panel ? null : { id, panel }));

  if (!share) {
    return (
      <div className="sa-share">
        <p className={error ? "sa-empty" : "sa-muted"} role={error ? "alert" : undefined}>
          {error ?? "Loading…"}
        </p>
      </div>
    );
  }

  const on = share.enabled;
  const tunnelText = tunnelInput.trim();
  const tunnelInvalid = tunnelText !== "" && parsePublicUrl(tunnelText) === null;
  const noAddress = on && share.listening !== null && share.listening.urls.length === 0;
  const connectedCount = share.devices.filter((d) => d.state === "connected").length;
  const allTokens = share.devices.reduce((n, d) => n + totalTokens(d.usage), 0);
  const maxTokens = Math.max(1, ...share.devices.map((d) => totalTokens(d.usage)));
  const shownDevices = share.devices.filter((d) =>
    filter === "all"
      ? true
      : filter === "active"
        ? d.state !== "disconnected"
        : d.state === "disconnected"
  );
  const inviteLeft = invite?.expiresAt != null ? (invite.expiresAt - now) / 1000 : 0;
  const portValue = parseSharePort(portText);
  const portInvalid = portText.trim() !== "" && portValue === null;

  return (
    <div className="sa-share">
      {error && (
        <p className="error-text sa-line" role="alert">
          {error}
        </p>
      )}

      {/* Status: one switch, the addresses PCs join through, and a glance at use. */}
      <section className={`sa-hero${on ? "" : " is-off"}`} aria-labelledby="sa-sharing-title">
        <span className="sa-hero-icon" aria-hidden="true">
          <Share2 size={18} />
        </span>
        <div className="sa-hero-main">
          <h4 id="sa-sharing-title">
            Sharing is {on ? "on" : "off"}
            {on && (
              <span className="sa-badge sa-badge-ok">
                <span className="sa-dot sa-dot-ok sa-dot-live" aria-hidden="true" /> Live
              </span>
            )}
          </h4>
          {on && share.listening ? (
            share.listening.urls.length ? (
              <>
                <span className="sa-muted">
                  PCs with an invite can chat with your agents ·{" "}
                  {share.publicUrl ? "same network + internet" : "same-network only"}
                </span>
                <div className="sa-addr">
                  <span className="sa-muted">Listening on </span>
                  {share.listening.urls.map((u) => (
                    <span key={u} className="sa-chip">
                      {u}
                      <button
                        type="button"
                        aria-label={`Copy ${u}`}
                        onClick={() => void copy(u, u)}
                      >
                        {copied === u ? <Check size={11} /> : <Copy size={11} />}
                      </button>
                    </span>
                  ))}
                  {share.publicUrl && (
                    <span className="sa-chip sa-chip-net">
                      <Globe size={11} aria-hidden="true" />
                      {share.publicUrl}
                      <button
                        type="button"
                        aria-label={`Copy ${share.publicUrl}`}
                        onClick={() => void copy("public", share.publicUrl!)}
                      >
                        {copied === "public" ? <Check size={11} /> : <Copy size={11} />}
                      </button>
                    </span>
                  )}
                </div>
                {share.safetyCode && (
                  <span
                    className="sa-muted sa-safety"
                    title="Every chat is end-to-end encrypted. A joined PC shows this same code: compare them to be sure no one is in between."
                  >
                    End-to-end encrypted · safety code <code>{share.safetyCode}</code>
                  </span>
                )}
              </>
            ) : (
              <span className="sa-muted">
                Listening on port {share.listening.port}, but no network address was found.
              </span>
            )
          ) : (
            <span className="sa-muted">
              Start sharing to let PCs on your network chat with your agents. Sharing stays off when
              Kai restarts.
            </span>
          )}
        </div>
        {on && (
          <div className="sa-hero-stats">
            <div>
              <b>{connectedCount}</b>
              <span>connected</span>
            </div>
            <div>
              <b>{share.runs.length}</b>
              <span>running now</span>
            </div>
            <div title={`${allTokens.toLocaleString("en-US")} tokens`}>
              <b>{formatCompact(allTokens)}</b>
              <span>tokens used</span>
            </div>
          </div>
        )}
        {on ? (
          <button
            type="button"
            className="btn btn-secondary sa-danger"
            onClick={() => void stop()}
            disabled={busy}
          >
            <Square size={13} aria-hidden="true" />
            Stop sharing
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void start()}
            disabled={busy || portValue === null}
          >
            <Play size={13} aria-hidden="true" />
            Start sharing
          </button>
        )}
      </section>

      {/* Port: chosen while off, shown (read-only) while on. */}
      <section className="sa-card" aria-labelledby="sa-port-title">
        <h4 id="sa-port-title" className="sa-card-title">
          Connection
        </h4>
        <form
          className="sa-field"
          onSubmit={(e) => {
            e.preventDefault();
            if (portValue !== null) void runPortCheck(portValue);
          }}
        >
          <label htmlFor="sa-port" className="sa-field-label">
            Port
          </label>
          <div className="sa-invite-row">
            <input
              id="sa-port"
              className="text-input sa-mono sa-port-input"
              inputMode="numeric"
              aria-invalid={portInvalid}
              aria-describedby="sa-port-help"
              value={on ? String(share.listening?.port ?? share.port) : portText}
              disabled={on || busy}
              onChange={(e) => {
                setPortText(e.target.value.replace(/[^0-9]/g, "").slice(0, 5));
                setPortNote(null);
              }}
            />
            {!on && (
              <button
                type="submit"
                className="btn btn-secondary"
                disabled={busy || portValue === null}
              >
                Check port
              </button>
            )}
          </div>
          <span id="sa-port-help" className="sa-muted">
            {portInvalid
              ? `Use a number from ${MIN_SHARE_PORT} to ${MAX_SHARE_PORT}.`
              : on
                ? "Stop sharing to change the port. It is released as soon as sharing stops."
                : "Other PCs connect to this port. Kai checks it is free before it starts, and releases it when you stop."}
          </span>
          {portNote && (
            <span
              className={`sa-port-note sa-port-note-${portNote.tone}`}
              role={portNote.tone === "bad" ? "alert" : "status"}
            >
              {portNote.tone === "ok" ? (
                <CircleCheck size={13} aria-hidden="true" />
              ) : portNote.tone === "bad" ? (
                <CircleAlert size={13} aria-hidden="true" />
              ) : null}
              {portNote.text}
            </span>
          )}
        </form>
      </section>

      {noAddress && (
        <p className="sa-notice sa-notice-warn" role="alert">
          Connect to a network, then turn sharing off and on again so invite links can name this PC.
        </p>
      )}

      {!on && (
        <ol className="sa-steps">
          <li>
            <b>1</b>
            <strong>Pick a port and start sharing</strong>
            <span className="sa-muted">Kai listens on your local network only.</span>
          </li>
          <li>
            <b>2</b>
            <strong>Send an invite link</strong>
            <span className="sa-muted">
              Works once. Expires after 5 to 60 minutes, or stays valid until you turn it off.
            </span>
          </li>
          <li>
            <b>3</b>
            <strong>Watch and control</strong>
            <span className="sa-muted">See tokens per PC, set limits, disconnect any time.</span>
          </li>
        </ol>
      )}

      {on && (
        <div className="sa-share-grid">
          <div className="sa-col">
            <section className="sa-card" aria-labelledby="sa-invite-title">
              <h4 id="sa-invite-title" className="sa-card-title">
                Invite a PC
              </h4>
              <label htmlFor="sa-expiry" className="sa-field-label">
                Link expires
              </label>
              <div className="sa-invite-row">
                <select
                  id="sa-expiry"
                  className="select-input sa-expiry-select"
                  aria-label="Invite expires after"
                  value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value) as InviteMinutes)}
                >
                  {INVITE_MINUTES.map((m) => (
                    <option key={m} value={m}>
                      {MINUTE_LABELS[m]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-primary sa-grow"
                  onClick={() => void makeInvite()}
                  disabled={busy}
                >
                  Generate invite link
                </button>
              </div>
              {invite && (
                <div className="sa-invite-box">
                  {(
                    [
                      ["lan", invite.link, "LAN"],
                      ...(invite.internetLink
                        ? [["internet", invite.internetLink, "WEB"] as const]
                        : []),
                    ] as const
                  ).map(([kind, text, tag]) => (
                    <div key={kind} className="sa-link-line">
                      <span className={`sa-badge ${kind === "internet" ? "sa-badge-accent" : ""}`}>
                        {tag}
                      </span>
                      <code
                        className="sa-invite-link"
                        aria-label={kind === "lan" ? "Invite link" : "Internet invite link"}
                      >
                        {text}
                      </code>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        aria-label={kind === "internet" ? "Copy internet link" : "Copy invite link"}
                        onClick={() => void copy(kind, text)}
                      >
                        {copied === kind ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    </div>
                  ))}
                  {invite.totalSeconds !== null && (
                    <div className="sa-countdown" aria-hidden="true">
                      <i
                        style={{
                          width: `${Math.max(0, Math.min(1, inviteLeft / invite.totalSeconds)) * 100}%`,
                        }}
                      />
                    </div>
                  )}
                  <div className="sa-row">
                    <span className="sa-muted">
                      {invite.expiresAt === null
                        ? "Shown once · works once · valid until you cancel it or stop sharing"
                        : `Shown once · works once · expires in ${formatCountdown(inviteLeft)}`}
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small sa-danger"
                      onClick={() => void run(() => cancelInvite(invite.id))}
                    >
                      Cancel invite
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section className="sa-card" aria-labelledby="sa-agents-title">
              <h4 id="sa-agents-title" className="sa-card-title">
                Agents you share
              </h4>
              {share.agents.every((a) => !a.available) && !share.otherClis?.length && (
                <span className="sa-muted sa-block">
                  No coding agents found on this PC. Install Claude Code or OpenCode, then reopen
                  this panel.
                </span>
              )}
              {share.agents
                .filter((a) => a.available)
                .map((a) => (
                  <div
                    key={a.id}
                    className={`sa-agent${a.available ? "" : " is-missing"}`}
                    title={a.available ? undefined : a.error}
                  >
                    <span className={`sa-agent-logo sa-agent-${a.id}`} aria-hidden="true">
                      {a.name.charAt(0)}
                    </span>
                    <span className="sa-grow">
                      {a.name}
                      <span className="sa-muted sa-block">
                        {a.available ? `Found${a.version ? ` · ${a.version}` : ""}` : "Not found"}
                      </span>
                    </span>
                    <label className="sa-switch">
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={`Share ${a.name}`}
                        checked={a.enabled && a.available}
                        disabled={!a.available}
                        onChange={(e) => void run(() => setAgentShared(a.id, e.target.checked))}
                      />
                      <span aria-hidden="true" />
                    </label>
                  </div>
                ))}
              {(share.otherClis ?? []).map((o) => (
                <div key={o.id} className="sa-agent is-unshareable" title={o.reason}>
                  <span className={`sa-agent-logo sa-agent-${o.id}`} aria-hidden="true">
                    {o.name.charAt(0)}
                  </span>
                  <span className="sa-grow">
                    {o.name}
                    <span className="sa-muted sa-block">Found · can't be shared: {o.reason}</span>
                  </span>
                  <label className="sa-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`Share ${o.name} (not available)`}
                      checked={false}
                      disabled
                      readOnly
                    />
                    <span aria-hidden="true" />
                  </label>
                </div>
              ))}
              <span className="sa-muted sa-note">
                <Lock size={11} aria-hidden="true" />
                Read-only: they chat in an empty folder and can't read your files, run commands or
                use MCP tools.
              </span>
            </section>

            <details
              className="sa-card sa-fold"
              open={netOpen}
              onToggle={(e) => setNetOpen(e.currentTarget.open)}
            >
              <summary>
                <h4 id="sa-internet-title" className="sa-card-title">
                  Internet access
                </h4>
                <span
                  className={`sa-badge ${share.publicUrl ? "sa-badge-ok" : ""}`}
                  title={
                    share.publicUrl
                      ? "PCs outside your network can join through your tunnel address."
                      : "Only PCs on your own network (same Wi-Fi or LAN) can join."
                  }
                >
                  {share.publicUrl ? "Enabled" : "LAN only"}
                </span>
                <ChevronDown size={14} className="sa-fold-chev" aria-hidden="true" />
              </summary>
              {share.publicUrl ? (
                <>
                  <div className="sa-row">
                    <code className="sa-tunnel-url">{share.publicUrl}</code>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small sa-danger"
                      onClick={() => void removeTunnel()}
                      disabled={busy}
                    >
                      Turn off
                    </button>
                  </div>
                  <span className="sa-muted">
                    PCs outside your network can join through this address with an invite link. If
                    the tunnel restarts with a new address, paste the new one.
                  </span>
                </>
              ) : (
                <>
                  <span className="sa-muted">
                    Optional. Right now only PCs on your own network (same Wi-Fi or LAN) can join.
                    To let PCs outside your network join, point any HTTPS tunnel or reverse proxy at
                    port <code>{share.listening?.port ?? 8765}</code> on this PC and paste its
                    public https address here. Kai never starts a tunnel for you.
                  </span>
                  <form
                    className="sa-invite-row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveTunnel();
                    }}
                  >
                    <input
                      className="text-input sa-grow sa-mono"
                      aria-label="Tunnel address"
                      placeholder="https://my-pc.example.com"
                      value={tunnelInput}
                      aria-invalid={tunnelInvalid}
                      aria-describedby={tunnelInvalid ? "sa-tunnel-error" : undefined}
                      onChange={(e) => setTunnelInput(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="btn btn-secondary"
                      disabled={busy || !tunnelText || tunnelInvalid}
                    >
                      Use address
                    </button>
                  </form>
                  {tunnelInvalid && (
                    <span id="sa-tunnel-error" className="error-text sa-line">
                      Use the tunnel&apos;s https address with nothing after the host name, e.g.
                      https://my-pc.example.com
                    </span>
                  )}
                </>
              )}
            </details>
          </div>

          <section className="sa-card sa-devices" aria-labelledby="sa-devices-title">
            <div className="sa-card-head">
              <h4 id="sa-devices-title" className="sa-card-title">
                Connected PCs
              </h4>
              <span className="sa-badge">{share.devices.length}</span>
              {share.devices.length > 0 && (
                <div className="sa-filter" role="group" aria-label="Show PCs">
                  {(
                    [
                      ["all", "All"],
                      ["active", "Active"],
                      ["disconnected", "Disconnected"],
                    ] as const
                  ).map(([f, label]) => (
                    <button
                      key={f}
                      type="button"
                      aria-pressed={filter === f}
                      className={filter === f ? "active" : ""}
                      onClick={() => setFilter(f)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {share.runs.length > 0 && (
              <div className="sa-runs" aria-label="Live runs">
                {share.runs.map((r) => (
                  <div key={r.id} className="sa-run">
                    <span className="sa-dot sa-dot-ok sa-dot-live" aria-hidden="true" />
                    <span className="sa-grow">
                      <strong>{r.deviceName}</strong> is running <code>{r.agent}</code>
                    </span>
                    <span className="sa-mono">{formatAgo(r.startedAt, now)}</span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small sa-danger"
                      onClick={() => void run(() => stopHostRun(r.id))}
                    >
                      <Square size={11} />
                      <span>Stop</span>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {shownDevices.length ? (
              <div className="sa-device-list">
                {shownDevices.map((d) => {
                  const pill = deviceTone(d);
                  const open = detail?.id === d.id ? detail.panel : null;
                  const tokens = totalTokens(d.usage);
                  return (
                    <article key={d.id} className="sa-device" aria-label={d.name}>
                      <div className="sa-device-main">
                        <span className="sa-avatar" aria-hidden="true">
                          {initials(d.name)}
                          <span className={`sa-dot sa-dot-${pill.tone}`} />
                        </span>
                        <div className="sa-device-who">
                          <strong>
                            {d.name}{" "}
                            <span className={`sa-badge sa-badge-${pill.tone}`}>{pill.label}</span>
                            {d.activeRunId && (
                              <span className="sa-badge sa-badge-accent">running</span>
                            )}
                          </strong>
                          <span className="sa-muted">
                            <span className="sa-mono">{d.address}</span> · seen{" "}
                            {formatAgo(d.lastSeen, now)} · {d.usage.runs} request
                            {d.usage.runs === 1 ? "" : "s"}
                          </span>
                        </div>
                        <div className="sa-device-tokens" title={tokenBreakdown(d.usage)}>
                          <b>{tokensUsed(d.usage)}</b>
                          <span className="sa-muted">tokens · {formatCost(d.usage.costUsd)}</span>
                          <span className="sa-meter" aria-hidden="true">
                            <i style={{ width: `${(tokens / maxTokens) * 100}%` }} />
                          </span>
                        </div>
                        {d.state !== "disconnected" ? (
                          <button
                            type="button"
                            className="btn btn-secondary btn-small sa-danger"
                            onClick={() => void run(() => disconnectDevice(d.id))}
                          >
                            Disconnect
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-secondary btn-small sa-danger"
                            onClick={() => {
                              if (confirmRemove !== d.id) setConfirmRemove(d.id);
                              else {
                                setConfirmRemove(null);
                                void run(() => removeDevice(d.id));
                              }
                            }}
                            onBlur={() => setConfirmRemove((c) => (c === d.id ? null : c))}
                          >
                            {confirmRemove === d.id ? "Confirm remove" : "Remove"}
                          </button>
                        )}
                      </div>
                      <div className="sa-device-tabs">
                        <button
                          type="button"
                          className={open === "usage" ? "active" : ""}
                          aria-expanded={open === "usage"}
                          onClick={() => toggleDetail(d.id, "usage")}
                        >
                          Usage
                        </button>
                        <button
                          type="button"
                          className={open === "permissions" ? "active" : ""}
                          aria-expanded={open === "permissions"}
                          onClick={() => toggleDetail(d.id, "permissions")}
                        >
                          Permissions
                        </button>
                      </div>
                      {open &&
                        (open === "usage" ? (
                          <DeviceUsage device={d} now={now} />
                        ) : (
                          <DevicePermissions
                            device={d}
                            agents={share.agents}
                            apply={apply}
                            onClose={() => setDetail(null)}
                          />
                        ))}
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="sa-empty">
                {share.devices.length
                  ? "No PCs match this filter."
                  : "No PCs have joined yet. Generate an invite link and send it to the other PC."}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
};
