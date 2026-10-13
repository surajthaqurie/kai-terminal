import { FC, useState, useEffect } from "react";
import { X, Plus, Trash2, Edit3, Play, Bookmark } from "lucide-react";
import {
  Workspace,
  loadOrMigrateWorkspaces,
  saveWorkspaces,
  createWorkspace,
  renameWorkspace,
  deleteWorkspace,
  validateWorkspaceDir,
  PersistedTabV2,
} from "../services/workspaces";
import { TerminalTab } from "../types/terminal";

interface WorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentTabs: TerminalTab[];
  onLoadWorkspace: (workspace: Workspace) => void;
}

export const WorkspaceModal: FC<WorkspaceModalProps> = ({
  isOpen,
  onClose,
  currentTabs,
  onLoadWorkspace,
}) => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [newWsName, setNewWsName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setWorkspaces(loadOrMigrateWorkspaces());
      setErrorMsg(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSaveCurrentAsWorkspace = () => {
    const name = prompt("Enter a name for this workspace:", "Project Workspace");
    if (!name || !name.trim()) return;
    setErrorMsg(null);
    const tabsV2: PersistedTabV2[] = currentTabs.map((t) => ({
      title: t.title,
      shellPath: t.shellPath,
      cwd: t.cwd,
      splitDirection: t.splitDirection,
      panes:
        t.panes.length > 1
          ? t.panes.map((p) => ({ shellPath: p.shellPath, cwd: p.cwd }))
          : undefined,
    }));
    const newWs = createWorkspace(name.trim(), tabsV2);
    const updated = [newWs, ...workspaces];
    saveWorkspaces(updated);
    setWorkspaces(updated);
  };

  const handleCreateNewEmpty = () => {
    if (!newWsName.trim()) {
      setErrorMsg("Workspace name cannot be empty.");
      return;
    }
    setErrorMsg(null);
    const newWs = createWorkspace(newWsName.trim(), [{ title: "Terminal 1" }]);
    const updated = [newWs, ...workspaces];
    saveWorkspaces(updated);
    setWorkspaces(updated);
    setNewWsName("");
  };

  const handleRename = (id: string) => {
    if (!editName.trim()) return;
    const updated = renameWorkspace(workspaces, id, editName.trim());
    saveWorkspaces(updated);
    setWorkspaces(updated);
    setEditingId(null);
  };

  const handleDelete = (id: string) => {
    const updated = deleteWorkspace(workspaces, id);
    saveWorkspaces(updated);
    setWorkspaces(updated);
  };

  const handleRestore = (ws: Workspace) => {
    setErrorMsg(null);
    // Validate directory path formatting for each tab
    for (const tab of ws.tabs) {
      if (tab.cwd) {
        const err = validateWorkspaceDir(tab.cwd);
        if (err) {
          setErrorMsg(`Cannot restore workspace "${ws.name}": ${err} (${tab.cwd})`);
          return;
        }
      }
    }
    onLoadWorkspace(ws);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-label="Named Workspaces">
      <div className="settings-modal" onClick={(e) => e.stopPropagation()} role="document">
        <div className="modal-header">
          <h3>Named Workspaces &amp; Sessions</h3>
          <button className="btn-close" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="modal-body" style={{ maxHeight: "65vh", overflowY: "auto" }}>
          <p className="muted-text">
            Workspaces save your active session tab layout, project working directories, and split
            panes. Keystrokes, scrollback history, and credentials are <strong>never</strong>{" "}
            persisted.
          </p>

          <div style={{ display: "flex", gap: "8px", margin: "8px 0" }}>
            <button className="btn btn-primary" onClick={handleSaveCurrentAsWorkspace}>
              <Bookmark size={14} />
              <span>Save Current Layout as Workspace</span>
            </button>
          </div>

          {errorMsg && (
            <p className="error-text" role="alert">
              {errorMsg}
            </p>
          )}

          <div className="setting-field" style={{ marginTop: "12px" }}>
            <label>Saved Workspaces ({workspaces.length})</label>
            {workspaces.length === 0 ? (
              <p className="muted-text">No saved workspaces yet.</p>
            ) : (
              <div className="workspace-list">
                {workspaces.map((ws) => (
                  <div key={ws.id} className="workspace-card">
                    <div className="workspace-info">
                      {editingId === ws.id ? (
                        <div style={{ display: "flex", gap: "6px" }}>
                          <input
                            type="text"
                            className="text-input modal-input"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleRename(ws.id);
                              if (e.key === "Escape") setEditingId(null);
                            }}
                          />
                          <button className="btn btn-secondary" onClick={() => handleRename(ws.id)}>
                            Save
                          </button>
                        </div>
                      ) : (
                        <span className="workspace-name">{ws.name}</span>
                      )}
                      <span className="workspace-meta">
                        {ws.tabs.length} session tab{ws.tabs.length === 1 ? "" : "s"}
                        {ws.tabs[0]?.cwd ? ` · ${ws.tabs[0].cwd}` : ""}
                      </span>
                    </div>

                    <div className="workspace-actions">
                      <button
                        className="btn btn-secondary"
                        onClick={() => handleRestore(ws)}
                        title="Restore Workspace"
                      >
                        <Play size={13} />
                        <span>Restore</span>
                      </button>
                      <button
                        className="btn btn-icon"
                        onClick={() => {
                          setEditingId(ws.id);
                          setEditName(ws.name);
                        }}
                        title="Rename Workspace"
                      >
                        <Edit3 size={13} />
                      </button>
                      <button
                        className="btn btn-icon"
                        onClick={() => handleDelete(ws.id)}
                        title="Delete Workspace"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div
            className="setting-field"
            style={{ borderTop: "1px solid var(--border-default)", paddingTop: "12px" }}
          >
            <label>Create New Empty Workspace</label>
            <div className="setting-row">
              <input
                type="text"
                className="text-input modal-input"
                placeholder="New Workspace Name..."
                value={newWsName}
                onChange={(e) => setNewWsName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateNewEmpty();
                }}
              />
              <button className="btn btn-secondary" onClick={handleCreateNewEmpty}>
                <Plus size={14} />
                <span>Create</span>
              </button>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
