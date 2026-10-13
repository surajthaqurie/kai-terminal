import { FC, useState, useEffect, useCallback, useMemo } from "react";
import {
  X,
  Copy,
  Check,
  GitBranch,
  GitCompare,
  Plus,
  Minus,
  RotateCcw,
  ExternalLink,
  RefreshCw,
  Columns,
  AlignLeft,
  CheckCircle2,
  AlertCircle,
  FileText,
  FileCode,
  FilePlus,
  FileX,
  Trash2,
} from "lucide-react";
import {
  GitFileChange,
  GitChangesSummary,
  getGitChanges,
  getGitDiff,
  stageGitFile,
  unstageGitFile,
  discardGitFile,
  runGitAction,
} from "../services/projectService";

interface GitChangesModalProps {
  dir: string;
  onClose: () => void;
  onOpenEditor?: (dir: string, fileRelPath?: string) => void;
}

// Diff parsing interfaces
export interface DiffLine {
  type: "context" | "add" | "delete";
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  oldHeader?: string;
  newHeader?: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface SplitDiffRow {
  left?: { lineNumber?: number; content: string; type: "delete" | "context" };
  right?: { lineNumber?: number; content: string; type: "add" | "context" };
}

/**
 * Parses unified diff text into structured hunks and line entries.
 */
export function parseUnifiedDiff(rawDiff: string): ParsedDiff {
  const lines = rawDiff.split("\n");
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldHeader: string | undefined;
  let newHeader: string | undefined;

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      oldHeader = line.slice(4).trim();
      continue;
    }
    if (line.startsWith("+++ ")) {
      newHeader = line.slice(4).trim();
      continue;
    }
    // Hunk header: @@ -oldStart,oldLines +newStart,newLines @@
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (match) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      const oldStart = parseInt(match[1], 10);
      const oldLines = match[2] !== undefined ? parseInt(match[2], 10) : 1;
      const newStart = parseInt(match[3], 10);
      const newLines = match[4] !== undefined ? parseInt(match[4], 10) : 1;
      currentHunk = {
        header: line.trim(),
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
      };
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (line.startsWith("+")) {
      additions++;
      currentHunk.lines.push({
        type: "add",
        newLineNumber: newLine++,
        content: line.slice(1),
      });
    } else if (line.startsWith("-")) {
      deletions++;
      currentHunk.lines.push({
        type: "delete",
        oldLineNumber: oldLine++,
        content: line.slice(1),
      });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({
        type: "context",
        oldLineNumber: oldLine++,
        newLineNumber: newLine++,
        content: line.slice(1),
      });
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return {
    oldHeader,
    newHeader,
    hunks,
    additions,
    deletions,
  };
}

/**
 * Pairs hunk lines into side-by-side rows for split diff view.
 */
export function buildSplitRows(hunk: DiffHunk): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  const lines = hunk.lines;
  let i = 0;

  while (i < lines.length) {
    const current = lines[i];
    if (current.type === "context") {
      rows.push({
        left: { lineNumber: current.oldLineNumber, content: current.content, type: "context" },
        right: { lineNumber: current.newLineNumber, content: current.content, type: "context" },
      });
      i++;
      continue;
    }

    // Collect contiguous deletes and adds
    const deletes: DiffLine[] = [];
    const adds: DiffLine[] = [];

    while (i < lines.length && (lines[i].type === "delete" || lines[i].type === "add")) {
      if (lines[i].type === "delete") {
        deletes.push(lines[i]);
      } else {
        adds.push(lines[i]);
      }
      i++;
    }

    const count = Math.max(deletes.length, adds.length);
    for (let k = 0; k < count; k++) {
      const d = deletes[k];
      const a = adds[k];
      rows.push({
        left: d ? { lineNumber: d.oldLineNumber, content: d.content, type: "delete" } : undefined,
        right: a ? { lineNumber: a.newLineNumber, content: a.content, type: "add" } : undefined,
      });
    }
  }

  return rows;
}

function splitPath(fullPath: string): { fileName: string; dirPath: string } {
  const parts = fullPath.split(/[/\\]/);
  const fileName = parts.pop() || fullPath;
  const dirPath = parts.join("/");
  return { fileName, dirPath };
}

function getStatusBadge(status: string, staged: boolean) {
  const s = status.toUpperCase();
  if (s === "M") {
    return {
      label: "M",
      title: staged ? "Staged Modified" : "Modified",
      className: "badge-modified",
    };
  }
  if (s === "A") {
    return { label: "A", title: "Added", className: "badge-added" };
  }
  if (s === "D") {
    return { label: "D", title: "Deleted", className: "badge-deleted" };
  }
  if (s === "R") {
    return { label: "R", title: "Renamed", className: "badge-renamed" };
  }
  return { label: "U", title: "Untracked", className: "badge-untracked" };
}

function getFileIcon(status: string) {
  const s = status.toUpperCase();
  if (s === "D") return <FileX size={14} className="file-status-icon deleted" />;
  if (s === "A" || s === "U" || s === "?")
    return <FilePlus size={14} className="file-status-icon added" />;
  return <FileCode size={14} className="file-status-icon modified" />;
}

export const GitChangesModal: FC<GitChangesModalProps> = ({ dir, onClose, onOpenEditor }) => {
  const [summary, setSummary] = useState<GitChangesSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<GitFileChange | null>(null);
  const [rawDiff, setRawDiff] = useState<string>("");
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified");
  const [filterText, setFilterText] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmDiscardFile, setConfirmDiscardFile] = useState<GitFileChange | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const showStatusBanner = (msg: string) => {
    setStatusMsg(msg);
    setTimeout(() => {
      setStatusMsg((prev) => (prev === msg ? null : prev));
    }, 2800);
  };

  const loadChanges = useCallback(
    async (preserveSelected = true) => {
      setLoading(true);
      setError(null);
      try {
        const res = await getGitChanges(dir);
        setSummary(res);
        if (!preserveSelected || !selectedFile) {
          // Select first available file
          const first = res.staged[0] || res.working_tree[0] || res.untracked[0] || null;
          setSelectedFile(first);
        } else {
          // Check if selected file still exists in changes
          const all = [...res.staged, ...res.working_tree, ...res.untracked];
          const exists = all.find(
            (f) => f.path === selectedFile.path && f.staged === selectedFile.staged
          );
          if (exists) {
            setSelectedFile(exists);
          } else {
            const first = res.staged[0] || res.working_tree[0] || res.untracked[0] || null;
            setSelectedFile(first);
          }
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [dir, selectedFile]
  );

  useEffect(() => {
    void loadChanges(false);
  }, [dir]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load diff when selectedFile changes
  useEffect(() => {
    if (!selectedFile) {
      setRawDiff("");
      return;
    }
    let cancelled = false;
    setLoadingDiff(true);

    getGitDiff(dir, selectedFile.path, selectedFile.staged)
      .then((d) => {
        if (!cancelled) {
          setRawDiff(d);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setRawDiff(`Failed to load diff: ${err instanceof Error ? err.message : String(err)}`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDiff(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dir, selectedFile]);

  const parsedDiff = useMemo(() => parseUnifiedDiff(rawDiff), [rawDiff]);

  // Actions
  const handleStageFile = async (file: GitFileChange) => {
    try {
      await stageGitFile(dir, file.path);
      showStatusBanner(`Staged ${file.path}`);
      await loadChanges(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUnstageFile = async (file: GitFileChange) => {
    try {
      await unstageGitFile(dir, file.path);
      showStatusBanner(`Unstaged ${file.path}`);
      await loadChanges(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStageAll = async () => {
    try {
      await runGitAction(dir, "stage_all");
      showStatusBanner("Staged all changes");
      await loadChanges(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUnstageAll = async () => {
    try {
      await runGitAction(dir, "unstage_all");
      showStatusBanner("Unstaged all changes");
      await loadChanges(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDiscardFile = async (file: GitFileChange) => {
    try {
      await discardGitFile(dir, file.path);
      setConfirmDiscardFile(null);
      showStatusBanner(`Discarded changes in ${file.path}`);
      await loadChanges(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyDiff = async () => {
    if (!rawDiff) return;
    try {
      await navigator.clipboard.writeText(rawDiff);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmDiscardFile) {
          setConfirmDiscardFile(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmDiscardFile, onClose]);

  const filterMatch = (f: GitFileChange) => {
    if (!filterText.trim()) return true;
    return f.path.toLowerCase().includes(filterText.toLowerCase());
  };

  const filteredStaged = (summary?.staged || []).filter(filterMatch);
  const filteredWorking = (summary?.working_tree || []).filter(filterMatch);
  const filteredUntracked = (summary?.untracked || []).filter(filterMatch);
  const totalCount = summary?.total_changes ?? 0;

  return (
    <div
      className="modal-backdrop git-changes-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Source Control and Diff Viewer for ${dir}`}
    >
      <div className="git-changes-modal" onClick={(e) => e.stopPropagation()} role="document">
        {/* Header */}
        <div className="git-changes-header">
          <div className="git-changes-title-group">
            <GitCompare size={18} className="title-icon" aria-hidden="true" />
            <h3 className="git-changes-title">Changes Review &amp; Diff</h3>
            {summary?.branch && (
              <span className="git-branch-badge" title={`Branch: ${summary.branch}`}>
                <GitBranch size={12} aria-hidden="true" />
                <span>{summary.branch}</span>
              </span>
            )}
            <span className="git-path-badge" title={summary?.repo_root || dir}>
              {summary?.repo_root || dir}
            </span>
          </div>

          <div className="git-changes-header-actions">
            <button
              type="button"
              className="btn btn-secondary btn-small refresh-btn"
              onClick={() => void loadChanges(true)}
              title="Refresh changes"
              disabled={loading}
              aria-label="Refresh changes"
            >
              <RefreshCw size={13} className={loading ? "spin" : ""} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              className="btn-close"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close changes modal"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Temporary status alert */}
        {statusMsg && <div className="git-action-banner">{statusMsg}</div>}
        {error && (
          <div className="git-error-banner">
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}

        {/* Main Body: Two-panel VS Code layout */}
        <div className="git-changes-content">
          {/* Left Panel: File Changes Explorer */}
          <div className="git-changes-sidebar" role="region" aria-label="Source Control Changes">
            <div className="sidebar-filter-row">
              <input
                type="text"
                className="sidebar-filter-input"
                placeholder="Filter changed files..."
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                aria-label="Filter changed files"
              />
              <span className="total-changes-count" title="Total changed files">
                {totalCount} {totalCount === 1 ? "file" : "files"}
              </span>
            </div>

            <div className="changes-tree-list">
              {/* STAGED CHANGES */}
              {summary && summary.staged.length > 0 && (
                <div className="changes-section">
                  <div className="section-header">
                    <span className="section-title">Staged Changes ({summary.staged.length})</span>
                    <button
                      type="button"
                      className="section-action-btn"
                      onClick={handleUnstageAll}
                      title="Unstage all changes"
                      aria-label="Unstage all changes"
                    >
                      <Minus size={12} />
                      <span>Unstage All</span>
                    </button>
                  </div>
                  <div className="file-list">
                    {filteredStaged.map((f) => {
                      const { fileName, dirPath } = splitPath(f.path);
                      const badge = getStatusBadge(f.status, true);
                      const isSelected =
                        selectedFile?.path === f.path && selectedFile?.staged === true;
                      return (
                        <div
                          key={`staged-${f.path}`}
                          className={`file-row ${isSelected ? "selected" : ""}`}
                          onClick={() => setSelectedFile(f)}
                          role="button"
                          tabIndex={0}
                          aria-selected={isSelected}
                        >
                          <span className="file-icon-wrap">{getFileIcon(f.status)}</span>
                          <span className="file-name" title={f.path}>
                            {fileName}
                            {dirPath && <span className="file-dir"> {dirPath}</span>}
                          </span>
                          <span className={`file-badge ${badge.className}`} title={badge.title}>
                            {badge.label}
                          </span>
                          <div className="file-row-actions">
                            <button
                              type="button"
                              className="file-action-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleUnstageFile(f);
                              }}
                              title="Unstage change"
                              aria-label={`Unstage ${f.path}`}
                            >
                              <Minus size={12} />
                            </button>
                            {onOpenEditor && (
                              <button
                                type="button"
                                className="file-action-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenEditor(dir, f.path);
                                }}
                                title="Open in editor"
                                aria-label={`Open ${f.path} in editor`}
                              >
                                <ExternalLink size={12} />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* WORKING TREE CHANGES */}
              {summary && summary.working_tree.length > 0 && (
                <div className="changes-section">
                  <div className="section-header">
                    <span className="section-title">Changes ({summary.working_tree.length})</span>
                    <button
                      type="button"
                      className="section-action-btn"
                      onClick={handleStageAll}
                      title="Stage all changes"
                      aria-label="Stage all changes"
                    >
                      <Plus size={12} />
                      <span>Stage All</span>
                    </button>
                  </div>
                  <div className="file-list">
                    {filteredWorking.map((f) => {
                      const { fileName, dirPath } = splitPath(f.path);
                      const badge = getStatusBadge(f.status, false);
                      const isSelected =
                        selectedFile?.path === f.path && selectedFile?.staged === false;
                      return (
                        <div
                          key={`working-${f.path}`}
                          className={`file-row ${isSelected ? "selected" : ""}`}
                          onClick={() => setSelectedFile(f)}
                          role="button"
                          tabIndex={0}
                          aria-selected={isSelected}
                        >
                          <span className="file-icon-wrap">{getFileIcon(f.status)}</span>
                          <span className="file-name" title={f.path}>
                            {fileName}
                            {dirPath && <span className="file-dir"> {dirPath}</span>}
                          </span>
                          <span className={`file-badge ${badge.className}`} title={badge.title}>
                            {badge.label}
                          </span>
                          <div className="file-row-actions">
                            <button
                              type="button"
                              className="file-action-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleStageFile(f);
                              }}
                              title="Stage changes"
                              aria-label={`Stage ${f.path}`}
                            >
                              <Plus size={12} />
                            </button>
                            <button
                              type="button"
                              className="file-action-btn danger"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDiscardFile(f);
                              }}
                              title="Discard changes"
                              aria-label={`Discard changes in ${f.path}`}
                            >
                              <RotateCcw size={12} />
                            </button>
                            {onOpenEditor && (
                              <button
                                type="button"
                                className="file-action-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenEditor(dir, f.path);
                                }}
                                title="Open in editor"
                                aria-label={`Open ${f.path} in editor`}
                              >
                                <ExternalLink size={12} />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* UNTRACKED FILES */}
              {summary && summary.untracked.length > 0 && (
                <div className="changes-section">
                  <div className="section-header">
                    <span className="section-title">
                      Untracked Files ({summary.untracked.length})
                    </span>
                  </div>
                  <div className="file-list">
                    {filteredUntracked.map((f) => {
                      const { fileName, dirPath } = splitPath(f.path);
                      const badge = getStatusBadge("U", false);
                      const isSelected =
                        selectedFile?.path === f.path && selectedFile?.staged === false;
                      return (
                        <div
                          key={`untracked-${f.path}`}
                          className={`file-row ${isSelected ? "selected" : ""}`}
                          onClick={() => setSelectedFile(f)}
                          role="button"
                          tabIndex={0}
                          aria-selected={isSelected}
                        >
                          <span className="file-icon-wrap">{getFileIcon("U")}</span>
                          <span className="file-name" title={f.path}>
                            {fileName}
                            {dirPath && <span className="file-dir"> {dirPath}</span>}
                          </span>
                          <span className={`file-badge ${badge.className}`} title={badge.title}>
                            {badge.label}
                          </span>
                          <div className="file-row-actions">
                            <button
                              type="button"
                              className="file-action-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleStageFile(f);
                              }}
                              title="Track file (Stage)"
                              aria-label={`Stage ${f.path}`}
                            >
                              <Plus size={12} />
                            </button>
                            <button
                              type="button"
                              className="file-action-btn danger"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDiscardFile(f);
                              }}
                              title="Delete untracked file"
                              aria-label={`Delete ${f.path}`}
                            >
                              <Trash2 size={12} />
                            </button>
                            {onOpenEditor && (
                              <button
                                type="button"
                                className="file-action-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenEditor(dir, f.path);
                                }}
                                title="Open in editor"
                                aria-label={`Open ${f.path} in editor`}
                              >
                                <ExternalLink size={12} />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Clean tree message */}
              {summary && summary.clean && (
                <div className="changes-clean-state">
                  <CheckCircle2 size={36} className="clean-icon" />
                  <h4>Working Tree Clean</h4>
                  <p className="muted-text">
                    No uncommitted changes detected. Any manual edits or changes made by AI agents
                    will automatically appear here.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Right Panel: VS Code Diff Viewer */}
          <div className="git-diff-viewer" role="region" aria-label="Diff Viewer">
            {selectedFile ? (
              <div className="diff-container">
                {/* Diff Viewer Top Toolbar */}
                <div className="diff-toolbar">
                  <div className="diff-file-meta">
                    <span className="diff-file-icon">{getFileIcon(selectedFile.status)}</span>
                    <span className="diff-file-path" title={selectedFile.path}>
                      {selectedFile.path}
                    </span>
                    <span className="diff-stage-tag">
                      {selectedFile.staged ? "Staged" : "Working Tree"}
                    </span>
                    {(parsedDiff.additions > 0 || parsedDiff.deletions > 0) && (
                      <span className="diff-stats-badge">
                        <span className="diff-add-stat">+{parsedDiff.additions}</span>
                        <span className="diff-del-stat">-{parsedDiff.deletions}</span>
                      </span>
                    )}
                  </div>

                  <div className="diff-view-controls">
                    {/* Mode Toggle: Unified vs Side-by-Side */}
                    <div className="mode-toggle-group">
                      <button
                        type="button"
                        className={`toggle-btn ${viewMode === "unified" ? "active" : ""}`}
                        onClick={() => setViewMode("unified")}
                        title="Unified Diff View"
                        aria-label="Unified diff"
                      >
                        <AlignLeft size={13} />
                        <span>Unified</span>
                      </button>
                      <button
                        type="button"
                        className={`toggle-btn ${viewMode === "split" ? "active" : ""}`}
                        onClick={() => setViewMode("split")}
                        title="Split (Side-by-Side) Diff View"
                        aria-label="Split diff"
                      >
                        <Columns size={13} />
                        <span>Split</span>
                      </button>
                    </div>

                    {/* Stage / Unstage Button */}
                    {selectedFile.staged ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        onClick={() => void handleUnstageFile(selectedFile)}
                        title="Unstage this file"
                      >
                        <Minus size={13} />
                        <span>Unstage</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary btn-small"
                        onClick={() => void handleStageFile(selectedFile)}
                        title="Stage this file"
                      >
                        <Plus size={13} />
                        <span>Stage</span>
                      </button>
                    )}

                    {/* Discard button */}
                    {!selectedFile.staged && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-small btn-discard"
                        onClick={() => setConfirmDiscardFile(selectedFile)}
                        title="Discard changes in this file"
                      >
                        <RotateCcw size={13} />
                        <span>Discard</span>
                      </button>
                    )}

                    {/* Open in Editor button */}
                    {onOpenEditor && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        onClick={() => onOpenEditor(dir, selectedFile.path)}
                        title="Open file in editor"
                      >
                        <ExternalLink size={13} />
                        <span>Open Editor</span>
                      </button>
                    )}

                    {/* Copy diff button */}
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={handleCopyDiff}
                      title="Copy diff to clipboard"
                    >
                      {copied ? <Check size={13} /> : <Copy size={13} />}
                      <span>{copied ? "Copied!" : "Copy Diff"}</span>
                    </button>
                  </div>
                </div>

                {/* Confirm Discard Modal Overlay */}
                {confirmDiscardFile && confirmDiscardFile.path === selectedFile.path && (
                  <div className="discard-confirm-box">
                    <p>
                      <strong>Discard changes in &quot;{confirmDiscardFile.path}&quot;?</strong>
                      <br />
                      This will revert your local modifications and cannot be undone.
                    </p>
                    <div className="discard-confirm-actions">
                      <button
                        type="button"
                        className="btn btn-danger btn-small"
                        onClick={() => void handleDiscardFile(confirmDiscardFile)}
                      >
                        Confirm Discard
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        onClick={() => setConfirmDiscardFile(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Diff Viewer Body */}
                <div className="diff-editor-body" tabIndex={0} aria-label="Diff contents">
                  {loadingDiff ? (
                    <div className="diff-loading">
                      <RefreshCw size={20} className="spin" />
                      <span>Loading diff...</span>
                    </div>
                  ) : parsedDiff.hunks.length === 0 ? (
                    <div className="diff-empty-state">
                      <FileText size={32} />
                      <p>
                        {rawDiff
                          ? rawDiff
                          : "No text differences to display. File may be empty or newly created."}
                      </p>
                    </div>
                  ) : viewMode === "unified" ? (
                    /* Unified Mode */
                    <div className="diff-unified-view">
                      {parsedDiff.hunks.map((hunk, hIdx) => (
                        <div key={`hunk-${hIdx}`} className="diff-hunk">
                          <div className="hunk-header-row">
                            <span className="hunk-header-label">{hunk.header}</span>
                          </div>
                          {hunk.lines.map((line, lIdx) => (
                            <div
                              key={`line-${hIdx}-${lIdx}`}
                              className={`diff-line-row diff-line-${line.type}`}
                            >
                              <span className="diff-line-num old-num">
                                {line.oldLineNumber ?? ""}
                              </span>
                              <span className="diff-line-num new-num">
                                {line.newLineNumber ?? ""}
                              </span>
                              <span className="diff-line-marker">
                                {line.type === "add" ? "+" : line.type === "delete" ? "-" : " "}
                              </span>
                              <span className="diff-line-content">{line.content}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : (
                    /* Split Mode (Side by Side) */
                    <div className="diff-split-view">
                      <div className="diff-split-column-headers">
                        <div className="split-header-col left-header">
                          <span className="split-header-tag">Original (Previous)</span>
                        </div>
                        <div className="split-header-col right-header">
                          <span className="split-header-tag">Modified (Working / Current)</span>
                        </div>
                      </div>
                      {parsedDiff.hunks.map((hunk, hIdx) => {
                        const splitRows = buildSplitRows(hunk);
                        return (
                          <div key={`split-hunk-${hIdx}`} className="diff-split-hunk">
                            <div className="hunk-header-row">
                              <span className="hunk-header-label">{hunk.header}</span>
                            </div>
                            <div className="split-rows-table">
                              {splitRows.map((row, rIdx) => (
                                <div key={`split-row-${hIdx}-${rIdx}`} className="split-row">
                                  {/* Left pane: Original / Deletions */}
                                  <div
                                    className={`split-col left-col ${
                                      row.left ? `diff-line-${row.left.type}` : "empty-col"
                                    }`}
                                  >
                                    <span className="diff-line-num">
                                      {row.left?.lineNumber ?? ""}
                                    </span>
                                    <span className="diff-line-marker">
                                      {row.left?.type === "delete" ? "-" : " "}
                                    </span>
                                    <span className="diff-line-content">
                                      {row.left?.content ?? ""}
                                    </span>
                                  </div>

                                  {/* Right pane: Modified / Additions */}
                                  <div
                                    className={`split-col right-col ${
                                      row.right ? `diff-line-${row.right.type}` : "empty-col"
                                    }`}
                                  >
                                    <span className="diff-line-num">
                                      {row.right?.lineNumber ?? ""}
                                    </span>
                                    <span className="diff-line-marker">
                                      {row.right?.type === "add" ? "+" : " "}
                                    </span>
                                    <span className="diff-line-content">
                                      {row.right?.content ?? ""}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="diff-unselected-state">
                <GitCompare size={40} className="muted-icon" />
                <h4>No File Selected</h4>
                <p className="muted-text">
                  Select a changed file from the sidebar to review its additions and deletions.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="git-changes-footer">
          <div className="footer-left">
            <span className="muted-text">
              Tip: AI agents and manual terminal commands update this working tree in real time.
            </span>
          </div>
          <div className="footer-right">
            <button type="button" className="btn btn-secondary btn-small" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
