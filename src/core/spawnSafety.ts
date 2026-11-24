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

/**
 * Turns off the current-directory executable lookup for THIS process, which is
 * what `spawn("git")`, `spawn("cmd.exe")`, `execFileSync("powershell")` etc.
 * actually need.
 *
 * libuv resolves the executable inside the parent process, in the working
 * directory first, and honours `NoDefaultCurrentDirectoryInExePath` only when
 * it is set in the parent's OWN environment. The copy {@link noCwdLookupEnv}
 * puts in a child's `env` option protects only what that child launches (for
 * example `cmd.exe` resolving `az`). Verified on Windows: with the variable
 * unset, a planted `powershell.exe` / `git.exe` / `cmd.exe` in the current
 * folder ran instead of the real tool; set at runtime in the parent, the real
 * tool ran.
 *
 * Call once, first thing, in every process entry point that may run inside an
 * untrusted project folder (`kai` CLI, `kai mcp`, the Shared Agent engine).
 * No-op on other platforms. Returns true when it changed the environment.
 */
export function hardenExecutableLookup(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== "win32") return false;
  if (env.NoDefaultCurrentDirectoryInExePath === "1") return false;
  env.NoDefaultCurrentDirectoryInExePath = "1";
  return true;
}

/**
 * Absolute path of a fixed Windows system tool (`cmd.exe`, `taskkill.exe`,
 * `where.exe`, `powershell.exe`, `rundll32.exe`, `reg.exe`), so its location
 * never depends on PATH or the working directory. Other platforms get the bare
 * name unchanged.
 */
export function systemToolPath(
  name: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform !== "win32") return name;
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  const exe = /\.exe$/i.test(name) ? name : `${name}.exe`;
  const sub = /^powershell\.exe$/i.test(exe) ? "System32\\WindowsPowerShell\\v1.0" : "System32";
  return `${root.replace(/[\\/]+$/, "")}\\${sub}\\${exe}`;
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
