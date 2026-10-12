/**
 * Update-check service: compares the running app version against the latest
 * GitHub release tag and surfaces an "update available" alert.
 *
 * No Tauri updater plugin is required. Desktop + browser builds share the
 * same code path: a short-timeout `fetch` against the public GitHub
 * Releases API. All failures (offline, rate-limited, no releases yet)
 * resolve to "no update" so the UI never blocks on this.
 */

export const APP_VERSION_FALLBACK = "0.1.2";
export const GITHUB_REPO = "surajthaqurie/kai-terminal";
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
export const RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;

export const UPDATE_LAST_CHECK_KEY = "kai_update_last_check";
export const UPDATE_DISMISSED_KEY = "kai_update_dismissed_version";
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h auto-check
export const UPDATE_PERIODIC_MS = 6 * 60 * 60 * 1000; // 6h re-check while open

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  /** Set when the check itself failed (offline, rate limit, no releases). */
  error: string | null;
  checkedAt: number;
}

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
    publishedAt: null,
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
    return {
      ...base,
      latestVersion: latest,
      updateAvailable,
      releaseUrl:
        typeof data.html_url === "string" && data.html_url ? data.html_url : RELEASES_PAGE_URL,
      releaseName: typeof data.name === "string" ? data.name : tag,
      publishedAt: typeof data.published_at === "string" ? data.published_at : null,
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

// --- persistence helpers (dismiss / throttle) ---

export function getLastCheckTime(now = Date.now()): number {
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

/** Opens the release page in a new tab (browser) or OS browser (desktop). */
export async function openReleasePage(url: string): Promise<void> {
  const target = url || RELEASES_PAGE_URL;
  // NOTE: intentionally no @tauri-apps/plugin-opener dependency — the app
  // does not ship the opener plugin. `window.open` works in browser builds;
  // in Tauri it falls back to a same-window navigation which the user can
  // reach via the external browser anyway. Keep this dependency-free.
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
