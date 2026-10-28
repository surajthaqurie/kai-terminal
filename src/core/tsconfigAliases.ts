import * as fs from "node:fs";
import * as path from "node:path";
import type { PathAliases } from "./importResolver";

/**
 * Reads `compilerOptions.paths` / `baseUrl` from the project's `tsconfig.json`
 * (or `jsconfig.json`), following `extends` (relative paths, packages found in a
 * `node_modules` inside the project, and arrays of either), so import aliases
 * such as `@/utils` resolve to indexed files.
 *
 * Reading is bounded and confined to the project root: only regular files
 * (no symlinks, except a package config that really lives inside the root), at
 * most `MAX_CONFIG_BYTES` each, at most `MAX_EXTENDS_DEPTH` levels of `extends`,
 * and an `extends` that leaves the root is ignored. A config that cannot be read
 * or parsed yields no aliases, never an error: the affected imports then stay
 * `non-relative`, exactly as before.
 *
 * Each file uses the nearest config above it (`buildAliasLookup`), as TypeScript
 * does, so packages of a monorepo get their own aliases. A nearer config without
 * `paths`/`baseUrl` means no aliases for its files; it does not fall back to the
 * root config unless it `extends` it. The exception is a solution-style config
 * (no aliases of its own, `references` to others): a file takes the aliases of the
 * first referenced config whose `files`/`include`/`exclude` cover it (their own,
 * not inherited ones; globs support `*`, `?` and `**`). Other config names
 * (`tsconfig.app.json`) are used only through `extends` or `references`.
 */

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_EXTENDS_DEPTH = 4;
const MAX_ALIAS_PATTERNS = 200;
const MAX_EXTENDS_PER_CONFIG = 8;
const MAX_REFERENCES = 16;
const MAX_GLOB_ENTRIES = 50;
const MAX_GLOB_LENGTH = 512;
const MAX_TSCONFIGS = 64;
const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"] as const;

/** Remove `//` and block comments and trailing commas, leaving string contents alone. */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < text.length) {
        out += next;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

interface RawConfig {
  extends?: unknown;
  compilerOptions?: { baseUrl?: unknown; paths?: unknown };
  references?: unknown;
  files?: unknown;
  include?: unknown;
  exclude?: unknown;
}

function readConfig(file: string): RawConfig | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return null;
    const parsed: unknown = JSON.parse(stripJsonComments(fs.readFileSync(file, "utf8")));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as RawConfig)
      : null;
  } catch {
    return null;
  }
}

function insideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function toRootRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** True when `file` resolves (symlinks followed) to somewhere inside the real project root. */
function realInsideRoot(root: string, file: string): boolean {
  try {
    return insideRoot(fs.realpathSync(root), fs.realpathSync(file));
  } catch {
    return false;
  }
}

/** A relative `extends` value to an existing config file inside `root`, or null. */
function resolveRelativeExtends(root: string, fromFile: string, value: string): string | null {
  const base = path.resolve(path.dirname(fromFile), value);
  for (const candidate of [base, `${base}.json`]) {
    if (insideRoot(root, candidate) && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * A package `extends` (`@tsconfig/node20`, `my-config/tsconfig.base.json`) found in
 * a `node_modules` directory at or above the config but not above the project
 * root, and only when the file really lives inside the root (a symlink out of it
 * is refused).
 */
function resolvePackageExtends(root: string, fromFile: string, value: string): string | null {
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) return null;
  let dir = path.dirname(fromFile);
  while (insideRoot(root, dir)) {
    const base = path.join(dir, "node_modules", value);
    for (const candidate of [base, `${base}.json`, path.join(base, "tsconfig.json")]) {
      if (isFile(candidate) && realInsideRoot(root, candidate)) return candidate;
    }
    if (path.resolve(dir) === path.resolve(root)) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Every config an `extends` value (a string or, since TS 5, an array of strings) names, in order. */
function resolveExtends(root: string, fromFile: string, value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const v of values.slice(0, MAX_EXTENDS_PER_CONFIG)) {
    if (typeof v !== "string" || v === "") continue;
    const resolved = v.startsWith(".")
      ? resolveRelativeExtends(root, fromFile, v)
      : resolvePackageExtends(root, fromFile, v);
    if (resolved) out.push(resolved);
  }
  return out;
}

/** `tsconfig.json`, else `jsconfig.json`, in a directory (root-relative posix, `""` = root); null when neither exists. */
function configInDir(root: string, dir: string): string | null {
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(root, dir, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function aliasesFromConfigFile(root: string, entry: string): PathAliases | null {
  let baseUrl: string | null = null;
  let baseUrlSet = false;
  let rawPaths: Record<string, unknown> | null = null;
  let pathsDir = root;

  // The config's own options win, then its `extends` (the last entry of an array
  // before the earlier ones, as TypeScript merges them): depth-first, keeping the
  // first definition of each option.
  const seen = new Set<string>();
  const stack: Array<{ file: string; depth: number }> = [{ file: entry, depth: 0 }];
  while (stack.length > 0) {
    const { file: current, depth } = stack.pop() as { file: string; depth: number };
    if (depth > MAX_EXTENDS_DEPTH || seen.has(current)) continue;
    seen.add(current);
    const config = readConfig(current);
    if (!config) continue;
    const configDir = path.dirname(current);
    const options = config.compilerOptions;
    if (options && !baseUrlSet && typeof options.baseUrl === "string") {
      baseUrlSet = true;
      const abs = path.resolve(configDir, options.baseUrl);
      baseUrl = insideRoot(root, abs) ? toRootRelative(root, abs) : null;
    }
    if (
      options &&
      rawPaths === null &&
      options.paths &&
      typeof options.paths === "object" &&
      !Array.isArray(options.paths)
    ) {
      rawPaths = options.paths as Record<string, unknown>;
      pathsDir = configDir;
    }
    for (const parent of resolveExtends(root, current, config.extends)) {
      stack.push({ file: parent, depth: depth + 1 });
    }
  }

  // `paths` entries are relative to `baseUrl` when one is in effect (wherever
  // it was declared), else to the config that declared them.
  const anchor = baseUrl !== null ? path.resolve(root, baseUrl) : pathsDir;
  const entries: Array<{ pattern: string; targets: string[] }> = [];
  for (const [pattern, raw] of Object.entries(rawPaths ?? {})) {
    if (entries.length >= MAX_ALIAS_PATTERNS) break;
    if (!Array.isArray(raw)) continue;
    const targets: string[] = [];
    for (const t of raw) {
      if (typeof t !== "string") continue;
      const abs = path.resolve(anchor, t);
      if (insideRoot(root, abs)) targets.push(toRootRelative(root, abs));
    }
    if (targets.length > 0) entries.push({ pattern, targets });
  }

  if (baseUrl === null && entries.length === 0) return null;
  return { baseUrl, paths: entries };
}

export function loadTsPathAliases(root: string, configDir = ""): PathAliases | null {
  const entry = configInDir(root, configDir) ?? path.join(root, configDir, "tsconfig.json");
  return aliasesFromConfigFile(root, entry);
}

// ---------------------------------------------------------------------------
// Project references: which referenced config owns a file
// ---------------------------------------------------------------------------

/** `*` and `?` do not cross `/`; `**` does. At most `MAX_GLOB_STARS` `**` per pattern, to bound backtracking. */
const MAX_GLOB_STARS = 4;

function globToRegExp(glob: string): RegExp | null {
  if (glob.length > MAX_GLOB_LENGTH || (glob.match(/\*\*/g) ?? []).length > MAX_GLOB_STARS) {
    return null;
  }
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * A tsconfig `files`/`include`/`exclude` entry as a regular expression over
 * root-relative posix paths, or null when it cannot be expressed (escapes the
 * root, too long). An entry whose last segment has no wildcard and no extension is
 * a directory (`src` means everything below `src`), as in TypeScript.
 */
function configGlob(dirRel: string, entry: string): RegExp | null {
  let pattern = entry.replace(/\\/g, "/").replace(/^\.\//, "");
  const segments: string[] = [];
  for (const seg of (dirRel ? `${dirRel}/${pattern}` : pattern).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else segments.push(seg);
  }
  pattern = segments.join("/");
  const last = segments[segments.length - 1] ?? "";
  if (last === "**") pattern += "/*";
  else if (!/[*?]/.test(last) && !last.includes(".")) pattern += "/**/*";
  return globToRegExp(pattern);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string").slice(0, MAX_GLOB_ENTRIES);
}

/** Whether a referenced config's own `files` / `include` / `exclude` (default: everything below it) cover a file. */
function configCoverage(dirRel: string, config: RawConfig): (rel: string) => boolean {
  const files = stringList(config.files);
  const include = stringList(config.include) ?? (files ? [] : ["**/*"]);
  const exclude = stringList(config.exclude) ?? [];
  const exact = new Set(
    (files ?? []).map((f) => {
      const parts: string[] = [];
      for (const seg of (dirRel ? `${dirRel}/${f}` : f).replace(/\\/g, "/").split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") parts.pop();
        else parts.push(seg);
      }
      return parts.join("/");
    })
  );
  const compile = (list: string[]): RegExp[] =>
    list.flatMap((g) => {
      const re = configGlob(dirRel, g);
      return re ? [re] : [];
    });
  const includes = compile(include);
  const excludes = compile(exclude);
  return (rel: string): boolean => {
    if (exact.has(rel)) return true;
    if (excludes.some((re) => re.test(rel))) return false;
    return includes.some((re) => re.test(rel));
  };
}

interface ReferencedConfig {
  aliases: PathAliases | null;
  covers: (rel: string) => boolean;
}

/** The configs a solution-style `tsconfig.json` references (a file, or a directory holding `tsconfig.json`). */
function loadReferences(root: string, entry: string): ReferencedConfig[] {
  const config = readConfig(entry);
  if (!config || !Array.isArray(config.references)) return [];
  const out: ReferencedConfig[] = [];
  for (const ref of config.references.slice(0, MAX_REFERENCES)) {
    const value = ref && typeof ref === "object" ? (ref as { path?: unknown }).path : undefined;
    if (typeof value !== "string" || value === "") continue;
    let file = path.resolve(path.dirname(entry), value);
    if (!insideRoot(root, file)) continue;
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, "tsconfig.json");
    } catch {
      continue;
    }
    const referenced = readConfig(file);
    if (!referenced) continue;
    out.push({
      aliases: aliasesFromConfigFile(root, file),
      covers: configCoverage(toRootRelative(root, path.dirname(file)), referenced),
    });
  }
  return out;
}

/** Directory (root-relative, posix) of a `tsconfig.json` / `jsconfig.json` indexed path, or null for any other file. */
function configDirOf(rel: string): string | null {
  for (const name of CONFIG_NAMES) {
    if (rel === name) return "";
    if (rel.endsWith(`/${name}`)) return rel.slice(0, -(name.length + 1));
  }
  return null;
}

/**
 * Alias lookup for an indexed file: the aliases of the nearest `tsconfig.json`
 * (or `jsconfig.json`) in its directory or above. A config with no `paths` /
 * `baseUrl` of its own that lists `references` (a solution-style config, as
 * created by Vite) hands the file to the first referenced config that covers it
 * by its `files` / `include` / `exclude`. Configs are discovered among the indexed
 * paths (at most `MAX_TSCONFIGS`, shallowest first) and loaded once. Returns null
 * when the project has no config with aliases at all, so callers can skip the
 * lookup entirely.
 */
export function buildAliasLookup(
  root: string,
  indexedPaths: Iterable<string>
): ((sourceRel: string) => PathAliases | null) | null {
  const dirs: string[] = [];
  for (const rel of indexedPaths) {
    const dir = configDirOf(rel);
    if (dir !== null && !dirs.includes(dir)) dirs.push(dir);
  }
  // The root config is read even when it is not an indexed file.
  if (!dirs.includes("")) dirs.push("");
  dirs.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

  interface DirConfig {
    own: PathAliases | null;
    refs: ReferencedConfig[];
  }
  const byDir = new Map<string, DirConfig>();
  let anyAliases = false;
  for (const dir of dirs.slice(0, MAX_TSCONFIGS)) {
    const entry = configInDir(root, dir);
    const own = entry ? aliasesFromConfigFile(root, entry) : null;
    const refs = entry && !own ? loadReferences(root, entry) : [];
    byDir.set(dir, { own, refs });
    if (own || refs.some((r) => r.aliases)) anyAliases = true;
  }
  if (!anyAliases) return null;

  const cache = new Map<string, DirConfig | null>();
  const nearest = (start: string): DirConfig | null => {
    const hit = cache.get(start);
    if (hit !== undefined) return hit;
    let dir = start;
    for (;;) {
      const found = byDir.get(dir);
      if (found) {
        cache.set(start, found);
        return found;
      }
      if (dir === "") break;
      const up = dir.lastIndexOf("/");
      dir = up < 0 ? "" : dir.slice(0, up);
    }
    cache.set(start, null);
    return null;
  };
  return (sourceRel: string): PathAliases | null => {
    const slash = sourceRel.lastIndexOf("/");
    const config = nearest(slash < 0 ? "" : sourceRel.slice(0, slash));
    if (!config) return null;
    if (config.own) return config.own;
    for (const ref of config.refs) if (ref.covers(sourceRel)) return ref.aliases;
    return null;
  };
}
