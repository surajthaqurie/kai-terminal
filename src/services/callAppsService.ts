import { isTauriAvailable } from "./ptyService";

/** Limits mirrored by `call_watch::sanitize_extra_call_apps` on the Rust side. */
export const MAX_EXTRA_CALL_APPS = 32;
export const MIN_CALL_APP_LENGTH = 3;
export const MAX_CALL_APP_LENGTH = 64;

/**
 * Clean a user-supplied list of call-app fragments: strings only, trimmed and
 * lowercased, no control characters, 3-64 characters (anything shorter would
 * match almost every app name), de-duplicated, at most 32 entries.
 */
export function sanitizeCallApps(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const app = raw.trim().toLowerCase();
    if (app.length < MIN_CALL_APP_LENGTH || app.length > MAX_CALL_APP_LENGTH) continue;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(app)) continue;
    if (!out.includes(app)) out.push(app);
    if (out.length >= MAX_EXTRA_CALL_APPS) break;
  }
  return out;
}

/** Split a comma / newline separated settings field into a clean list. */
export function parseCallAppsInput(text: string): string[] {
  return sanitizeCallApps(text.split(/[,\n]/));
}

/** Render a stored list back into the settings field. */
export function formatCallAppsInput(apps: readonly string[] | undefined): string {
  return (apps ?? []).join(", ");
}

/** Tell the backend call watcher which extra apps count as calls. Best effort. */
export async function syncExtraCallApps(apps: readonly string[] | undefined): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_extra_call_apps_cmd", { apps: sanitizeCallApps(apps) });
  } catch {
    // The built-in list keeps working if the backend is unavailable.
  }
}
