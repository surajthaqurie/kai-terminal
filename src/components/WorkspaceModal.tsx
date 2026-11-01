import { FC, useState, useEffect } from "react";
import { ESCAPE_OWNER_ATTR, useModalBehavior } from "../hooks/useModalBehavior";
import { X, Plus, Trash2, Edit3, Play, Bookmark } from "lucide-react";
import {
  MAX_TABS_PER_WORKSPACE,
  MAX_WORKSPACES,
  Workspace,
  loadOrMigrateWorkspaces,
  saveWorkspaces,
  createWorkspace,
  renameWorkspace,
  deleteWorkspace,
  validateWorkspaceDir,
  sanitizeTab,
  nodeToPersistedLayout,
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
  const dialogRef = useModalBehavior(isOpen, onClose);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [newWsName, setNewWsName] = useState("");
  const [saveName, setSaveName] = useState("");
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

  /** Persists `next` and only then shows it; reports a failed write instead of "saving". */
  const commit = (next: Workspace[]): boolean => {
    if (!saveWorkspaces(next)) {
      setErrorMsg("Could not save workspaces: browser storage is full or unavailable.");
      return false;
    }
    setWorkspaces(next);
    return true;
  };

  const handleSaveCurrentAsWorkspace = () => {
    if (workspaces.length >= MAX_WORKSPACES) {
      setErrorMsg(`You can keep up to ${MAX_WORKSPACES} workspaces. Delete one to save another.`);
      return;
    }
    const name = saveName.trim() || `Workspace ${workspaces.length + 1}`;
    setErrorMsg(null);
    // Persist titles + cwd/shell + pane structure + nested layout only.
    // Never scrollback, history, env values, or credentials (see sanitizeTab).
    const tabsV2: PersistedTabV2[] = currentTabs.map((t) => {
      const paneIds = t.panes.map((p) => p.id);
      const raw = {
        title: t.title,
        color: t.color,
        shellPath: t.shellPath,
        cwd: t.cwd,
        splitDirection: t.splitDirection,
        panes:
          t.panes.length > 1
            ? t.panes.map((p) => ({ shellPath: p.shellPath, cwd: p.cwd }))
            : undefined,
        layout:
          t.layout && t.panes.length > 1 ? nodeToPersistedLayout(t.layout, paneIds) : undefined,
      };
      return sanitizeTab(raw) ?? { title: t.title || "Terminal" };
    });
    const newWs = createWorkspace(name, tabsV2);
    if (!commit([newWs, ...workspaces])) return;
    setSaveName("");
    // createWorkspace keeps the first MAX_TABS_PER_WORKSPACE tabs: say so.
    if (tabsV2.length > MAX_TABS_PER_WORKSPACE) {
      setErrorMsg(
        `Saved "${name}" with the first ${MAX_TABS_PER_WORKSPACE} of ${tabsV2.length} tabs (the per-workspace limit).`
      );
    }
  };

  const handleCreateNewEmpty = () => {
    if (!newWsName.trim()) {
      setErrorMsg("Workspace name cannot be empty.");
      return;
    }
    if (workspaces.length >= MAX_WORKSPACES) {
      setErrorMsg(`You can keep up to ${MAX_WORKSPACES} workspaces. Delete one to create another.`);
      return;
    }
    setErrorMsg(null);
    const newWs = createWorkspace(newWsName.trim(), [{ title: "Terminal 1" }]);
    if (commit([newWs, ...workspaces])) setNewWsName("");
  };

  const handleRename = (id: string) => {
    if (!editName.trim()) return;
    if (commit(renameWorkspace(workspaces, id, editName.trim()))) setEditingId(null);
  };

  const handleDelete = (id: string) => {
    commit(deleteWorkspace(workspaces, id));
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
      <div
        className="settings-modal"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        role="document"
      >
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

          <div className="setting-row" style={{ margin: "8px 0" }}>
            <input
              type="text"
              className="text-input modal-input"
              placeholder={`Workspace name (optional, e.g. Workspace ${workspaces.length + 1})`}
              aria-label="Name for the saved layout"
              value={saveName}
              maxLength={80}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveCurrentAsWorkspace();
              }}
            />
            <button className="btn btn-primary" onClick={handleSaveCurrentAsWorkspace}>
              <Bookmark size={14} />
              <span>Save Current Layout</span>
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
                            {...{ [ESCAPE_OWNER_ATTR]: "true" }}
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
