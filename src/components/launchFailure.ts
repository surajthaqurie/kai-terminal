/** Operating system families with different shell startup files. */
export type HostOs = "windows" | "mac" | "linux";

export function detectHostOs(): HostOs {
  try {
    const platform = navigator.platform ?? "";
    const agent = navigator.userAgent ?? "";
    if (/^win/i.test(platform) || /Windows/i.test(agent)) return "windows";
    if (/mac/i.test(platform) || /Mac OS X|Macintosh/i.test(agent)) return "mac";
  } catch {
    // No navigator (tests, workers): Linux wording is the most generic.
  }
  return "linux";
}

/**
 * What to try when a shell fails to start, for the OS the app runs on: a
 * PowerShell profile tip means nothing on macOS or Linux.
 */
export function launchFailureTip(os: HostOs): string {
  switch (os) {
    case "windows":
      return "Check your PowerShell profile, or choose another shell (e.g. Command Prompt) in Settings → Shell.";
    case "mac":
      return "Check your shell startup files (~/.zprofile, ~/.zshrc), or choose another shell in Settings → Shell.";
    default:
      return "Check your shell startup files (~/.bashrc, ~/.profile), or choose another shell in Settings → Shell.";
  }
}
