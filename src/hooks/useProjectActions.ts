import { useCallback, useState } from "react";
import {
  GitInfo,
  InstalledEditor,
  getGitInfoCached,
  getInstalledEditors,
  invalidateGitCache,
  openProjectInEditor,
  runGitAction,
} from "../services/projectService";

interface ProjectActionsOptions {
  /** Active pane's project dir (pane -> tab -> toolbar). */
  effectiveProjectDir: string;
  /** Global toolbar working directory. */
  cwd: string;
  /** Default editor binary from Settings. */
  editorPath: string | undefined;
  setLastError: (message: string | null) => void;
  applyGitInfo: (dir: string, info: GitInfo, updatesFooter: boolean) => void;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Open-in-editor and git status / changes-review actions for the active project. */
export function useProjectActions({
  effectiveProjectDir,
  cwd,
  editorPath,
  setLastError,
  applyGitInfo,
}: ProjectActionsOptions) {
  const [installedEditors, setInstalledEditors] = useState<InstalledEditor[]>([]);
  const [isLoadingEditors, setIsLoadingEditors] = useState(false);
  // Centered in-app git status and VS Code-style changes/diff review modal.
  const [gitStatusModal, setGitStatusModal] = useState<{ dir: string; output: string } | null>(
    null
  );
  const [gitChangesModal, setGitChangesModal] = useState<{ dir: string } | null>(null);

  // Installed editors load strictly on demand: the editor picker calls
  // this when opened. No startup/idle prefetch, so the PATH + Program Files
  // scan never contends with the first PTY spawn on Windows (the backend
  // result is process-cached after the first scan).
  const refreshInstalledEditors = useCallback(() => {
    setIsLoadingEditors(true);
    void getInstalledEditors()
      .then((list) => setInstalledEditors(list))
      .catch(() => setInstalledEditors([]))
      .finally(() => setIsLoadingEditors(false));
  }, []);

  const openEditor = useCallback(
    async (editorBinary?: string, dirOverride?: string) => {
      try {
        const dir = dirOverride || effectiveProjectDir || cwd.trim() || ".";
        // Explicit picker choice wins; otherwise fall back to Settings default.
        const configured = editorPath?.trim() || undefined;
        await openProjectInEditor(dir, editorBinary || configured);
        setLastError(null);
      } catch (err) {
        setLastError(errorMessage(err));
      }
    },
    [effectiveProjectDir, cwd, editorPath, setLastError]
  );

  const openFileInEditor = useCallback(
    async (projectDir: string, fileRelPath?: string) => {
      try {
        const targetPath = fileRelPath ? `${projectDir}/${fileRelPath}` : projectDir;
        await openProjectInEditor(targetPath, editorPath?.trim() || undefined);
      } catch (err) {
        setLastError(errorMessage(err));
      }
    },
    [editorPath, setLastError]
  );

  const showGit = useCallback(
    async (action: "status" | "changes", dirOverride?: string) => {
      try {
        const dir = dirOverride || effectiveProjectDir;
        if (!dir) {
          setLastError("No project directory set. Enter a working directory first.");
          return;
        }
        if (action === "changes") {
          // Full VS Code-style changes review & diff modal.
          setGitChangesModal({ dir });
          return;
        }
        // Plain `git status` list output in a centered dialog.
        invalidateGitCache(dir);
        const output = await runGitAction(dir, "status");
        setGitStatusModal({ dir, output });
        // Refresh the footer badge from cache (status is read-only, cheap).
        void getGitInfoCached(dir).then((info) =>
          applyGitInfo(dir, info, dir === effectiveProjectDir)
        );
      } catch (err) {
        setLastError(errorMessage(err));
      }
    },
    [effectiveProjectDir, setLastError, applyGitInfo]
  );

  /** Opens the changes review for the active dir (optionally reporting when there is none). */
  const reviewChanges = useCallback(
    (reportMissing = false) => {
      const dir = effectiveProjectDir || cwd.trim();
      if (dir) {
        setGitChangesModal({ dir });
      } else if (reportMissing) {
        setLastError("No project directory set. Enter or open a directory first.");
      }
    },
    [effectiveProjectDir, cwd, setLastError]
  );

  const closeGitStatus = useCallback(() => setGitStatusModal(null), []);
  const closeGitChanges = useCallback(() => setGitChangesModal(null), []);

  return {
    installedEditors,
    isLoadingEditors,
    refreshInstalledEditors,
    openEditor,
    openFileInEditor,
    showGit,
    reviewChanges,
    gitStatusModal,
    gitChangesModal,
    closeGitStatus,
    closeGitChanges,
  };
}
