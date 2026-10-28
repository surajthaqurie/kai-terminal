/**
 * Update-check service: compares the running app version against the latest
 * GitHub release tag and surfaces an "update available" alert.
 *
 * No Tauri updater plugin is required. Desktop + browser builds share the
 * same code path: a short-timeout `fetch` against the public GitHub
 * Releases API. All failures (offline, rate-limited, no releases yet)
 * resolve to "no update" so the UI never blocks on this.
 */

import packageJson from "../../package.json";

/** Used only when the Tauri runtime cannot report a version (browser build); always the packaged version. */
export const APP_VERSION_FALLBACK: string = packageJson.version;
const GITHUB_REPO = "surajthaqurie/kai-terminal";
/** Repo owner shown as the release author fallback ("by surajthaqurie"). */
const GITHUB_OWNER = GITHUB_REPO.split("/")[0] || "surajthaqurie";
const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
export const RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;

export const UPDATE_LAST_CHECK_KEY = "kai_update_last_check";
export const UPDATE_DISMISSED_KEY = "kai_update_dismissed_version";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h auto-check
export const UPDATE_PERIODIC_MS = 6 * 60 * 60 * 1000; // 6h re-check while open

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number | null;
  content_type: string | null;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  releaseAuthor: string | null;
  publishedAt: string | null;
  /** Raw installer assets attached to the GitHub release. */
  assets: ReleaseAsset[];
  /** Best installer for this OS/arch, or null when none matches. */
  selectedAsset: ReleaseAsset | null;
  /** Human label for the selected asset (e.g. "Windows installer (.exe)"). */
  selectedAssetLabel: string | null;
  /** Set when the check itself failed (offline, rate limit, no releases). */
  error: string | null;
  checkedAt: number;
}

export type UpdateDownloadStatus =
  "idle" | "downloading" | "ready" | "installing" | "installed" | "error";

export interface UpdateDownloadState {
  status: UpdateDownloadStatus;
  /** 0-100 while downloading (null when total size unknown). */
  progress: number | null;
  receivedBytes: number | null;
  totalBytes: number | null;
  /** Local temp path once the installer has downloaded. */
  localPath: string | null;
  /** Final human-readable message (launched / error). */
  message: string | null;
}

export const INITIAL_UPDATE_DOWNLOAD_STATE: UpdateDownloadState = {
  status: "idle",
  progress: null,
  receivedBytes: null,
  totalBytes: null,
  localPath: null,
  message: null,
};

/** Strip leading "v", whitespace, and build metadata for comparison. */
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^[vV]/, "").split("+")[0].split("-")[0];
}

function parseParts(v: string): number[] {
  return normalizeVersion(v)
    .split(".")
    .map((p) => {
      const n = parseInt(p.replace(/[^0-9]/g, ""), 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** True when `latest` is strictly newer than `current` (semver-ish). */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseParts(latest);
  const b = parseParts(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/** Best-effort app version: Tauri runtime when available, else fallback. */
export async function getAppVersion(): Promise<string> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const v = await invoke<string>("get_app_version");
    if (typeof v === "string" && v.trim()) return v.trim();
  } catch {
    // try getVersion from app plugin
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      const v = await getVersion();
      if (typeof v === "string" && v.trim()) return v.trim();
    } catch {
      // Browser/mock or old runtime: fall through to fallback.
    }
  }
  return APP_VERSION_FALLBACK;
}

interface GithubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  author?: { login?: string };
  assets?: Array<{
    name?: string;
    browser_download_url?: string;
    size?: number;
    content_type?: string;
  }>;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/vnd.github+json" },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks GitHub for a newer release. Never throws — failures resolve to
 * `{ updateAvailable: false, error }` so callers can silently skip.
 */
export async function checkForUpdates(
  currentVersion: string,
  opts?: { timeoutMs?: number; fetchFn?: typeof fetch }
): Promise<UpdateCheckResult> {
  const checkedAt = Date.now();
  const base: UpdateCheckResult = {
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: RELEASES_PAGE_URL,
    releaseName: null,
    // Author is only shown once a real release payload arrives (success
    // path below falls back to the repo owner). Error / not-checked states
    // keep it null so the Settings Updates tab never renders a stray
    // "by <owner>" next to a missing version.
    releaseAuthor: null,
    publishedAt: null,
    assets: [],
    selectedAsset: null,
    selectedAssetLabel: null,
    error: null,
    checkedAt,
  };
  try {
    const timeoutMs = opts?.timeoutMs ?? 8000;
    let res: Response;
    if (opts?.fetchFn) {
      res = await opts.fetchFn(LATEST_RELEASE_API_URL, {
        headers: { Accept: "application/vnd.github+json" },
      });
    } else {
      res = await fetchWithTimeout(LATEST_RELEASE_API_URL, timeoutMs);
    }
    if (res.status === 404) {
      // No releases published yet — not an error for the user.
      return { ...base, error: "No releases published yet" };
    }
    if (!res.ok) {
      return { ...base, error: `Update check failed (HTTP ${res.status})` };
    }
    const data = (await res.json()) as GithubRelease;
    const tag = typeof data.tag_name === "string" ? data.tag_name.trim() : "";
    if (!tag) return { ...base, error: "Release tag missing" };
    const latest = normalizeVersion(tag);
    const updateAvailable = isNewerVersion(tag, currentVersion);
    // Releases are published by CI, so the API author is usually
    // "github-actions[bot]" — never show a bot as the author. Real users
    // keep their login; bots (and missing authors) fall back to the repo
    // owner so Settings always credits a human.
    const rawLogin =
      data.author && typeof data.author.login === "string" ? data.author.login.trim() : "";
    const authorLogin = rawLogin && !/\[bot\]$/i.test(rawLogin) ? rawLogin : GITHUB_OWNER;
    const assets = parseReleaseAssets(data.assets);
    const selectedAsset = selectUpdateAsset(assets);
    return {
      ...base,
      latestVersion: latest,
      updateAvailable,
      releaseUrl:
        typeof data.html_url === "string" && data.html_url ? data.html_url : RELEASES_PAGE_URL,
      releaseName: typeof data.name === "string" ? data.name : tag,
      releaseAuthor: authorLogin,
      publishedAt: typeof data.published_at === "string" ? data.published_at : null,
      assets,
      selectedAsset,
      selectedAssetLabel: selectedAsset ? describeAsset(selectedAsset) : null,
    };
  } catch (err) {
    const msg =
      err instanceof DOMException && err.name === "AbortError"
        ? "Update check timed out"
        : err instanceof Error
          ? err.message
          : String(err);
    return { ...base, error: msg || "Update check failed" };
  }
}

// --- release asset selection (auto download + install) ---

function parseReleaseAssets(raw: GithubRelease["assets"]): ReleaseAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: ReleaseAsset[] = [];
  for (const a of raw) {
    const name = typeof a?.name === "string" ? a.name.trim() : "";
    const url = typeof a?.browser_download_url === "string" ? a.browser_download_url.trim() : "";
    if (!name || !url) continue;
    // Only installer artifacts — never source zips / checksums.
    if (!/\.(exe|msi|dmg|deb|AppImage)$/i.test(name)) continue;
    if (!/^https:\/\//.test(url)) continue;
    out.push({
      name,
      browser_download_url: url,
      size: typeof a?.size === "number" && Number.isFinite(a.size) ? a.size : null,
      content_type: typeof a?.content_type === "string" ? a.content_type : null,
    });
  }
  return out;
}

export type UpdatePlatform = "windows" | "macos" | "linux" | "unknown";

/** Best-effort OS detection for installer picking (testable via override). */
function detectUpdatePlatform(override?: {
  platform?: string;
  userAgent?: string;
}): UpdatePlatform {
  const plat = (
    override?.platform ??
    (typeof navigator !== "undefined" ? navigator.platform : "") ??
    ""
  ).toLowerCase();
  const ua = (
    override?.userAgent ??
    (typeof navigator !== "undefined" ? navigator.userAgent : "") ??
    ""
  ).toLowerCase();
  const combined = `${plat} ${ua}`;
  if (combined.includes("win")) return "windows";
  if (combined.includes("mac") || combined.includes("darwin")) return "macos";
  if (combined.includes("linux") || combined.includes("x11") || combined.includes("android"))
    return "linux";
  return "unknown";
}

function archHint(override?: { platform?: string; userAgent?: string }): "arm" | "x64" {
  const ua = (
    override?.userAgent ??
    (typeof navigator !== "undefined" ? navigator.userAgent : "") ??
    ""
  ).toLowerCase();
  if (ua.includes("arm") || ua.includes("aarch64") || combinedAppleSilicon()) return "arm";
  return "x64";
}

function combinedAppleSilicon(): boolean {
  try {
    if (typeof navigator === "undefined") return false;
    // Newer browsers expose high-entropy arch via userAgentData; best effort only.
    const data = (navigator as unknown as { userAgentData?: { platform?: string } })?.userAgentData;
    return (data?.platform ?? "").toLowerCase() === "macos";
  } catch {
    return false;
  }
}

/**
 * Picks the best installer for this OS/arch from a release asset list.
 * Windows prefers NSIS `.exe` (currentUser installMode) over MSI;
 * macOS prefers arm64 `.dmg`; Linux prefers `.deb` over `.AppImage`
 * (software-center flow; AppImage is the fallback).
 */
export function selectUpdateAsset(
  assets: ReleaseAsset[],
  override?: { platform?: string; userAgent?: string }
): ReleaseAsset | null {
  if (!assets.length) return null;
  const platform = detectUpdatePlatform(override);
  const arch = archHint(override);
  const lower = (s: string) => s.toLowerCase();
  const byName = (pred: (n: string) => boolean) => assets.find((a) => pred(lower(a.name))) ?? null;

  if (platform === "windows") {
    // Prefer 64-bit NSIS setup exe, then any setup exe, then MSI.
    return (
      byName(
        (n) =>
          n.endsWith(".exe") && n.includes("setup") && (n.includes("x64") || n.includes("x86_64"))
      ) ??
      byName((n) => n.endsWith(".exe") && n.includes("setup")) ??
      byName((n) => n.endsWith(".exe")) ??
      byName((n) => n.endsWith(".msi") && (n.includes("x64") || n.includes("en-us"))) ??
      byName((n) => n.endsWith(".msi"))
    );
  }
  if (platform === "macos") {
    const dmgs = assets.filter((a) => lower(a.name).endsWith(".dmg"));
    if (!dmgs.length) return null;
    if (arch === "arm") {
      return (
        dmgs.find((a) => /aarch64|arm64/i.test(a.name)) ??
        dmgs.find((a) => !/x86_64|x64|intel/i.test(a.name)) ??
        dmgs[0]
      );
    }
    return dmgs.find((a) => /x86_64|x64/i.test(a.name)) ?? dmgs[0];
  }
  if (platform === "linux") {
    const isArm = arch === "arm";
    const debs = assets.filter((a) => lower(a.name).endsWith(".deb"));
    const images = assets.filter((a) => lower(a.name).endsWith(".appimage"));
    const pickByArch = (list: ReleaseAsset[]): ReleaseAsset | null => {
      if (!list.length) return null;
      if (isArm) {
        return list.find((a) => /aarch64|arm64/i.test(a.name)) ?? list[0];
      }
      return (
        list.find((a) => /amd64|x86_64/i.test(a.name)) ??
        list.find((a) => !/aarch64|arm64/i.test(a.name)) ??
        list[0]
      );
    };
    // .deb first (managed install), AppImage as portable fallback.
    return pickByArch(debs) ?? pickByArch(images);
  }
  // Unknown platform: still offer something sensible rather than nothing.
  return (
    byName((n) => n.endsWith(".exe")) ??
    byName((n) => n.endsWith(".dmg")) ??
    byName((n) => n.endsWith(".deb")) ??
    assets[0]
  );
}

/** Short human label for the picked installer ("Windows installer (.exe)"). */
export function describeAsset(a: ReleaseAsset): string {
  const n = a.name.toLowerCase();
  if (n.endsWith(".exe")) return "Windows installer (.exe)";
  if (n.endsWith(".msi")) return "Windows installer (.msi)";
  if (n.endsWith(".dmg")) return "macOS disk image (.dmg)";
  if (n.endsWith(".deb")) return "Linux package (.deb)";
  if (n.endsWith(".appimage")) return "Linux AppImage";
  return a.name;
}

export interface DownloadAndInstallHooks {
  onProgress?: (received: number, total: number | null) => void;
  /** Download finished; the installer is being handed off to run in the background. */
  onInstalling?: () => void;
}

export interface InstallLaunchResult {
  message: string;
  /** True when a background helper installs after Kai exits and reopens it. */
  unattended: boolean;
}

/**
 * Swaps the default pick for the installer that matches how this copy of Kai
 * was installed (`hint` from the backend): an AppImage run must update the
 * AppImage (a `.deb` would add a second system copy) and an MSI install
 * under Program Files must update through the MSI (the per-user `.exe`
 * would add a second copy). Falls back to `asset` when no match exists.
 */
export function applyInstallHint(
  asset: ReleaseAsset,
  assets: ReleaseAsset[],
  hint: string | null
): ReleaseAsset {
  const flavour = hint === "appimage" ? /\.appimage$/i : hint === "msi" ? /\.msi$/i : null;
  if (!flavour) return asset;
  // Same CPU architecture as the default pick (which already matched this machine).
  const isArm = (name: string) => /aarch64|arm64/i.test(name);
  return assets.find((a) => flavour.test(a.name) && isArm(a.name) === isArm(asset.name)) ?? asset;
}

/**
 * Corrects the default pick to the CPU architecture of the running app
 * (`arch` from the backend: `x86_64`, `aarch64`, ...). The WebView user agent
 * cannot be trusted for this: WKWebView on Apple Silicon reports an Intel Mac
 * and WebView2 on Windows ARM64 reports x64, so a user-agent pick installs the
 * wrong build once a release carries both. Keeps `asset` when no installer of
 * the same type exists for that architecture.
 */
export function applyNativeArch(
  asset: ReleaseAsset,
  assets: ReleaseAsset[],
  arch: string | null
): ReleaseAsset {
  if (!arch) return asset;
  const isArmName = (name: string) => /aarch64|arm64/i.test(name);
  const wantArm = /^(aarch64|arm64)$/i.test(arch);
  if (isArmName(asset.name) === wantArm) return asset;
  const ext = asset.name.slice(asset.name.lastIndexOf(".")).toLowerCase();
  return (
    assets.find((a) => a.name.toLowerCase().endsWith(ext) && isArmName(a.name) === wantArm) ?? asset
  );
}

/**
 * Downloads the selected installer via the Tauri backend and installs it.
 * The whole flow runs in the background: the async backend streams the
 * file (progress events keep the UI bar moving), then hands it to a
 * detached helper. The backend closes Kai itself a moment later; the helper
 * installs, deletes the downloaded installer once it is finished with it and
 * reopens Kai on the new version — no manual close or restart.
 * Returns the backend's human-readable "next step" message and whether the
 * install is unattended (Kai restarts by itself) or left to the user.
 * Throws on failure so the UI can show the error + fall back to the
 * release page. In a browser build (no Tauri) it opens the release page
 * instead and returns a message to that effect.
 */
export async function downloadAndInstallUpdate(
  asset: ReleaseAsset,
  releaseUrl: string | null,
  hooks?: DownloadAndInstallHooks,
  assets: ReleaseAsset[] = [asset]
): Promise<InstallLaunchResult> {
  const { isTauriAvailable } = await import("./ptyService");
  if (!isTauriAvailable()) {
    await openReleasePage(releaseUrl || RELEASES_PAGE_URL);
    return {
      message:
        "Opened the release page in your browser — download the installer for your OS to update.",
      unattended: false,
    };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const unlistenProgress: Array<() => void> = [];
  try {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const off = await listen<{ received: number; total: number | null }>(
        "kai-update-progress",
        (e) => hooks?.onProgress?.(e.payload.received, e.payload.total ?? null)
      );
      unlistenProgress.push(off);
    } catch {
      // Progress events are best-effort; download still works without them.
    }
    let target = asset;
    try {
      const arch = await invoke<string | null>("get_update_arch_cmd");
      target = applyNativeArch(target, assets, arch);
    } catch {
      // Best-effort; the user-agent based pick still installs.
    }
    try {
      const hint = await invoke<string | null>("get_update_install_hint_cmd");
      target = applyInstallHint(target, assets, hint);
    } catch {
      // Hint is best-effort; the default pick still installs.
    }
    const downloadAndLaunch = async (): Promise<InstallLaunchResult> => {
      const dl = await invoke<{ path: string; filename: string; bytes: number }>(
        "download_update_asset_cmd",
        { url: target.browser_download_url, filename: target.name }
      );
      hooks?.onInstalling?.();
      return await invoke<InstallLaunchResult>("launch_update_installer_cmd", { path: dl.path });
    };
    try {
      return await downloadAndLaunch();
    } catch (err) {
      // The saved installer vanished between download and launch (antivirus
      // quarantine, a temp-dir cleaner). Fetch it once more instead of making
      // the user press the button again; a second failure is reported.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/installer not found/i.test(msg)) throw err;
      return await downloadAndLaunch();
    }
  } finally {
    for (const off of unlistenProgress) {
      try {
        off();
      } catch {
        // ignore
      }
    }
  }
}

// --- update outcome (survives the restart the installer causes) ---

export const UPDATE_PENDING_KEY = "kai_update_pending";
/** An update that has not reported back after this long is forgotten. */
const UPDATE_PENDING_MAX_AGE_MS = 30 * 60 * 1000;

export interface UpdateOutcome {
  kind: "updated" | "failed";
  version: string;
}

/**
 * Remembers that an in-app update was started so the next launch can tell
 * the user whether it worked. Written BEFORE the download: the webview needs
 * time to flush storage before Kai quits for the install.
 */
export function markUpdatePending(from: string, to: string, now = Date.now()): void {
  try {
    localStorage.setItem(
      UPDATE_PENDING_KEY,
      JSON.stringify({ from: normalizeVersion(from), to: normalizeVersion(to), at: now })
    );
  } catch {
    // Storage unavailable: the update still installs, only the result notice is lost.
  }
}

export function clearUpdatePending(): void {
  try {
    localStorage.removeItem(UPDATE_PENDING_KEY);
  } catch {
    // ignore
  }
}

/**
 * Called once per launch: compares the running version with the version the
 * last in-app update targeted. `null` when no update was pending (or it is
 * stale). Always clears the marker.
 */
export function consumeUpdateOutcome(
  currentVersion: string,
  now = Date.now()
): UpdateOutcome | null {
  try {
    const raw = localStorage.getItem(UPDATE_PENDING_KEY);
    if (!raw) return null;
    localStorage.removeItem(UPDATE_PENDING_KEY);
    const data = JSON.parse(raw) as { from?: unknown; to?: unknown; at?: unknown };
    if (typeof data.to !== "string" || typeof data.at !== "number") return null;
    if (now - data.at > UPDATE_PENDING_MAX_AGE_MS || data.at > now + 60_000) return null;
    const current = normalizeVersion(currentVersion);
    if (current === data.to || isNewerVersion(current, data.to)) {
      return { kind: "updated", version: current };
    }
    return { kind: "failed", version: data.to };
  } catch {
    return null;
  }
}

// --- persistence helpers (dismiss / throttle) ---

function getLastCheckTime(now = Date.now()): number {
  try {
    const raw = localStorage.getItem(UPDATE_LAST_CHECK_KEY);
    const n = raw ? parseInt(raw, 10) : 0;
    if (!Number.isFinite(n) || n <= 0 || n > now + 60_000) return 0;
    return n;
  } catch {
    return 0;
  }
}

export function recordCheckTime(now = Date.now()): void {
  try {
    localStorage.setItem(UPDATE_LAST_CHECK_KEY, String(now));
  } catch {
    // ignore quota / private mode
  }
}

export function shouldAutoCheck(now = Date.now(), intervalMs = UPDATE_CHECK_INTERVAL_MS): boolean {
  const last = getLastCheckTime(now);
  if (!last) return true;
  return now - last >= intervalMs;
}

export function getDismissedVersion(): string | null {
  try {
    return localStorage.getItem(UPDATE_DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function dismissVersion(version: string): void {
  try {
    localStorage.setItem(UPDATE_DISMISSED_KEY, version);
  } catch {
    // ignore
  }
}

export function isDismissed(version: string | null): boolean {
  if (!version) return false;
  return getDismissedVersion() === normalizeVersion(version);
}

/** Opens the release page in the OS browser (desktop) or a new tab (web). */
export async function openReleasePage(url: string): Promise<void> {
  return openExternalUrl(url || RELEASES_PAGE_URL);
}

/** Opens a URL in the OS browser (desktop) or a new tab (web).
 *
 * Desktop note: the app ships no opener plugin, so `window.open` cannot
 * reach the system browser from the Tauri WebView — "View release" and the
 * music player's "Open in browser" silently did nothing on every OS. Inside
 * Tauri this goes through the allow-listed `open_external_url_cmd` backend
 * command instead (releases page and exact YouTube link shapes only).
 */
async function openExternalUrl(target: string): Promise<void> {
  try {
    const { isTauriAvailable } = await import("./ptyService");
    if (isTauriAvailable()) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("open_external_url_cmd", { url: target });
        return;
      } catch {
        // Backend refused/failed (e.g. non-allow-listed URL in tests):
        // fall through to window.open below.
      }
    }
  } catch {
    // Browser/mock: fall through to window.open below.
  }
  try {
    const opened = window.open(target, "_blank", "noopener,noreferrer");
    if (opened) return;
  } catch {
    // fall through to location navigation
  }
  try {
    window.location.href = target;
  } catch {
    // last resort: nothing else we can do headlessly
  }
}
