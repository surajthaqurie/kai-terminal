import fs from "fs";
import os from "os";
import path from "path";

/**
 * A temp folder only this user can enter, for pictures Kai saves (a pasted
 * screenshot, an image opened from the chat).
 *
 * `/tmp` is shared on Linux and macOS, and a predictable name there lets
 * another user plant a symlink or a folder first, so a later write lands
 * somewhere it should not. The folder is therefore per user, created `0700`,
 * and used only if it really is a plain folder with no access for anyone else;
 * otherwise a fresh random `0700` folder is made instead. Windows temp folders
 * are already per user.
 */
export interface TempDirDeps {
  /** Where to look first; default: `$XDG_RUNTIME_DIR` (private to the user), else the OS temp folder. */
  base?: string;
  platform?: NodeJS.Platform;
  uid?: number | null;
}

export function privateTempDir(name: string, deps: TempDirDeps = {}): string {
  const platform = deps.platform ?? process.platform;
  const uid =
    deps.uid !== undefined
      ? deps.uid
      : typeof process.getuid === "function"
        ? process.getuid()
        : null;
  const base = deps.base ?? process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
  const dir = path.join(base, uid === null ? name : `${name}-${uid}`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (platform === "win32") return dir;
    const st = fs.lstatSync(dir);
    const ours = uid === null || st.uid === uid;
    if (st.isDirectory() && !st.isSymbolicLink() && ours && (st.mode & 0o077) === 0) return dir;
  } catch {
    // fall through to a fresh private folder
  }
  return fs.mkdtempSync(path.join(base, `${name}-`));
}
