import { FC, useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle, Plug, RefreshCw } from "lucide-react";
import { PROVIDER_CATALOG, type ProviderInfo } from "../core/integrations/providerCatalog";
import type {
  IntegrationAccountView,
  IntegrationErrorBody,
  IntegrationProjectView,
  IntegrationRepoView,
  IntegrationStatusView,
} from "../core/integrations/rpcTypes";
import {
  bindIntegration,
  getIntegrationStatus,
  listProjects,
  listRepos,
  loginWithBrowser,
  logoutIntegration,
  unbindIntegration,
  verifyIntegration,
} from "../services/integrationService";
import {
  badgeFor,
  deriveCardState,
  describeAccount,
  describeDetected,
  formatError,
  isSameSelection,
  needsRelogin,
  pickRepoForProject,
  pickSwitchProject,
  preferredAccountId,
  providerLabel,
} from "./integrationsViewModel";

interface IntegrationsPanelProps {
  projectDir: string;
}

/**
 * The "Integrations" tab of the AI CLI panel. Everything here is a thin view
 * over `kai azure rpc`: accounts are global to the user, the binding is per
 * project, and a project has at most one active integration.
 */
export const IntegrationsPanel: FC<IntegrationsPanelProps> = ({ projectDir }) => (
  <div
    className="modal-body"
    role="tabpanel"
    aria-labelledby="ai-cli-tab-integrations"
    style={{ gap: "12px" }}
  >
    <p className="muted-text" style={{ margin: 0 }}>
      Connect a service once, then choose it for each project. Agents reach it through Kai&apos;s
      MCP server; nothing is contacted until a project is bound. Scoped to{" "}
      <code>{projectDir || "no project folder"}</code>.
    </p>
    <div className="ai-provider-list">
      {PROVIDER_CATALOG.map((provider) => (
        <ProviderCard key={provider.id} provider={provider} projectDir={projectDir} />
      ))}
    </div>
  </div>
);

type Busy =
  "load" | "connect" | "bind" | "verify" | "unbind" | "logout" | "projects" | "repos" | null;

/** The open "Switch project" picker. `null` lists mean "still loading". */
interface SwitchState {
  account: string;
  projects: IntegrationProjectView[] | null;
  project: string;
  repos: IntegrationRepoView[] | null;
  repo: string | null;
}

interface ProviderCardProps {
  provider: ProviderInfo;
  projectDir: string;
}

const ProviderCard: FC<ProviderCardProps> = ({ provider, projectDir }) => {
  const [status, setStatus] = useState<IntegrationStatusView | null>(null);
  const [busy, setBusy] = useState<Busy>("load");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<IntegrationErrorBody | null>(null);

  const [accountChoice, setAccountChoice] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState<string | null>(null);
  const [switching, setSwitching] = useState<SwitchState | null>(null);

  // Responses from a request that was superseded (or the panel closed) are dropped.
  const requestSeq = useRef(0);
  const switchSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<IntegrationStatusView | null> => {
    const seq = ++requestSeq.current;
    const res = await getIntegrationStatus(projectDir);
    if (!mounted.current || seq !== requestSeq.current) return null;
    if (!res.ok) {
      setError(res.error);
      return null;
    }
    setStatus(res.value);
    return res.value;
  }, [projectDir]);

  useEffect(() => {
    switchSeq.current++;
    setSwitching(null);
    setBusy("load");
    setNotice(null);
    setError(null);
    void refresh().then(() => {
      if (!mounted.current) return;
      setBusy(null);
    });
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

  const state = deriveCardState(status);
  const badge = badgeFor(state);
  const detected = status?.project.detected ?? null;
  const detectedText = describeDetected(detected);
  const accounts = status?.accounts ?? [];
  const binding = status?.project.binding ?? null;
  const otherProvider = status?.project.otherProvider ?? null;
  const selectedAccount = accountChoice ?? preferredAccountId(status);
  const disabled = busy !== null;

  const handleConnect = () => {
    let chooseProjectFor: string | null = null;
    void run("connect", async () => {
      const res = await loginWithBrowser();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const who = res.value.user.email ?? res.value.user.name;
      const signedIn = res.value.accounts;
      // The folder's own organization, else the only one: nothing to choose.
      const account =
        (detected
          ? signedIn.find((a) => a.org.toLowerCase() === detected.org.toLowerCase())
          : undefined) ?? (signedIn.length === 1 ? signedIn[0] : null);
      if (!account) {
        setAccountChoice(signedIn[0]?.id ?? null);
        await refresh();
        if (mounted.current) {
          setNotice(
            `Signed in as ${who}. ${signedIn.length} organizations found: choose one for this project below.`
          );
        }
        return;
      }
      setAccountChoice(account.id);
      // Signing in for the folder's own organization is the whole job: make it
      // active right away instead of leaving a second "Use for this project" click.
      const ownRemote = detected && detected.org.toLowerCase() === account.org.toLowerCase();
      if (!binding && ownRemote) {
        const bound = await bindIntegration({ projectDir, account: account.id });
        if (!mounted.current) return;
        if (bound.ok) {
          await refresh();
          if (mounted.current) {
            setNotice(
              `Connected to ${account.org} as ${who}. Active for this project (${bound.value.project}${
                bound.value.repo ? ` / ${bound.value.repo}` : ""
              }).`
            );
          }
          return;
        }
        // Signed in, but something (another integration, a name mismatch) needs a decision.
        await refresh();
        if (!mounted.current) return;
        if (bound.error.code === "needs_confirmation") setConfirmReplace(true);
        else setError(bound.error);
        setNotice(`Connected to ${account.org} as ${who}.`);
        return;
      }
      await refresh();
      if (!mounted.current) return;
      setNotice(`Connected to ${account.org} as ${who}.`);
      // No usable remote for this account: let the user pick the project instead.
      if (!binding) chooseProjectFor = account.id;
    }).then(() => {
      if (chooseProjectFor && mounted.current) void openPicker(chooseProjectFor, null);
    });
  };

  const handleBind = (replace: boolean) => {
    void run("bind", async () => {
      const res = await bindIntegration({
        projectDir,
        ...(selectedAccount ? { account: selectedAccount } : {}),
        ...(replace ? { replace: true } : {}),
      });
      if (!res.ok) {
        if (res.error.code === "needs_confirmation") {
          setConfirmReplace(true);
          return;
        }
        setError(res.error);
        return;
      }
      setConfirmReplace(false);
      await refresh();
      if (mounted.current) {
        setNotice(
          `${provider.label} is now active for this project (${res.value.project}${
            res.value.repo ? ` / ${res.value.repo}` : ""
          }).`
        );
      }
    });
  };

  /** Closes the picker and drops any project/repo list still on its way. */
  const closeSwitch = () => {
    switchSeq.current++;
    setSwitching(null);
    setBusy((current) => (current === "projects" || current === "repos" ? null : current));
  };

  /** Loads the repositories of one project; superseded or closed requests are dropped. */
  const loadRepos = async (account: string, project: string, currentRepo: string | null) => {
    const seq = ++switchSeq.current;
    setBusy("repos");
    setSwitching((prev) => (prev ? { ...prev, project, repos: null, repo: null } : prev));
    const res = await listRepos(account, project);
    if (!mounted.current || seq !== switchSeq.current) return;
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      setSwitching((prev) => (prev ? { ...prev, repos: [], repo: null } : prev));
      return;
    }
    setSwitching((prev) =>
      prev ? { ...prev, repos: res.value, repo: pickRepoForProject(res.value, currentRepo) } : prev
    );
  };

  /**
   * Opens the project picker for `account`. `current` is the active project
   * (a switch) or null (first activation). The project list is a network call,
   * so it is only fetched here, never on tab open.
   */
  const openPicker = async (
    account: string,
    current: { project: string; repo: string | null } | null
  ) => {
    const seq = ++switchSeq.current;
    setNotice(null);
    setError(null);
    setBusy("projects");
    setSwitching({
      account,
      projects: null,
      project: current?.project ?? "",
      repos: null,
      repo: current?.repo ?? null,
    });
    const res = await listProjects(account);
    if (!mounted.current || seq !== switchSeq.current) return;
    if (!res.ok) {
      // Nothing is bound or changed; show why the list is unavailable.
      setError(res.error);
      setSwitching(null);
      setBusy(null);
      return;
    }
    if (res.value.length === 0) {
      setError({
        code: "not_found",
        message: "This account has no projects Kai can read.",
        hint: "Check the token's access, or pick another organization.",
      });
      setSwitching(null);
      setBusy(null);
      return;
    }
    const project = pickSwitchProject(res.value, current?.project ?? "");
    setSwitching((prev) => (prev ? { ...prev, projects: res.value, project } : prev));
    await loadRepos(account, project, current?.repo ?? null);
  };

  const applySwitch = () => {
    if (!switching || !switching.projects || !switching.repos) return;
    const { account, project, repo } = switching;
    void run("bind", async () => {
      const res = await bindIntegration({ projectDir, account, project, repo });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      closeSwitch();
      await refresh();
      if (mounted.current) {
        const picked = `${res.value.project}${res.value.repo ? ` / ${res.value.repo}` : ""}`;
        setNotice(binding ? `Switched to ${picked}.` : `Active for this project (${picked}).`);
      }
    });
  };

  /**
   * Makes a signed-in account the one active for this folder (a folder has one
   * at a time). When the git remote belongs to that organization the remote's
   * project is used; otherwise the user picks the project.
   */
  const activateAccount = (target: IntegrationAccountView) => {
    closeSwitch();
    if (detected && detected.org.toLowerCase() === target.org.toLowerCase()) {
      void run("bind", async () => {
        const res = await bindIntegration({ projectDir, account: target.id });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setAccountChoice(target.id);
        await refresh();
        if (mounted.current) {
          setNotice(
            `${target.org} is now active for this project (${res.value.project}${
              res.value.repo ? ` / ${res.value.repo}` : ""
            }).`
          );
        }
      });
      return;
    }
    setAccountChoice(target.id);
    void openPicker(target.id, null);
  };

  const handleVerify = () => {
    const account = binding?.account ?? selectedAccount;
    if (!account) return;
    void run("verify", async () => {
      const res = await verifyIntegration(account);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNotice(`Signed in as ${res.value.email ?? res.value.name}.`);
    });
  };

  const handleUnbind = () => {
    closeSwitch();
    void run("unbind", async () => {
      const res = await unbindIntegration(projectDir);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await refresh();
      if (mounted.current) setNotice(`${provider.label} removed from this project.`);
    });
  };

  const handleLogout = (accountId: string) => {
    setConfirmLogout(null);
    closeSwitch();
    void run("logout", async () => {
      const res = await logoutIntegration(accountId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await refresh();
      if (!mounted.current) return;
      setAccountChoice(null);
      setNotice("Signed out.");
    });
  };

  const shownError = error ? formatError(error) : null;

  return (
    <div
      className={`ai-provider-card integration-card${state === "active" ? " is-available" : ""}`}
      aria-label={provider.label}
    >
      <div className="ai-provider-head">
        <span className="ai-provider-name" style={{ fontWeight: 600 }}>
          <Plug size={14} style={{ marginRight: "6px", verticalAlign: "-2px" }} />
          {provider.label}
        </span>
        <span
          className={`ai-provider-badge${badge.tone === "ok" ? " found" : ""}${
            badge.tone === "warn" ? " integration-badge-warn" : ""
          }`}
          data-state={state}
        >
          {busy === "load" ? "Checking…" : badge.label}
        </span>
      </div>
      <p className="muted-text" style={{ margin: 0, fontSize: "12px" }}>
        {provider.description}
      </p>

      {status && (
        <>
          <div className="ai-provider-meta integration-meta">
            <span>
              This project:{" "}
              {state === "active" && binding ? (
                <strong>
                  {binding.project}
                  {binding.repo ? ` / ${binding.repo}` : ""}
                </strong>
              ) : detectedText ? (
                <strong>{detectedText}</strong>
              ) : (
                <span className="muted-text">No Azure DevOps remote found in this folder</span>
              )}
            </span>
            {state !== "active" && detectedText && (
              <span className="muted-text">(from git remote)</span>
            )}
            {state === "active" && binding && !switching && (
              <button
                type="button"
                className="btn btn-secondary btn-small"
                disabled={disabled}
                onClick={() => binding && void openPicker(binding.account, binding)}
              >
                Switch project
              </button>
            )}
          </div>

          {switching && (
            <div className="integration-switch" role="group" aria-label="Switch project">
              <span className="muted-text integration-detected">
                Account:{" "}
                <strong>
                  {accounts.find((a) => a.id === switching.account)?.org ?? switching.account}
                </strong>
              </span>
              {switching.projects === null ? (
                <span className="muted-text" role="status">
                  Loading projects…
                </span>
              ) : (
                <>
                  <div className="setting-field">
                    <label htmlFor={`${provider.id}-switch-project`}>Project</label>
                    <select
                      id={`${provider.id}-switch-project`}
                      className="text-input modal-input select-input"
                      value={switching.project}
                      disabled={disabled}
                      onChange={(e) =>
                        void loadRepos(switching.account, e.target.value, binding?.repo ?? null)
                      }
                    >
                      {switching.projects.map((p) => (
                        <option key={p.name} value={p.name} title={p.description}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="setting-field">
                    <label htmlFor={`${provider.id}-switch-repo`}>Repository</label>
                    {switching.repos === null ? (
                      <span className="muted-text" role="status">
                        Loading repositories…
                      </span>
                    ) : (
                      <select
                        id={`${provider.id}-switch-repo`}
                        className="text-input modal-input select-input"
                        value={switching.repo ?? ""}
                        disabled={disabled}
                        onChange={(e) =>
                          setSwitching((prev) =>
                            prev ? { ...prev, repo: e.target.value || null } : prev
                          )
                        }
                      >
                        <option value="">(none)</option>
                        {switching.repos.map((r) => (
                          <option key={r.name} value={r.name}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </>
              )}
              <div className="ai-provider-actions">
                {switching.projects !== null && (
                  <button
                    type="button"
                    className="btn btn-primary btn-small"
                    disabled={
                      disabled ||
                      switching.repos === null ||
                      (binding !== null &&
                        binding.account === switching.account &&
                        isSameSelection(binding, switching.project, switching.repo))
                    }
                    onClick={applySwitch}
                  >
                    {busy === "bind" ? "Applying…" : "Apply"}
                  </button>
                )}
                <button type="button" className="btn btn-secondary btn-small" onClick={closeSwitch}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {state === "signed_out" && (
            <p className="integration-warn" style={{ margin: 0, fontSize: "12px" }}>
              This project is bound to an account that needs to sign in again. Connect it below.
            </p>
          )}

          {accounts.length > 0 && (
            <ul className="integration-accounts" aria-label="Accounts">
              {accounts.map((account) => (
                <li key={account.id}>
                  <span>
                    {describeAccount(account)}
                    {needsRelogin(account) && (
                      <span className="integration-warn"> · token missing, connect again</span>
                    )}
                    {account.usedByThisProject && (
                      <span className="muted-text"> · this project</span>
                    )}
                  </span>
                  {confirmLogout === account.id ? (
                    <span
                      className="integration-confirm"
                      role="group"
                      aria-label="Confirm sign out"
                    >
                      <span className="muted-text">
                        Other projects using this account will need to sign in again.
                      </span>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={disabled}
                        onClick={() => handleLogout(account.id)}
                      >
                        Sign out
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        onClick={() => setConfirmLogout(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="integration-row-actions">
                      {!account.usedByThisProject && !needsRelogin(account) && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          disabled={disabled}
                          onClick={() => activateAccount(account)}
                          aria-label={`Make ${account.org} active for this project`}
                        >
                          Make active
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={disabled}
                        onClick={() => setConfirmLogout(account.id)}
                        aria-label={`Sign out ${account.org}`}
                      >
                        Sign out
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="ai-provider-actions">
            {state !== "active" && accounts.length > 1 && (
              <select
                className="text-input modal-input select-input"
                aria-label="Account for this project"
                value={selectedAccount ?? ""}
                disabled={disabled}
                onChange={(e) => setAccountChoice(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.org}
                  </option>
                ))}
              </select>
            )}
            {state !== "active" && accounts.length > 0 && (
              <button
                type="button"
                className="btn btn-primary btn-small"
                disabled={disabled || !selectedAccount}
                onClick={() =>
                  detected && selectedAccount
                    ? handleBind(false)
                    : selectedAccount && void openPicker(selectedAccount, null)
                }
                title={
                  detected
                    ? undefined
                    : "This folder has no Azure DevOps git remote, so you pick the project"
                }
              >
                {detected ? "Use for this project" : "Choose project"}
              </button>
            )}
            {(state === "active" || accounts.length > 0) && (
              <button
                type="button"
                className="btn btn-secondary btn-small"
                disabled={disabled || !(binding?.account ?? selectedAccount)}
                onClick={handleVerify}
              >
                <CheckCircle size={13} />
                <span>{busy === "verify" ? "Testing…" : "Test connection"}</span>
              </button>
            )}
            {binding && (
              <button
                type="button"
                className="btn btn-secondary btn-small"
                disabled={disabled}
                onClick={handleUnbind}
              >
                Remove from this project
              </button>
            )}
            <button
              type="button"
              className={`btn ${accounts.length > 0 ? "btn-secondary" : "btn-primary"} btn-small`}
              disabled={disabled}
              onClick={handleConnect}
              title="Opens Azure DevOps sign-in in your browser"
            >
              {busy === "connect"
                ? "Waiting for browser…"
                : accounts.length > 0
                  ? "Sign in with another account"
                  : `Connect ${provider.label}`}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              disabled={disabled}
              onClick={() => {
                setBusy("load");
                void refresh().then(() => {
                  if (mounted.current) setBusy(null);
                });
              }}
              title="Re-read status"
              aria-label={`Refresh ${provider.label} status`}
            >
              <RefreshCw size={13} className={busy === "load" ? "spin" : ""} />
            </button>
          </div>

          {confirmReplace && (
            <div className="integration-confirm" role="group" aria-label="Confirm replace">
              <span>
                Replace {providerLabel(otherProvider)} in this project? Only one integration can be
                active at a time.
              </span>
              <button
                type="button"
                className="btn btn-primary btn-small"
                disabled={disabled}
                onClick={() => handleBind(true)}
              >
                Replace
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => setConfirmReplace(false)}
              >
                Cancel
              </button>
            </div>
          )}

          {busy === "connect" ? (
            <p className="muted-text" style={{ margin: 0, fontSize: "12px" }} role="status">
              Finish signing in in your browser. Kai continues on its own once you are done, and
              finds your organizations for you.
            </p>
          ) : (
            accounts.length === 0 && (
              <p className="muted-text" style={{ margin: 0, fontSize: "12px" }}>
                Kai opens your browser to sign in to {provider.label} with your Microsoft account.
                There is no organization or token to type.
              </p>
            )
          )}
        </>
      )}

      <div aria-live="polite" role="status">
        {notice && <p className="integration-ok">{notice}</p>}
      </div>
      {shownError && (
        <div role="alert" className="error-text integration-error">
          <span>{shownError.message}</span>
          {shownError.hint && <code>{shownError.hint}</code>}
        </div>
      )}
    </div>
  );
};
