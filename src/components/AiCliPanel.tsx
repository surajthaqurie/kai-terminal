import { FC, useEffect, useState } from "react";
import { X, Plus } from "lucide-react";
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

export const AiCliPanel: FC<AiCliPanelProps> = ({
  isOpen,
  onClose,
  projectDir,
  onLaunchInTerminal,
}) => {
  const [details, setDetails] = useState<AiCliDetails[]>([]);
  const [customPaths, setCustomPaths] = useState<Record<string, string>>({});
  const [customError, setCustomError] = useState<string | null>(null);

  // New user-defined CLI form inputs
  const [newCliName, setNewCliName] = useState("");
  const [newCliPath, setNewCliPath] = useState("");

  useEffect(() => {
    if (isOpen) {
      getAiCliDetails()
        .then(setDetails)
        .catch(() => setDetails([]));
    }
  }, [isOpen]);

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
            The terminal works with or without these tools. Detection is local-only and never stores
            credentials. Launching runs the CLI as an ordinary terminal process in{" "}
            <code>{projectDir || "the active directory"}</code>.
          </p>
          {details.map((d) => (
            <div key={d.id} className="setting-field">
              <label>
                {d.name} —{" "}
                {d.available ? `found${d.version ? ` (${d.version})` : ""}` : "not found"}
              </label>
              {d.state && (
                <p className="muted-text">
                  Status: <code>{d.state.replace(/_/g, " ")}</code>
                  {d.auth_status ? ` · auth: ${d.auth_status}` : " · auth: unknown"}
                </p>
              )}
              <p className="muted-text">{d.diagnostic}</p>
              <p className="muted-text">{d.install_guidance}</p>
              {d.path && (
                <p className="muted-text">
                  <code>{d.path}</code>
                </p>
              )}
              {d.available && d.path && onLaunchInTerminal && (
                <button
                  className="btn btn-secondary"
                  onClick={() => onLaunchInTerminal(projectDir)}
                >
                  Open project directory in new tab
                </button>
              )}
              <div className="setting-row">
                <input
                  type="text"
                  className="text-input modal-input"
                  placeholder={`Custom path to ${d.id} binary...`}
                  value={customPaths[d.id] || ""}
                  onChange={(e) => setCustomPaths({ ...customPaths, [d.id]: e.target.value })}
                  aria-label={`Custom path for ${d.name}`}
                />
                <button className="btn btn-secondary" onClick={() => void handleCheckCustom(d.id)}>
                  Validate
                </button>
              </div>
            </div>
          ))}

          <div
            className="setting-field"
            style={{ borderTop: "1px solid #313244", paddingTop: "12px" }}
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
