import { FC, Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import {
  INVITE_MINUTES,
  type InviteMinutes,
  type ShareDevice,
  type ShareStatus,
} from "../core/sharedAgent/types";
import {
  cancelInvite,
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
import { formatAgo, formatCountdown, tokenBreakdown, tokensUsed } from "./sharedAgentViewModel";
import { DevicePermissions, DeviceUsage } from "./SharedAgentDevice";

type DetailPanel = "usage" | "permissions";

const MINUTE_LABELS: Record<InviteMinutes, string> = { 5: "5 min", 15: "15 min", 60: "1 hour" };

interface ShownInvite {
  id: string;
  link: string;
  internetLink?: string;
  expiresAt: number;
}

type LinkKind = "lan" | "internet";

interface ShareProps {
  active: boolean;
}

const statePill = (d: ShareDevice) =>
  d.state === "connected"
    ? { label: "Connected", cls: "sa-badge-ok" }
    : d.state === "offline"
      ? { label: "Offline", cls: "sa-badge-warn" }
      : { label: "Disconnected", cls: "sa-badge-bad" };

/** "Share my agent": turn sharing on, pick agents, invite PCs, watch who is using them. */
export const SharedAgentShare: FC<ShareProps> = ({ active }) => {
  const [share, setShare] = useState<ShareStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [minutes, setMinutes] = useState<InviteMinutes>(15);
  const [invite, setInvite] = useState<ShownInvite | null>(null);
  const [copied, setCopied] = useState<LinkKind | null>(null);
  const [tunnelInput, setTunnelInput] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ id: string; panel: DetailPanel } | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    if (!enabled) setInvite(null);
    apply(await setSharing(enabled));
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
    setCopied(null);
    setInvite({
      id: res.value.invite.id,
      link: res.value.invite.link,
      internetLink: res.value.invite.internetLink,
      expiresAt: Date.now() + res.value.invite.expiresInSeconds * 1000,
    });
  };

  const copy = async (kind: LinkKind, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1500);
    } catch {
      // The link stays selectable below.
    }
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
      <div className="sa-stack">
        <p className={error ? "sa-empty" : "sa-muted"} role={error ? "alert" : undefined}>
          {error ?? "Loading…"}
        </p>
      </div>
    );
  }

  const tunnelText = tunnelInput.trim();
  const tunnelInvalid = tunnelText !== "" && parsePublicUrl(tunnelText) === null;
  const noAddress = share.enabled && share.listening !== null && share.listening.urls.length === 0;

  return (
    <div className="sa-stack">
      {error && (
        <p className="error-text sa-line" role="alert">
          {error}
        </p>
      )}

      <section className="sa-card" aria-labelledby="sa-sharing-title">
        <div className="sa-card-head">
          <div>
            <h4 id="sa-sharing-title">
              Sharing{" "}
              <span className={`sa-badge ${share.enabled ? "sa-badge-ok" : ""}`}>
                {share.enabled ? "on" : "off"}
              </span>
            </h4>
            <span className="sa-muted">
              {share.enabled && share.listening
                ? share.listening.urls.length
                  ? `Listening on ${share.listening.urls.join(", ")} · ${
                      share.publicUrl ? "same network + internet" : "same-network only"
                    }`
                  : `Listening on port ${share.listening.port}, but no network address was found.`
                : "Turn on to let PCs on your network chat with your agents. It stays off when Kai restarts."}
            </span>
          </div>
          <label className="sa-switch">
            <input
              type="checkbox"
              role="switch"
              aria-label="Share my agents"
              checked={share.enabled}
              disabled={busy}
              onChange={(e) => void toggle(e.target.checked)}
            />
            <span aria-hidden="true" />
          </label>
        </div>
        {noAddress && (
          <p className="sa-notice sa-notice-warn" role="alert">
            Connect to a network, then turn sharing off and on again so invite links can name this
            PC.
          </p>
        )}
      </section>

      {share.enabled && (
        <>
          <section className="sa-card" aria-labelledby="sa-agents-title">
            <h4 id="sa-agents-title">Agents you share</h4>
            {share.agents.map((a) => (
              <div key={a.id} className="sa-row">
                <span>
                  {a.name}{" "}
                  {a.available ? (
                    <span className="sa-badge sa-badge-ok">
                      Found{a.version ? ` · ${a.version}` : ""}
                    </span>
                  ) : (
                    <span className="sa-badge" title={a.error}>
                      Not found
                    </span>
                  )}
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
            <span className="sa-muted">
              Shared agents are read-only: they chat in an empty folder and can't read your files,
              run commands or use MCP tools.
            </span>
          </section>

          <section className="sa-card" aria-labelledby="sa-internet-title">
            <h4 id="sa-internet-title">
              Internet access{" "}
              <span className={`sa-badge ${share.publicUrl ? "sa-badge-ok" : ""}`}>
                {share.publicUrl ? "on" : "off"}
              </span>
            </h4>
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
                  PCs outside your network can join through this address with an invite link. If the
                  tunnel restarts with a new address, paste the new one.
                </span>
              </>
            ) : (
              <>
                <span className="sa-muted">
                  To let PCs outside your network join, point any HTTPS tunnel or reverse proxy at
                  port <code>{share.listening?.port ?? 8765}</code> on this PC and paste its public
                  https address here. Kai never starts a tunnel for you.
                </span>
                <form
                  className="sa-invite-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveTunnel();
                  }}
                >
                  <input
                    className="text-input"
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
                  <span id="sa-tunnel-error" className="error-text">
                    Use the tunnel&apos;s https address with nothing after the host name, e.g.
                    https://my-pc.example.com
                  </span>
                )}
              </>
            )}
          </section>

          <section className="sa-card" aria-labelledby="sa-invite-title">
            <h4 id="sa-invite-title">Invite a PC</h4>
            <div className="sa-invite-row">
              <label htmlFor="sa-expiry" className="sa-muted">
                Expires
              </label>
              <select
                id="sa-expiry"
                className="select-input"
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
                className="btn btn-primary"
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
                    ["lan", invite.link, "Same network"],
                    ...(invite.internetLink
                      ? [["internet", invite.internetLink, "Internet"] as const]
                      : []),
                  ] as const
                ).map(([kind, text, label]) => (
                  <div key={kind} className="sa-invite-actions">
                    {invite.internetLink && <span className="sa-muted">{label}</span>}
                    <code
                      className="sa-invite-link"
                      aria-label={kind === "lan" ? "Invite link" : "Internet invite link"}
                    >
                      {text}
                    </code>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      aria-label={kind === "internet" ? "Copy internet link" : undefined}
                      onClick={() => void copy(kind, text)}
                    >
                      {copied === kind ? <Check size={13} /> : <Copy size={13} />}
                      <span>{copied === kind ? "Copied" : "Copy"}</span>
                    </button>
                  </div>
                ))}
                <div className="sa-invite-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-small sa-danger"
                    onClick={() => void run(() => cancelInvite(invite.id))}
                  >
                    Cancel invite
                  </button>
                  <span className="sa-muted">
                    Shown once · works once · expires in{" "}
                    {formatCountdown((invite.expiresAt - now) / 1000)}
                  </span>
                </div>
              </div>
            )}
          </section>

          <section className="sa-card" aria-labelledby="sa-devices-title">
            <h4 id="sa-devices-title">Connected PCs</h4>
            {share.devices.length ? (
              <div className="sa-table-wrap">
                <table className="sa-table">
                  <thead>
                    <tr>
                      <th>PC</th>
                      <th>Status</th>
                      <th>Tokens used</th>
                      <th>Last seen</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {share.devices.map((d) => {
                      const pill = statePill(d);
                      const open = detail?.id === d.id ? detail.panel : null;
                      return (
                        <Fragment key={d.id}>
                          <tr>
                            <td>
                              <strong>{d.name}</strong>
                              <br />
                              <span className="sa-muted">{d.address}</span>
                            </td>
                            <td>
                              <span className={`sa-badge ${pill.cls}`}>{pill.label}</span>
                            </td>
                            <td title={tokenBreakdown(d.usage)}>
                              {tokensUsed(d.usage)}
                              <br />
                              <span className="sa-muted">
                                {d.usage.runs} request{d.usage.runs === 1 ? "" : "s"}
                              </span>
                            </td>
                            <td>{formatAgo(d.lastSeen, now)}</td>
                            <td>
                              <div className="sa-actions">
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-small"
                                  aria-expanded={open === "usage"}
                                  onClick={() => toggleDetail(d.id, "usage")}
                                >
                                  Usage
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-small"
                                  aria-expanded={open === "permissions"}
                                  onClick={() => toggleDetail(d.id, "permissions")}
                                >
                                  Permissions
                                </button>
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
                            </td>
                          </tr>
                          {open && (
                            <tr className="sa-detail-row">
                              <td colSpan={5}>
                                {open === "usage" ? (
                                  <DeviceUsage device={d} now={now} />
                                ) : (
                                  <DevicePermissions
                                    device={d}
                                    agents={share.agents}
                                    apply={apply}
                                    onClose={() => setDetail(null)}
                                  />
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="sa-empty">
                No PCs have joined yet. Generate an invite link and send it to the other PC.
              </p>
            )}
          </section>

          {share.runs.length > 0 && (
            <section className="sa-card" aria-labelledby="sa-runs-title">
              <h4 id="sa-runs-title">Live runs</h4>
              {share.runs.map((r) => (
                <div key={r.id} className="sa-row">
                  <span>
                    <span className="sa-dot sa-dot-ok" aria-hidden="true" />{" "}
                    <strong>{r.deviceName}</strong> is running <code>{r.agent}</code>
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small sa-danger"
                    onClick={() => void run(() => stopHostRun(r.id))}
                  >
                    Stop
                  </button>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
};
