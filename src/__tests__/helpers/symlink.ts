import fs from "fs";

/**
 * Create a symlink, or mark the running test as skipped (visible in the
 * Vitest report with a reason) when the OS refuses. On Windows this happens
 * without elevation or Developer Mode (`EPERM`): enable
 * Settings > System > For developers > Developer Mode, or run elevated, to
 * execute the symlink-dependent tests instead of skipping them.
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
    fs.symlinkSync(target, linkPath, type);
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
