import { useCallback, useEffect, useState } from "react";
import { runCacheJanitor } from "../services/cacheJanitor";
import { useLatest } from "./useLatest";
import type { NoticeKind } from "./useNotices";
import {
  APP_VERSION_FALLBACK,
  INITIAL_UPDATE_DOWNLOAD_STATE,
  RELEASES_PAGE_URL,
  UPDATE_PERIODIC_MS,
  UpdateCheckResult,
  UpdateDownloadState,
  UpdateOutcome,
  checkForUpdates,
  clearUpdatePending,
  consumeUpdateOutcome,
  dismissVersion,
  downloadAndInstallUpdate,
  getAppVersion,
  isDismissed,
  markUpdatePending,
  openReleasePage,
  recordCheckTime,
  shouldAutoCheck,
} from "../services/updateService";

/** First auto-check waits until the user has settled in (never during launch). */
const FIRST_CHECK_DELAY_MS = 45_000;
const HIDDEN_RETRY_MS = 60_000;
const MAX_HIDDEN_RETRIES = 3;

interface AppUpdatesOptions {
  autoCheckUpdates: boolean | undefined;
  setLastError: (message: string | null) => void;
  /** Short confirmations (e.g. "up to date") that are not errors. */
  notify?: (kind: NoticeKind, message: string) => void;
}

const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : typeof err === "string" ? err : String(err);

/** App version, update checks (auto + manual) and the download/install flow. */
export function useAppUpdates({ autoCheckUpdates, setLastError, notify }: AppUpdatesOptions) {
  const [appVersion, setAppVersion] = useState<string>(APP_VERSION_FALLBACK);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState<boolean>(false);
  const [updateBannerVisible, setUpdateBannerVisible] = useState<boolean>(false);
  const [updateDownload, setUpdateDownload] = useState<UpdateDownloadState>(
    INITIAL_UPDATE_DOWNLOAD_STATE
  );
  // Result of the update that restarted Kai ("updated to vX" / "didn't finish").
  const [updateOutcome, setUpdateOutcome] = useState<UpdateOutcome | null>(null);

  const checkUpdates = useCallback(
    async (manual = false) => {
      if (isCheckingUpdates) return;
      setIsCheckingUpdates(true);
      try {
        const current = await getAppVersion();
        setAppVersion(current);
        const result = await checkForUpdates(current);
        // A failed background check (offline, rate limit, GitHub 5xx) says
        // nothing about an update we already found: keep showing it instead of
        // replacing it with an error. A manual check always shows its result.
        const keepKnownUpdate = Boolean(result.error) && !manual;
        setUpdateInfo((prev) => (keepKnownUpdate && prev?.updateAvailable ? prev : result));
        // Fresh version → fresh download state (never reuse a stale path),
        // but never wipe an install that is running right now.
        setUpdateDownload((prev) =>
          prev.status === "downloading" || prev.status === "installing"
            ? prev
            : INITIAL_UPDATE_DOWNLOAD_STATE
        );
        // Only a check that actually reached GitHub counts as done, so a
        // failed one is retried at the next launch instead of 24 h later.
        if (!result.error) recordCheckTime();
        if (result.updateAvailable && result.latestVersion) {
          // Respect a previous dismiss unless this is a manual re-check.
          if (manual || !isDismissed(result.latestVersion)) {
            setUpdateBannerVisible(true);
          }
          // Manual checks no longer yank the browser open: the banner and
          // Settings now offer one-click "Download & Install" (with the
          // release page as an explicit fallback). Auto-opening the browser
          // on every manual check was the reported annoyance.
        } else if (manual && !result.updateAvailable && !result.error) {
          setLastError(null);
          // A manual check that finds nothing must still answer the question.
          notify?.("info", `You're up to date: Kai ${current} is the latest version.`);
        } else if (manual && result.error) {
          setLastError(`Update check: ${result.error}`);
        }
      } catch (err) {
        if (manual) setLastError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsCheckingUpdates(false);
      }
    },
    [isCheckingUpdates, setLastError, notify]
  );

  // The schedule below outlives many renders, so it calls the LATEST
  // `checkUpdates` (a captured first-render copy would keep a permanently
  // stale "already checking" guard).
  const checkUpdatesRef = useLatest(checkUpdates);

  // Once per launch: app version for the footer, the outcome of the update that
  // restarted Kai, and the cache sweep. Kept apart from the schedule so that
  // toggling "automatically check for updates" cannot re-run it (the outcome is
  // consumed on read, so a second read would hide an undismissed notice).
  useEffect(() => {
    void getAppVersion().then((v) => {
      setAppVersion(v);
      // Did the update that restarted Kai work? Reported once per launch.
      setUpdateOutcome(consumeUpdateOutcome(v));
      // Install/update cache sweep: remove stale keys from older builds
      // while preserving settings, sessions, and config (allowlist inside).
      // Version-gated so it runs once per update, never on every launch.
      try {
        runCacheJanitor(v);
      } catch {
        // Storage failures must never block startup.
      }
    });
  }, []);

  // Automatic update check on startup and every few hours while the window
  // stays open. Failures are silent unless the user triggered the check manually.
  useEffect(() => {
    // Defer network auto-check well past terminal startup so a slow DNS /
    // offline hang never contends with the first PTY spawn on Windows
    // (a classic "Not Responding on launch" trigger). Honors the user's
    // "automatically check for updates" preference. The first check is
    // idle-friendly: skipped while the window is hidden and retried up to
    // 3× a minute later, so GitHub is only hit after the user has settled in.
    const autoCheck = autoCheckUpdates !== false;
    const retryTimers: ReturnType<typeof setTimeout>[] = [];
    const initialCheckTimer = setTimeout(function kick() {
      if (typeof document !== "undefined" && document.hidden) {
        if (retryTimers.length < MAX_HIDDEN_RETRIES) {
          retryTimers.push(setTimeout(kick, HIDDEN_RETRY_MS));
        }
        return;
      }
      if (autoCheck && shouldAutoCheck()) {
        void checkUpdatesRef.current(false);
      }
    }, FIRST_CHECK_DELAY_MS);
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (autoCheckUpdates !== false) {
        void checkUpdatesRef.current(false);
      }
    }, UPDATE_PERIODIC_MS);
    return () => {
      clearTimeout(initialCheckTimer);
      for (const t of retryTimers) clearTimeout(t);
      clearInterval(interval);
    };
  }, [autoCheckUpdates, checkUpdatesRef]);

  const viewUpdate = useCallback(() => {
    void openReleasePage(updateInfo?.releaseUrl ?? RELEASES_PAGE_URL);
  }, [updateInfo]);

  const downloadAndInstall = useCallback(async () => {
    const asset = updateInfo?.selectedAsset;
    if (!asset) {
      viewUpdate();
      return;
    }
    if (updateDownload.status === "downloading" || updateDownload.status === "installing") {
      return;
    }
    setUpdateDownload({
      status: "downloading",
      progress: 0,
      receivedBytes: 0,
      totalBytes: asset.size ?? null,
      localPath: null,
      message: null,
    });
    // Remember the target so the next launch can report success/failure.
    // Written first: the webview needs time to flush before Kai quits.
    if (updateInfo?.latestVersion)
      markUpdatePending(updateInfo.currentVersion, updateInfo.latestVersion);
    try {
      // After the download the installer runs in the background: the backend
      // closes Kai itself and a detached helper installs, deletes the
      // downloaded installer and reopens the new version.
      const result = await downloadAndInstallUpdate(
        asset,
        updateInfo?.releaseUrl ?? null,
        {
          onProgress: (received, total) => {
            setUpdateDownload((prev) => ({
              ...prev,
              status: "downloading",
              receivedBytes: received,
              totalBytes: total ?? prev.totalBytes,
              progress: total && total > 0 ? Math.min(100, (received / total) * 100) : null,
            }));
          },
          onInstalling: () =>
            setUpdateDownload((prev) => ({
              ...prev,
              status: "installing",
              progress: null,
              message: "Preparing the update…",
            })),
        },
        updateInfo?.assets
      );
      if (!result.unattended) clearUpdatePending();
      // Unattended: stay in "installing" — the install keeps running in the
      // background and Kai restarts by itself, so the bar must not look done.
      setUpdateDownload((prev) => ({
        ...prev,
        status: result.unattended ? "installing" : "installed",
        progress: result.unattended ? null : 100,
        message: result.message,
      }));
    } catch (err) {
      clearUpdatePending();
      const message = errorMessage(err);
      setUpdateDownload((prev) => ({
        ...prev,
        status: "error",
        message: `${message} You can still update manually from the release page.`,
      }));
      setLastError(`Update download: ${message}`);
    }
  }, [updateInfo, updateDownload.status, viewUpdate, setLastError]);

  const dismissUpdate = useCallback(() => {
    if (updateInfo?.latestVersion) {
      dismissVersion(updateInfo.latestVersion);
    }
    setUpdateBannerVisible(false);
  }, [updateInfo]);

  const remindLater = useCallback(() => setUpdateBannerVisible(false), []);

  const dismissUpdateOutcome = useCallback(() => setUpdateOutcome(null), []);

  return {
    appVersion,
    updateInfo,
    isCheckingUpdates,
    updateBannerVisible,
    updateDownload,
    updateOutcome,
    dismissUpdateOutcome,
    checkUpdates,
    viewUpdate,
    downloadAndInstall,
    dismissUpdate,
    remindLater,
  };
}
