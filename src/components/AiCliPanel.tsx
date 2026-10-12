import { FC, useCallback, useEffect, useState } from "react";
import { X, Plus, RefreshCw, Terminal } from "lucide-react";
import {
  getAiCliDetails,
  checkCustomAiCliPath,
  registerUserCustomAiCli,
  AiCliDetails,
} from "../services/aiCliService";

interface AiCliPanelProps {
  isOpen: boolean;
  onClose: () => void;
  projectDir: string;
  onLaunchInTerminal?: (projectDir: string) => void;
}

/**
 * Read-only provider overview. Everything on screen is auto-detected locally:
 * binary presence (PATH plus well-known install locations such as
 * `~/.local/bin` and `~/.opencode/bin`), a bounded `--version` probe, local
 * config presence, and whether the provider's own config already contains a
 * kai entry. Nothing here writes files or stores credentials.
 */
export const AiCliPanel: FC<AiCliPanelProps> = ({
  isOpen,
  onClose,
  projectDir,
  onLaunchInTerminal,
}) => {
  const [details, setDetails] = useState<AiCliDetails[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [customPaths, setCustomPaths] = useState<Record<string, string>>({});
  const [customError, setCustomError] = useState<string | null>(null);

  // New user-defined CLI form inputs
  const [newCliName, setNewCliName] = useState("");
  const [newCliPath, setNewCliPath] = useState("");

  const refresh = useCallback(() => {
    setIsRefreshing(true);
    getAiCliDetails()
      .then(setDetails)
      .catch(() => setDetails([]))
      .finally(() => setIsRefreshing(false));
  }, []);

  useEffect(() => {
    if (isOpen) refresh();
  }, [isOpen, refresh]);

  if (!isOpen) return null;

  const handleCheckCustom = async (id: string) => {
    setCustomError(null);
    try {
      const checked = await checkCustomAiCliPath(id, customPaths[id] || "");
      setDetails((prev) => prev.map((d) => (d.id === id ? checked : d)));
    } catch (e) {
      setCustomError(e instanceof Error ? e.message : String(e));
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
          <h3>AI CLI Providers (optional)</h3>
          <button
            className="btn-close"
            onClick={onClose}
            title="Close"
            aria-label="Close AI CLI panel"
          >
            <X size={18} />
          </button>
        </div>
        <div className="modal-body" style={{ maxHeight: "70vh", overflowY: "auto" }}>
          <p className="muted-text">
            The terminal works with or without these tools. Everything below is detected
            automatically on this machine (binary on PATH or in well-known install locations,
            version probe, local config presence, kai wiring) and never stores credentials. Scoped
            to this split&apos;s directory: <code>{projectDir || "the active directory"}</code>.
            Launching runs the CLI as an ordinary terminal process in that same directory.
          </p>
          <div className="setting-row" style={{ marginTop: "8px" }}>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={refresh}
              disabled={isRefreshing}
              title="Re-run local detection"
            >
              <RefreshCw size={13} />
              <span>{isRefreshing ? "Detecting…" : "Re-detect providers"}</span>
            </button>
          </div>

          <div className="ai-provider-list">
            {details.map((d) => (
              <div key={d.id} className={`ai-provider-card${d.available ? " is-available" : ""}`}>
                <div className="ai-provider-head">
                  <span className="ai-provider-name">{d.name}</span>
                  <span
                    className={`ai-provider-badge${d.available ? " found" : ""}`}
                    title={d.available ? "Binary detected on this system" : "Binary not found"}
                  >
                    {d.available ? `Found${d.version ? ` · ${d.version}` : ""}` : "Not found"}
                  </span>
                </div>
                {d.path && <code className="ai-provider-path">{d.path}</code>}
                <div className="ai-provider-meta">
                  <span>
                    Auth:{" "}
                    <strong>{d.auth_status ? d.auth_status.replace(/_/g, " ") : "unknown"}</strong>
                  </span>
                  <span>
                    Kai wiring: <strong>{d.kai_wired ? "Configured ✓" : "Not configured"}</strong>
                  </span>
                </div>
                <p className="muted-text">{d.diagnostic}</p>
                {!d.available && <p className="muted-text">{d.install_guidance}</p>}
                <div className="ai-provider-actions">
                  {d.available && d.path && onLaunchInTerminal && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={() => onLaunchInTerminal(projectDir)}
                      title={`Launch ${d.name} in a new terminal tab`}
                    >
                      <Terminal size={13} />
                      <span>Open in new tab</span>
                    </button>
                  )}
                  {!d.id.startsWith("custom:") && (
                    <>
                      <input
                        type="text"
                        className="text-input modal-input"
                        placeholder={`Custom path to ${d.id} binary…`}
                        value={customPaths[d.id] || ""}
                        onChange={(e) => setCustomPaths({ ...customPaths, [d.id]: e.target.value })}
                        aria-label={`Custom path for ${d.name}`}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        onClick={() => void handleCheckCustom(d.id)}
                      >
                        Validate
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div
            className="setting-field"
            style={{ borderTop: "1px solid #313244", paddingTop: "12px", marginTop: "12px" }}
          >
            <label>Register User-Defined AI Executable</label>
            <div className="setting-row">
              <input
                type="text"
                className="text-input modal-input"
                placeholder="Name (e.g. Ollama, LocalLLM)"
                value={newCliName}
                onChange={(e) => setNewCliName(e.target.value)}
              />
              <input
                type="text"
                className="text-input modal-input"
                placeholder="Executable Path (e.g. /usr/local/bin/ollama)"
                value={newCliPath}
                onChange={(e) => setNewCliPath(e.target.value)}
              />
              <button className="btn btn-primary" onClick={handleRegisterNewCli}>
                <Plus size={14} />
                <span>Register</span>
              </button>
            </div>
          </div>

          {customError && (
            <p className="error-text" role="alert">
              {customError}
            </p>
          )}
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
