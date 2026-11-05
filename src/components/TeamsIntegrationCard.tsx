import { FC, useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle, Info, MessageSquare, Plus } from "lucide-react";
import type { IntegrationErrorBody, TeamsStatusView } from "../core/integrations/rpcTypes";
import {
  getTeamsStatus,
  teamsLogin,
  teamsLogout,
  verifyTeams,
} from "../services/integrationService";
import {
  CHANNELS_NOTE,
  deriveTeamsState,
  describeAccess,
  describeTeamsAccount,
  explainTeamsError,
  teamsBadge,
} from "./teamsViewModel";
import { formatError, initialsOf } from "./integrationsViewModel";

type Busy = "load" | "connect" | "channels" | "verify" | "logout" | null;

/**
 * Microsoft Teams in the Integrations tab. Unlike Azure DevOps it is the person's
 * own account: shared by every terminal, never bound to a folder and never handed
 * to an AI agent. Sign-in opens the browser (OAuth 2.0 code + PKCE, run by the CLI);
 * this card only shows the result and starts the same commands as `kai integration teams`.
 */
export const TeamsIntegrationCard: FC = () => {
  const [status, setStatus] = useState<TeamsStatusView | null>(null);
  const [busy, setBusy] = useState<Busy>("load");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<IntegrationErrorBody | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);

  // A reply that arrives after the tab closed is dropped.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const res = await getTeamsStatus();
    if (!mounted.current) return;
    if (res.ok) setStatus(res.value);
    else setError(res.error);
  }, []);

  useEffect(() => {
    void refresh().then(() => {
      if (mounted.current) setBusy(null);
    });
  }, [refresh]);

  // No refresh button: the card re-reads itself whenever the window regains focus.
  const busyNow = useRef(busy);
  busyNow.current = busy;
  useEffect(() => {
    const onFocus = () => {
      if (busyNow.current === null) void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const run = async (kind: Exclude<Busy, null>, work: () => Promise<void>) => {
    setBusy(kind);
    setNotice(null);
    setError(null);
    try {
      await work();
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const signIn = (retryChannels = false) =>
    void run(retryChannels ? "channels" : "connect", async () => {
      const res = await teamsLogin();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setStatus(res.value);
      const who = res.value.account ? describeTeamsAccount(res.value.account) : "your account";
      setNotice(
        !res.value.channelHistory
          ? `Signed in as ${who}. Channel messages need admin approval.`
          : `Signed in as ${who}.`
      );
    });

  const verify = () =>
    void run("verify", async () => {
      const res = await verifyTeams();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNotice(describeAccess(res.value));
    });

  const signOut = () => {
    setConfirmLogout(false);
    void run("logout", async () => {
      const res = await teamsLogout();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setStatus(res.value);
      setNotice("Signed out of Microsoft Teams.");
    });
  };

  const state = deriveTeamsState(status);
  const badge = teamsBadge(state);
  const account = status?.account ?? null;
  const disabled = busy !== null;
  const shownError = error ? formatError(explainTeamsError(error)) : null;
  const switchLabel = busy === "connect" ? "Waiting for browser…" : "Switch account";

  return (
    <section
      className={`integration-card${state === "signed_in" ? " is-live" : ""}`}
      aria-label="Microsoft Teams"
    >
      <div className="integration-card-head">
        <span className="integration-tile" aria-hidden="true">
          <MessageSquare size={16} />
        </span>
        <div className="integration-titles">
          <h3>Microsoft Teams</h3>
          <p>
            Chat from a terminal tab with <code>kai teams</code>. Your own account, never shared
            with AI agents.
          </p>
        </div>
        <div className="integration-head-end">
          <span
            className={`integration-pill${badge.tone === "ok" ? " is-ok" : ""}${
              badge.tone === "warn" ? " is-warn" : ""
            }`}
            data-state={state}
          >
            {busy === "load" ? "Checking…" : badge.label}
          </span>
          {state === "signed_in" && (
            <button
              type="button"
              className="integration-icon-btn"
              data-tip={switchLabel}
              disabled={disabled}
              onClick={() => signIn()}
            >
              <Plus size={14} aria-hidden="true" />
              <span className="sr-only">{switchLabel}</span>
            </button>
          )}
        </div>
      </div>

      {state !== "loading" && (
        <div className="integration-section">
          {state === "not_configured" && (
            <p className="integration-warn integration-detected" role="status">
              Sign-in is not set up in this build of Kai: no Microsoft Entra app is registered for
              it. Maintainers: see docs/teams-sign-in.md.
            </p>
          )}

          {account && (
            <>
              <div className="integration-who" role="group" aria-label="Microsoft Teams account">
                <span className="integration-avatar" aria-hidden="true">
                  {initialsOf(account.name)}
                </span>
                <strong className="name">{account.name}</strong>
                {account.email && account.email !== account.name && (
                  <span className="meta">{account.email}</span>
                )}
                <span className="spacer" />
                {confirmLogout ? (
                  <span className="integration-confirm" role="group" aria-label="Confirm sign out">
                    <span className="muted-text">
                      Sign out of Microsoft Teams on this computer?
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={disabled}
                      onClick={signOut}
                    >
                      Sign out
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={() => setConfirmLogout(false)}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    disabled={disabled}
                    onClick={() => setConfirmLogout(true)}
                    aria-label={`Sign out ${account.name}`}
                  >
                    Sign out
                  </button>
                )}
              </div>
              {!status?.channelHistory && (
                <div className="integration-notice" role="status">
                  <Info size={16} aria-hidden="true" />
                  <span>{CHANNELS_NOTE}</span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    disabled={disabled}
                    onClick={() => signIn(true)}
                    title="Asks for channel messages again, once an administrator has approved them"
                  >
                    {busy === "channels" ? "Waiting for browser…" : "Try again"}
                  </button>
                </div>
              )}
            </>
          )}

          <div className="integration-actions">
            {state !== "signed_in" && (
              <button
                type="button"
                className="btn btn-primary btn-small"
                disabled={disabled || state === "not_configured"}
                onClick={() => signIn()}
                title="Opens Microsoft sign-in in your browser"
              >
                {busy === "connect" ? "Waiting for browser…" : "Connect Microsoft Teams"}
              </button>
            )}
            {state === "signed_in" && (
              <button
                type="button"
                className="btn btn-secondary btn-small"
                disabled={disabled}
                onClick={verify}
              >
                <CheckCircle size={13} />
                <span>{busy === "verify" ? "Testing…" : "Test connection"}</span>
              </button>
            )}
          </div>

          {(busy === "connect" || busy === "channels") && (
            <p className="integration-note" role="status">
              Finish signing in in your browser.
            </p>
          )}
        </div>
      )}

      <div className="integration-feedback" aria-live="polite" role="status">
        {notice && <p className="integration-ok">{notice}</p>}
      </div>
      {shownError && (
        <div className="integration-feedback" role="alert">
          <div className="integration-alert">
            <span>{shownError.message}</span>
            {shownError.hint && <code>{shownError.hint}</code>}
          </div>
        </div>
      )}
    </section>
  );
};
