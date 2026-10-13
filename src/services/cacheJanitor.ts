/**
 * Install/update cache janitor.
 *
 * On every version change (fresh install counts as a change from "unknown"),
 * removes stale `kai_*` / `terminal_*` localStorage entries left by older
 * builds while preserving settings, sessions, and other configuration.
 *
 * Never calls `localStorage.clear()`: foreign keys (other apps, WebView
 * internals) and every allowlisted key survive. In-memory caches (git,
 * autocomplete buffers) die with the process and need no handling; Vite
 * content-hashed assets already bypass the HTTP cache on update.
 */

export const CACHE_JANITOR_VERSION_KEY = "kai_cache_janitor_version";

/** Exact keys that must survive an update. Mirrors the constants in each service. */
const PRESERVED_EXACT: ReadonlySet<string> = new Set([
  // settingsService.ts
  "kai_user_settings",
  "terminal_user_settings",
  // workspaces.ts + App.tsx LAYOUT_KEY
  "kai_workspaces_v1",
  "terminal_workspaces_v1",
  "terminal_tab_layout_v1",
  // projectService.ts
  "kai_recent_projects",
  "terminal_recent_projects",
  "kai_active_project",
  "kai_active_mode",
  // updateService.ts
  "kai_update_last_check",
  "kai_update_dismissed_version",
  // autocomplete.ts
  "kai_cmd_history_v1",
  // aiCliService.ts
  "kai_custom_ai_clis",
  "terminal_custom_ai_clis",
  // autostartService.ts (browser/mock mode)
  "kai_autostart_enabled_mock",
]);

/** Key prefixes whose entries must survive an update (per-project settings). */
const PRESERVED_PREFIXES: readonly string[] = [
  "kai_project_settings_",
  "terminal_project_settings_",
];

export interface CacheJanitorReport {
  /** App version the janitor ran for (or `"unknown"` when empty). */
  appVersion: string;
  /** True when a version change was detected and a sweep ran. */
  ran: boolean;
  /** Stale keys that were removed (omits the version marker itself). */
  removed: string[];
}

/**
 * Runs the janitor once per app version. Returns a report; never throws and
 * never blocks startup — storage failures degrade to a no-op report.
 */
export function runCacheJanitor(appVersion: string): CacheJanitorReport {
  const version = (appVersion || "").trim() || "unknown";
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(CACHE_JANITOR_VERSION_KEY);
  } catch {
    return { appVersion: version, ran: false, removed: [] };
  }
  if (stored === version) {
    return { appVersion: version, ran: false, removed: [] };
  }
  const removed: string[] = [];
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    for (const k of keys) {
      if (k === CACHE_JANITOR_VERSION_KEY) continue;
      const ours = k.startsWith("kai_") || k.startsWith("terminal_");
      if (!ours) continue;
      if (PRESERVED_EXACT.has(k)) continue;
      if (PRESERVED_PREFIXES.some((p) => k.startsWith(p))) continue;
      try {
        localStorage.removeItem(k);
        removed.push(k);
      } catch {
        // Keep sweeping: one undeletable key must not protect the rest.
      }
    }
  } catch {
    // Enumeration failure: still stamp the version below so we retry
    // next launch instead of erroring the startup path.
  }
  try {
    localStorage.setItem(CACHE_JANITOR_VERSION_KEY, version);
  } catch {
    // Ignore quota / private mode.
  }
  return { appVersion: version, ran: true, removed };
}
