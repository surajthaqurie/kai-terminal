import path from "path";

/**
 * Windows resolves a bare command name against the CURRENT DIRECTORY before
 * PATH (cmd.exe, and `where.exe` by design). Kai's MCP server and CLI run
 * inside whatever project folder the user opened, so a cloned repo containing
 * `gopls.cmd`, `az.bat` or `kai.exe` would otherwise be executed just because
 * Kai probed for that tool.
 *
 * `NoDefaultCurrentDirectoryInExePath=1` switches that lookup off for cmd.exe
 * and the CreateProcess search; it does not affect `where.exe`, which is why
 * {@link dropCwdHits} exists. Other platforms never search the cwd, so their
 * environment is returned untouched.
 */
export function noCwdLookupEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return process.platform === "win32" ? { ...base, NoDefaultCurrentDirectoryInExePath: "1" } : base;
}

const norm = (p: string) =>
  path.win32
    .normalize(p)
    .replace(/[\\/]+$/, "")
    .toLowerCase();

/**
 * Remove `where.exe` results that sit in the current directory, unless the user
 * really has that directory on PATH. `where` lists the cwd first even when it is
 * not on PATH, which would let a planted binary win the lookup.
 */
export function dropCwdHits(
  found: string[],
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (process.platform !== "win32") return found;
  const here = norm(cwd);
  const onPath = (env.PATH ?? env.Path ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => norm(dir) === here);
  if (onPath) return found;
  return found.filter((hit) => norm(path.win32.dirname(hit)) !== here);
}
