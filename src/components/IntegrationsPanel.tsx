import { FC, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle, Plug, RefreshCw } from "lucide-react";
import {
  PROVIDER_CATALOG,
  type IntegrationAuthMethod,
  type ProviderInfo,
} from "../core/integrations/providerCatalog";
import type {
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
  loginIntegration,
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
  initialAuthMethod,
  isSameSelection,
  needsRelogin,
  normalizeOrgInput,
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
    style={{
      maxHeight: "70vh",
      overflowY: "auto",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
    }}
  >
    <p className="muted-text" style={{ margin: 0 }}>
      Connect a service once, then choose it for each project. Agents reach it through Kai&apos;s
      MCP server; nothing is contacted until a project is bound. Scoped to{" "}
      <code>{projectDir || "no project folder"}</code>.
    </p>
    <div
      className="ai-provider-list"
      style={{ display: "flex", flexDirection: "column", gap: "10px" }}
    >
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

  const [showForm, setShowForm] = useState(false);
  const [org, setOrg] = useState("");
  const [authMethod, setAuthMethod] = useState<IntegrationAuthMethod>("az");
  const [pat, setPat] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
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
    void refresh().then((next) => {
      if (!mounted.current) return;
      if (next) {
        setAuthMethod(initialAuthMethod(next));
        setOrg((current) => current || next.project.detected?.org || "");
        setShowForm(next.accounts.length === 0);
      }
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

  const handleConnect = (e: FormEvent) => {
    e.preventDefault();
    const orgName = normalizeOrgInput(org);
    if (!orgName) {
      setError({ code: "bad_request", message: "Enter your Azure DevOps organization." });
      return;
    }
    if (authMethod === "pat" && !pat.trim()) {
      setError({ code: "bad_request", message: "Paste an access token, or choose Azure CLI." });
      return;
    }
    // The token leaves component state the moment it is submitted.
    const token = authMethod === "pat" ? pat.trim() : undefined;
    setPat("");
    void run("connect", async () => {
      const res = await loginIntegration({
        org: orgName,
        authMethod,
        ...(token ? { pat: token } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const who = res.value.user.email ?? res.value.user.name;
      await refresh();
      if (!mounted.current) return;
      setAccountChoice(res.value.account.id);
      setShowForm(false);
      setNotice(`Connected to ${res.value.account.org} as ${who}.`);
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

  /** Opens the picker. The project list is a network call, so it is only fetched here. */
  const openSwitch = async () => {
    if (!binding) return;
    const seq = ++switchSeq.current;
    setNotice(null);
    setError(null);
    setBusy("projects");
    setSwitching({
      account: binding.account,
      projects: null,
      project: binding.project,
      repos: null,
      repo: binding.repo,
    });
    const res = await listProjects(binding.account);
    if (!mounted.current || seq !== switchSeq.current) return;
    if (!res.ok) {
      // The binding is untouched; show why the list is unavailable.
      setError(res.error);
      setSwitching(null);
      setBusy(null);
      return;
    }
    const project = pickSwitchProject(res.value, binding.project);
    setSwitching((prev) => (prev ? { ...prev, projects: res.value, project } : prev));
    await loadRepos(binding.account, project, binding.repo);
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
        setNotice(
          `Switched to ${res.value.project}${res.value.repo ? ` / ${res.value.repo}` : ""}.`
        );
      }
    });
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
      const next = await refresh();
      if (!mounted.current) return;
      setAccountChoice(null);
      if (next && next.accounts.length === 0) setShowForm(true);
      setNotice("Signed out.");
    });
  };

  const shownError = error ? formatError(error) : null;

  return (
    <div
      className={`ai-provider-card integration-card${state === "active" ? " is-available" : ""}`}
      style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "12px" }}
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
                onClick={() => void openSwitch()}
              >
                Switch project
              </button>
            )}
          </div>

          {switching && (
            <div className="integration-switch" role="group" aria-label="Switch project">
              {switching.projects === null ? (
                <span className="muted-text" role="status">
                  Loading projects�
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
                        Loading repositories�
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
                        isSameSelection(binding, switching.project, switching.repo))
                    }
                    onClick={applySwitch}
                  >
                    {busy === "bind" ? "Applying�" : "Apply"}
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
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={disabled}
                      onClick={() => setConfirmLogout(account.id)}
                      aria-label={`Sign out ${account.org}`}
                    >
                      Sign out
                    </button>
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
                disabled={disabled || !detected || !selectedAccount}
                title={
                  detected
                    ? undefined
                    : "This folder has no Azure DevOps git remote to configure from"
                }
                onClick={() => handleBind(false)}
              >
                Use for this project
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
            {!showForm && (
              <button
                type="button"
                className="btn btn-secondary btn-small"
                disabled={disabled}
                onClick={() => setShowForm(true)}
              >
                {accounts.length > 0 ? "Connect another account" : "Connect"}
              </button>
            )}
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

          {showForm && (
            <form
              className="integration-form"
              onSubmit={handleConnect}
              aria-label="Connect account"
            >
              <div className="setting-field">
                <label htmlFor={`${provider.id}-org`}>Organization</label>
                <input
                  id={`${provider.id}-org`}
                  type="text"
                  className="text-input modal-input"
                  placeholder="contoso  (from dev.azure.com/contoso)"
                  value={org}
                  disabled={disabled}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setOrg(e.target.value)}
                />
              </div>
              <fieldset className="integration-methods" disabled={disabled}>
                <legend>Sign in with</legend>
                <label>
                  <input
                    type="radio"
                    name={`${provider.id}-auth`}
                    checked={authMethod === "az"}
                    onChange={() => setAuthMethod("az")}
                  />
                  <span>Azure CLI</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name={`${provider.id}-auth`}
                    checked={authMethod === "pat"}
                    onChange={() => setAuthMethod("pat")}
                  />
                  <span>Access token (PAT)</span>
                </label>
              </fieldset>
              {authMethod === "az" ? (
                <p className="muted-text" style={{ margin: 0, fontSize: "12px" }}>
                  Run <code>az login</code> in a terminal tab first. Kai stores nothing: it asks the
                  Azure CLI for a short-lived token when it needs one.
                  {status.azCli === false && (
                    <span className="integration-warn"> The Azure CLI was not found on PATH.</span>
                  )}
                </p>
              ) : (
                <div className="setting-field">
                  <label htmlFor={`${provider.id}-pat`}>Access token</label>
                  <input
                    id={`${provider.id}-pat`}
                    type="password"
                    className="text-input modal-input"
                    placeholder="Paste a token with read access"
                    value={pat}
                    disabled={disabled}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setPat(e.target.value)}
                  />
                  <span className="muted-text" style={{ fontSize: "12px" }}>
                    Write-only. Stored in your OS secret store, never shown again.
                  </span>
                </div>
              )}
              <details className="integration-server">
                <summary>Azure DevOps Server (on-premises)</summary>
                <div className="setting-field">
                  <label htmlFor={`${provider.id}-url`}>Server URL</label>
                  <input
                    id={`${provider.id}-url`}
                    type="text"
                    className="text-input modal-input"
                    placeholder="https://tfs.example.com/tfs/DefaultCollection"
                    value={baseUrl}
                    disabled={disabled}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </div>
              </details>
              <div className="ai-provider-actions">
                <button type="submit" className="btn btn-primary btn-small" disabled={disabled}>
                  {busy === "connect" ? "Connecting…" : "Connect"}
                </button>
                {accounts.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    disabled={disabled}
                    onClick={() => {
                      setShowForm(false);
                      setPat("");
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
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
