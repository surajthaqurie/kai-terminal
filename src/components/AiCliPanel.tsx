import { FC, useCallback, useEffect, useState } from "react";
import { X, Plus, RefreshCw, Wrench, CheckCircle } from "lucide-react";
import {
  getAiCliDetails,
  checkCustomAiCliPath,
  registerUserCustomAiCli,
  getKaiCliLaunch,
  setupAgentMcp,
  AiCliDetails,
} from "../services/aiCliService";

interface AiCliPanelProps {
  isOpen: boolean;
  onClose: () => void;
  projectDir: string;
  onLaunchInTerminal?: (projectDir: string) => void;
}

/**
 * AI Provider overview & configuration.
 * Local detection of installed AI CLI binaries, versions, auth status,
 * and kai MCP configuration with one-click Configure / Reconfigure.
 */
export const AiCliPanel: FC<AiCliPanelProps> = ({ isOpen, onClose, projectDir }) => {
  const [details, setDetails] = useState<AiCliDetails[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [customPaths, setCustomPaths] = useState<Record<string, string>>({});
  const [customError, setCustomError] = useState<string | null>(null);
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // New user-defined CLI form inputs
  const [newCliName, setNewCliName] = useState("");
  const [newCliPath, setNewCliPath] = useState("");

  const refresh = useCallback((force = false) => {
    setIsRefreshing(true);
    getAiCliDetails(force ? { force: true } : undefined)
      .then(setDetails)
      .catch(() => setDetails([]))
      .finally(() => setIsRefreshing(false));
  }, []);

  useEffect(() => {
    if (isOpen) refresh(false);
  }, [isOpen, refresh]);

  if (!isOpen) return null;

  const handleCheckCustom = async (id: string) => {
    const p = customPaths[id]?.trim();
    if (!p) return;
    setCustomError(null);
    try {
      const checked = await checkCustomAiCliPath(id, p);
      setDetails((prev) => prev.map((d) => (d.id === id ? checked : d)));
    } catch (e) {
      setCustomError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleConfigureMcp = async (cli: AiCliDetails) => {
    setConfiguringId(cli.id);
    setCustomError(null);
    setSuccessMessage(null);
    try {
      const launcher = await getKaiCliLaunch();
      const res = await setupAgentMcp(cli.id, launcher, projectDir || ".", Boolean(cli.kai_wired));
      setSuccessMessage(res.message || `Configured ${cli.name} with Kai MCP!`);
      refresh(true);
    } catch (e) {
      setCustomError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfiguringId(null);
    }
  };

  const handleRegisterNewCli = async () => {
    if (!newCliName.trim() || !newCliPath.trim()) {
      setCustomError("Name and executable path are required for custom AI CLI.");
      return;
    }
    setCustomError(null);
    try {
      const id = newCliName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      const registered = await registerUserCustomAiCli({
        id,
        name: newCliName.trim(),
        path: newCliPath.trim(),
      });
      setDetails((prev) => [...prev.filter((d) => d.id !== registered.id), registered]);
      setNewCliName("");
      setNewCliPath("");
    } catch (e) {
      setCustomError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-label="AI CLI providers">
      <div className="settings-modal" onClick={(e) => e.stopPropagation()} role="document">
        <div className="modal-header">
          <h3>AI CLI Providers</h3>
          <button
            className="btn-close"
            onClick={onClose}
            title="Close"
            aria-label="Close AI CLI panel"
          >
            <X size={18} />
          </button>
        </div>
        <div
          className="modal-body"
          style={{
            maxHeight: "70vh",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <p className="muted-text" style={{ margin: 0 }}>
            The terminal works with or without these tools. Everything below is detected
            automatically on this machine (binary on PATH or in well-known install locations,
            bounded version probe, local config-file presence, kai wiring). All checks are passive,
            local, and non-billable — a version response never means signed-in, and a config file
            never proves credentials are valid. Scoped to this split&apos;s directory:{" "}
            <code>{projectDir || "the active directory"}</code>.
          </p>

          <div>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => refresh(true)}
              disabled={isRefreshing}
              title="Re-run local detection"
            >
              <RefreshCw size={13} className={isRefreshing ? "spin" : ""} />
              <span>{isRefreshing ? "Detecting…" : "Re-detect providers"}</span>
            </button>
          </div>

          {successMessage && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 12px",
                borderRadius: "var(--radius-sm)",
                background: "var(--color-success-bg)",
                color: "var(--color-success)",
                fontSize: "var(--text-sm)",
                border: "1px solid var(--border-default)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <CheckCircle size={14} />
                <span>{successMessage}</span>
              </div>
              <button
                type="button"
                className="btn-close"
                style={{
                  padding: 0,
                  color: "var(--color-success)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                }}
                onClick={() => setSuccessMessage(null)}
                aria-label="Dismiss success message"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {customError && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 12px",
                borderRadius: "var(--radius-sm)",
                background: "var(--color-danger-bg)",
                color: "var(--color-danger)",
                fontSize: "var(--text-sm)",
                border: "1px solid var(--border-default)",
              }}
              role="alert"
            >
              <span>{customError}</span>
              <button
                type="button"
                className="btn-close"
                style={{
                  padding: 0,
                  color: "var(--color-danger)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                }}
                onClick={() => setCustomError(null)}
                aria-label="Dismiss error message"
              >
                <X size={14} />
              </button>
            </div>
          )}

          <div
            className="ai-provider-list"
            style={{ display: "flex", flexDirection: "column", gap: "10px" }}
          >
            {details.map((d) => (
              <div
                key={d.id}
                className={`ai-provider-card${d.available ? " is-available" : ""}`}
                style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "12px" }}
              >
                <div
                  className="ai-provider-head"
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <span className="ai-provider-name" style={{ fontWeight: 600 }}>
                    {d.name}
                  </span>
                  <span
                    className={`ai-provider-badge${d.available ? " found" : ""}`}
                    title={d.available ? "Binary detected on this system" : "Binary not found"}
                  >
                    {d.available ? `Found${d.version ? ` · ${d.version}` : ""}` : "Not found"}
                  </span>
                </div>
                {d.path && <code className="ai-provider-path">{d.path}</code>}
                <div
                  className="ai-provider-meta"
                  style={{ display: "flex", gap: "16px", fontSize: "12px", alignItems: "center" }}
                >
                  <span title="Local config-file presence only — never credential validity">
                    Local config:{" "}
                    <strong>
                      {(d.auth_status === "config_present"
                        ? "file present"
                        : d.auth_status === "config_missing"
                          ? "no file"
                          : d.auth_status === "configured"
                            ? "file present"
                            : d.auth_status === "not_configured"
                              ? "no file"
                              : "unknown"
                      ).replace(/_/g, " ")}
                    </strong>
                  </span>
                  <span>
                    Kai wiring:{" "}
                    {d.kai_wired ? (
                      <span
                        style={{
                          color: "var(--color-success)",
                          fontWeight: 600,
                          backgroundColor: "var(--color-success-bg)",
                          padding: "2px 6px",
                          borderRadius: "var(--radius-xs)",
                          display: "inline-block",
                        }}
                      >
                        Configured ✓
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-secondary)" }}>Not configured</span>
                    )}
                  </span>
                </div>
                <p className="muted-text" style={{ margin: 0, fontSize: "12px" }}>
                  {d.diagnostic}
                </p>
                {!d.available && (
                  <p className="muted-text" style={{ margin: 0, fontSize: "12px" }}>
                    {d.install_guidance}
                  </p>
                )}

                <div
                  className="ai-provider-actions"
                  style={{
                    display: "flex",
                    gap: "8px",
                    alignItems: "center",
                    marginTop: "4px",
                    flexWrap: "wrap",
                  }}
                >
                  {/* Configure / Reconfigure button for available CLIs */}
                  {d.available && (
                    <button
                      type="button"
                      className={`btn ${d.kai_wired ? "btn-secondary" : "btn-primary"} btn-small`}
                      onClick={() => void handleConfigureMcp(d)}
                      disabled={configuringId === d.id}
                      title={
                        d.kai_wired
                          ? `Reconfigure ${d.name} with Kai MCP`
                          : `Configure ${d.name} with Kai MCP`
                      }
                    >
                      <Wrench size={13} />
                      <span>
                        {configuringId === d.id
                          ? "Configuring…"
                          : d.kai_wired
                            ? "Reconfigure"
                            : "Configure"}
                      </span>
                    </button>
                  )}

                  {/* Only show custom path input if the CLI is NOT already available/found */}
                  {!d.available && !d.id.startsWith("custom:") && (
                    <div
                      style={{ display: "flex", gap: "8px", alignItems: "center", width: "100%" }}
                    >
                      <input
                        type="text"
                        className="text-input modal-input"
                        placeholder={`Custom path to ${d.id} binary…`}
                        value={customPaths[d.id] || ""}
                        onChange={(e) => setCustomPaths({ ...customPaths, [d.id]: e.target.value })}
                        aria-label={`Custom path for ${d.name}`}
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        onClick={() => void handleCheckCustom(d.id)}
                        disabled={!customPaths[d.id]?.trim()}
                      >
                        Validate
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div
            className="setting-field"
            style={{
              borderTop: "1px solid var(--border-default)",
              paddingTop: "12px",
              marginTop: "8px",
            }}
          >
            <label style={{ display: "block", marginBottom: "8px" }}>
              Register User-Defined AI Executable
            </label>
            <div
              className="setting-row"
              style={{ display: "flex", gap: "8px", alignItems: "center" }}
            >
              <input
                type="text"
                className="text-input modal-input"
                placeholder="Name (e.g. Ollama, LocalLLM)"
                value={newCliName}
                onChange={(e) => setNewCliName(e.target.value)}
                style={{ flex: 1 }}
              />
              <input
                type="text"
                className="text-input modal-input"
                placeholder="Executable Path (e.g. /usr/local/bin/ollama)"
                value={newCliPath}
                onChange={(e) => setNewCliPath(e.target.value)}
                style={{ flex: 1.5 }}
              />
              <button
                className="btn btn-primary"
                onClick={handleRegisterNewCli}
                disabled={!newCliName.trim() || !newCliPath.trim()}
              >
                <Plus size={14} />
                <span>Register</span>
              </button>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
