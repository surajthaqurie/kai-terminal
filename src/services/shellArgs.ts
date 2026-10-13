import type { ShellProfile } from "../types/terminal";

/**
 * True for Windows PowerShell / PowerShell Core binaries (any directory,
 * case-insensitive, with or without `.exe`). Mirrors the backend check in
 * `src-tauri/src/pty.rs` so frontend arg injection targets the same shells.
 */
export function isPowerShellPath(shellPath: string | undefined): boolean {
  if (!shellPath) return false;
  const lower = shellPath.toLowerCase();
  const file = lower.split(/[/\\]/).pop() ?? lower;
  const base = file.endsWith(".exe") ? file.slice(0, -4) : file;
  return base === "powershell" || base === "pwsh";
}

/**
 * Applies the "skip shell profile" fast-launch option to a shell profile.
 *
 * When enabled and the shell is PowerShell/pwsh, ensures `-NoLogo` and
 * `-NoProfile` are present (deduped case-insensitively), skipping
 * `$PROFILE` scripts (oh-my-posh, conda init) that dominate cold-start time
 * on Windows. Returns the same object when no change is needed; non-PowerShell
 * shells are returned untouched (`-NoProfile` is PowerShell-only).
 */
export function withSkipProfileArgs(
  shell: ShellProfile | undefined,
  skipProfile: boolean
): ShellProfile | undefined {
  if (!shell || !skipProfile || !isPowerShellPath(shell.path)) return shell;
  const args = [...(shell.args ?? [])];
  const has = (flag: string) => args.some((a) => a.toLowerCase() === flag.toLowerCase());
  if (!has("-NoLogo")) args.push("-NoLogo");
  if (!has("-NoProfile")) args.push("-NoProfile");
  return { ...shell, args };
}
