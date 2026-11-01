import fs from "fs";
import os from "os";
import path from "path";

/**
 * Create a symlink, or mark the running test as skipped (visible in the
 * Vitest report with a reason) when the OS refuses.
 *
 * Directory targets on Windows are created as directory junctions, which need
 * no elevation or Developer Mode and behave like a directory symlink for
 * everything these tests probe (`lstat`, `realpath`, directory walks). File
 * symlinks have no such fallback: without Developer Mode or elevation Windows
 * refuses them (`EPERM`) and the test is skipped with a reason. Enable
 * Settings > System > For developers > Developer Mode, or run elevated, to
 * execute those. Linux and macOS never skip.
 *
 * A link can also be created yet be impossible to follow: some Windows builds
 * refuse to traverse a junction a standard user made ("The path cannot be
 * traversed because it contains an untrusted mount point", surfaced by Node as
 * `UNKNOWN`) in every process, so `stat`, `realpath` and `readdir` through it all
 * fail. That is a property of the machine, not of the code under test, so it
 * skips too, with the reason.
 *
 * Only these environment failures skip; any other error still fails the test.
 */
export function symlinkOrSkip(
  ctx: { skip: () => void },
  target: string,
  linkPath: string,
  type?: "file" | "dir" | "junction"
): void {
  try {
    fs.symlinkSync(target, linkPath, resolveLinkType(target, type));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS" || code === "ENOTSUP") {
      console.warn(
        `[symlink skip] symlinks not permitted (${code}); enable Windows Developer Mode or run elevated to run this test`
      );
      ctx.skip();
    }
    throw err;
  }
  if (!isFollowable(linkPath)) {
    try {
      fs.unlinkSync(linkPath);
    } catch {
      /* best effort: the test's own temp-dir cleanup removes it */
    }
    console.warn(
      "[symlink skip] this OS created the link but will not follow it (untrusted mount point policy)"
    );
    ctx.skip();
  }
}

/**
 * Whether directory links can be created and followed on this machine. Always
 * true off Windows. Use it to `skipIf` a test that must otherwise never skip.
 */
export function directoryLinksFollowable(): boolean {
  if (process.platform !== "win32") return true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-linkprobe-"));
  try {
    const target = path.join(dir, "real");
    fs.mkdirSync(target);
    const link = path.join(dir, "link");
    try {
      fs.symlinkSync(target, link, "junction");
    } catch {
      return false;
    }
    return isFollowable(link);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A dangling link is a legitimate state (ENOENT); any other failure to stat
// the link means the OS will not traverse it.
function isFollowable(linkPath: string): boolean {
  try {
    fs.statSync(linkPath);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function resolveLinkType(
  target: string,
  type: "file" | "dir" | "junction" | undefined
): "file" | "dir" | "junction" | undefined {
  if (process.platform !== "win32" || type === "file" || type === "junction") return type;
  try {
    return fs.statSync(target).isDirectory() ? "junction" : type;
  } catch {
    return type;
  }
}
