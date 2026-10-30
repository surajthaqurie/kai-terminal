import type { ShellProfile } from "../types/terminal";
import { withSkipProfileArgs } from "./shellArgs";

/** Same binary regardless of slash style or Windows letter case. */
export function sameShellPath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.trim().replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The shell a pane runs. A pane remembers only the binary it was opened with
 * (`shellPath`, also what a saved session restores), so this maps it back to a
 * full profile (name, args, WSL flag):
 * - no recorded shell, or one no longer installed -> the app-wide shell
 *   (`fallback`, which already carries the custom path and fast-launch flags);
 * - the app-wide shell's own binary -> `fallback` itself;
 * - any other detected shell -> that profile, with the fast-launch flags applied.
 */
export function resolvePaneShell(
  shellPath: string | undefined,
  shells: ShellProfile[],
  fallback: ShellProfile | undefined,
  skipProfile: boolean
): ShellProfile | undefined {
  if (!shellPath) return fallback;
  if (fallback && sameShellPath(fallback.path, shellPath)) return fallback;
  const profile = shells.find((s) => sameShellPath(s.path, shellPath));
  return profile ? withSkipProfileArgs(profile, skipProfile) : fallback;
}
