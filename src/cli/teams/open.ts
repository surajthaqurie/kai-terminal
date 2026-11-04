import { spawn } from "child_process";

/**
 * Open a local file (an image the user clicked) in the system's default app.
 * Arguments are passed directly, never through a shell, so a file name cannot
 * run anything. Windows uses `rundll32 url.dll,FileProtocolHandler`, which opens
 * a file by its association the same way a double-click does.
 */
export function openPath(file: string, platform: NodeJS.Platform = process.platform): void {
  const [cmd, args] =
    platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", file]]
      : platform === "darwin"
        ? ["open", [file]]
        : ["xdg-open", [file]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {
      // No opener available: the chat already told the user where the file is.
    });
    child.unref();
  } catch {
    // Same.
  }
}
