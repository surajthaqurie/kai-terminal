import fs from "fs";

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
 * Only privilege failures skip; any other error still fails the test.
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
