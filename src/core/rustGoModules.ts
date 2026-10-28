import * as fs from "node:fs";
import * as path from "node:path";
import { parseTomlSubset, type PythonPackageDir } from "./pythonRoots";

/**
 * Import resolution for Rust and Go, from file layout and manifests only (nothing is
 * built or executed).
 *
 * Rust (`crate::`, `self::`, `super::`, `mod foo;`, and other crates of the same
 * workspace): a module path is followed through the indexed files the way the
 * compiler lays them out, `a.rs` or `a/mod.rs` for module `a`, below the directory of
 * the crate root (`lib.rs`, else `main.rs`, in the nearest directory above the
 * importing file). The deepest module file reached is the target; what follows it
 * names items inside that file. A `#[path = "x.rs"] mod foo;` declaration at the top of
 * a file links that file to `x.rs`, relative to the directory of the declaring file
 * (the extractor emits it as a `path:x.rs` specifier). Only the declaration itself is
 * linked: a `use` that walks *through* a path-attributed module (`crate::foo::Item`)
 * is still resolved by directory layout and so stays unresolved. Not resolved: `mod`
 * inside an inline module (with or without `#[path]`), `#[cfg_attr(.., path = ..)]`,
 * macros that declare modules, `use` of a name that only exists in the importing scope
 * (2015-style relative paths), and crates outside the project.
 *
 * Go: an import path is matched against the `module` line of each `go.mod` (and local
 * `replace` directives) in the project; the longest matching module maps the rest of
 * the path to a directory, and the target is that package's non-test `.go` files
 * (at most `MAX_GO_PACKAGE_FILES`, in name order: the package is the dependency, not one
 * file). A `go.work` adds its local `replace` directives (which win over a `go.mod`'s)
 * and its `use` directories; modules it does not list are still treated as project
 * modules. Not resolved: vendored and module-cache packages, build tags.
 */

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_MANIFESTS = 64;
/** At most this many `go.work` files are read. */
const MAX_GO_WORKS = 8;
export const MAX_GO_PACKAGE_FILES = 8;
/** Specifier prefix for a Rust `#[path = "..."] mod foo;` declaration (see `resolveRustTargets`). */
export const RUST_PATH_ATTR_PREFIX = "path:";

export interface RustCrates {
  /** Crate identifier (`my_crate`) -> root file of its library (`crates/my/src/lib.rs`). */
  roots: ReadonlyMap<string, string>;
}

export interface GoModules {
  /** Import-path prefix -> root-relative directory, longest prefix first. */
  modules: ReadonlyArray<{ path: string; dir: string }>;
  /** Directory -> its non-test `.go` files (sorted). */
  filesByDir: ReadonlyMap<string, string[]>;
}

/** What the indexer builds once per scan and hands to the resolver. */
export interface WorkspaceResolvers {
  rustCrates?: RustCrates | null;
  go?: GoModules | null;
  /** Python packages mapped to a directory of a different name (`package-dir`). */
  pythonPackages?: ReadonlyArray<PythonPackageDir> | null;
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

function baseOf(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

function joinPath(dir: string, rel: string): string | null {
  const parts: string[] = [];
  for (const seg of `${dir}/${rel.replace(/\\/g, "/")}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

function readBounded(file: string): string | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function manifestDirs(indexedPaths: Iterable<string>, name: string): string[] {
  const dirs: string[] = [];
  for (const rel of indexedPaths) {
    if (baseOf(rel) === name) dirs.push(dirOf(rel));
  }
  dirs.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return dirs.slice(0, MAX_MANIFESTS);
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

/** Library crates of the project (`Cargo.toml` with a `[package]` and a lib root among the indexed files). */
export function buildRustCrates(root: string, indexedPaths: Iterable<string>): RustCrates | null {
  const paths = new Set(indexedPaths);
  const roots = new Map<string, string>();
  for (const dir of manifestDirs(paths, "Cargo.toml")) {
    const text = readBounded(path.join(root, dir, "Cargo.toml"));
    if (text === null) continue;
    let doc: ReturnType<typeof parseTomlSubset>;
    try {
      doc = parseTomlSubset(text);
    } catch {
      continue;
    }
    const pkg = doc.package;
    const lib = doc.lib;
    const pkgName =
      pkg && typeof pkg === "object" && !Array.isArray(pkg) && typeof pkg.name === "string"
        ? pkg.name
        : undefined;
    const libName =
      lib && typeof lib === "object" && !Array.isArray(lib) && typeof lib.name === "string"
        ? lib.name
        : undefined;
    const libPath =
      lib && typeof lib === "object" && !Array.isArray(lib) && typeof lib.path === "string"
        ? lib.path
        : "src/lib.rs";
    const name = (libName ?? pkgName)?.replace(/-/g, "_");
    const rootFile = joinPath(dir, libPath);
    if (name && rootFile && paths.has(rootFile) && !roots.has(name)) roots.set(name, rootFile);
  }
  return roots.size > 0 ? { roots } : null;
}

/** Root file of the crate a Rust source file belongs to: the nearest `lib.rs` / `main.rs` at or above it. */
function rustCrateRoot(sourceRel: string, has: (p: string) => boolean): string | null {
  const base = baseOf(sourceRel);
  if (base === "lib.rs" || base === "main.rs") return sourceRel;
  let dir = dirOf(sourceRel);
  for (;;) {
    for (const name of ["lib.rs", "main.rs"]) {
      const candidate = dir ? `${dir}/${name}` : name;
      if (has(candidate)) return candidate;
    }
    if (dir === "") return null;
    dir = dirOf(dir);
  }
}

/** Directory holding the child modules of the module defined by `file`, given its crate root. */
function childrenDirOf(file: string, rootFile: string): string {
  if (file === rootFile || baseOf(file) === "mod.rs") return dirOf(file);
  return file.slice(0, -".rs".length);
}

/** The file defining the module that contains the one defined by `file`; null for the crate root. */
function parentModuleFile(
  file: string,
  rootFile: string,
  has: (p: string) => boolean
): string | null {
  if (file === rootFile) return null;
  const parentDir = baseOf(file) === "mod.rs" ? dirOf(dirOf(file)) : dirOf(file);
  if (parentDir === dirOf(rootFile)) return rootFile;
  for (const candidate of [`${parentDir}/mod.rs`, `${parentDir}.rs`]) {
    if (has(candidate)) return candidate;
  }
  return null;
}

/** Follow module segments from a module file; returns the deepest module file reached and how many segments that took. */
function walkRustModules(
  start: string,
  rootFile: string,
  segments: readonly string[],
  has: (p: string) => boolean
): { file: string; consumed: number } {
  let file = start;
  let consumed = 0;
  for (const seg of segments) {
    if (!/^[A-Za-z_]\w*$/.test(seg)) break;
    const dir = childrenDirOf(file, rootFile);
    const flat = dir ? `${dir}/${seg}.rs` : `${seg}.rs`;
    const nested = dir ? `${dir}/${seg}/mod.rs` : `${seg}/mod.rs`;
    const next = has(flat) ? flat : has(nested) ? nested : null;
    if (!next) break;
    file = next;
    consumed++;
  }
  return { file, consumed };
}

/**
 * Indexed files a Rust `use` / `mod` specifier refers to. `names` are the items imported
 * from the module the specifier names: those that are themselves module files resolve to
 * those files; the module's own file is included when the import is bare or some name is
 * not a module.
 */
export function resolveRustTargets(
  specifier: string,
  names: readonly string[],
  sourceRel: string,
  has: (p: string) => boolean,
  crates: RustCrates | null
): string[] {
  if (specifier.startsWith(RUST_PATH_ATTR_PREFIX)) {
    // `#[path = "x.rs"] mod foo;`: the file is relative to the declaring file's directory.
    const value = specifier.slice(RUST_PATH_ATTR_PREFIX.length);
    if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return [];
    const target = joinPath(dirOf(sourceRel), value);
    return target && target !== sourceRel && has(target) ? [target] : [];
  }
  const segs = specifier.split("::").filter(Boolean);
  if (segs.length === 0) return [];
  const globbed = segs[segs.length - 1] === "*";
  if (globbed) segs.pop();

  let rootFile: string | null;
  let start: string | null;
  let rest: string[];
  const first = segs[0];
  if (first === "crate" || first === "self" || first === "super") {
    rootFile = rustCrateRoot(sourceRel, has);
    if (!rootFile) return [];
    if (first === "crate") {
      start = rootFile;
      rest = segs.slice(1);
    } else {
      start = sourceRel;
      let i = 0;
      if (first === "super") {
        while (segs[i] === "super") {
          start = parentModuleFile(start as string, rootFile, has);
          if (!start) return [];
          i++;
        }
      } else i = 1;
      rest = segs.slice(i);
    }
  } else if (crates && crates.roots.has(first)) {
    rootFile = crates.roots.get(first) as string;
    start = rootFile;
    rest = segs.slice(1);
  } else {
    return [];
  }

  const { file, consumed } = walkRustModules(start as string, rootFile, rest, has);
  const reachedModule = consumed === rest.length;
  const out: string[] = [];
  let needsOwnFile = names.length === 0 || !reachedModule;
  if (reachedModule && !globbed) {
    const dir = childrenDirOf(file, rootFile);
    for (const name of names) {
      if (!/^[A-Za-z_]\w*$/.test(name)) {
        needsOwnFile = true;
        continue;
      }
      const flat = dir ? `${dir}/${name}.rs` : `${name}.rs`;
      const nested = dir ? `${dir}/${name}/mod.rs` : `${name}/mod.rs`;
      const child = has(flat) ? flat : has(nested) ? nested : null;
      if (child) {
        if (!out.includes(child)) out.push(child);
      } else needsOwnFile = true;
    }
  } else {
    needsOwnFile = true;
  }
  if (needsOwnFile && !out.includes(file)) out.unshift(file);
  // An item of the importing file itself (`self::x`, `crate::x` in the root) links nothing.
  return out.filter((target) => target !== sourceRel);
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

/**
 * The directives of a `go.mod` / `go.work` that matter here: `module`, local
 * (`./` or `../`) `replace` targets, and `use` directories (`go.work` only). Both
 * the one-line and the parenthesised block forms are read; lines inside any other
 * block (`require (`, `exclude (`) are ignored.
 */
function parseGoDirectives(text: string): {
  module?: string;
  replaces: Array<[string, string]>;
  uses: string[];
} {
  const replaces: Array<[string, string]> = [];
  const uses: string[] = [];
  let module: string | undefined;
  let block: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    const mod = /^module\s+("?)([^\s"]+)\1\s*$/.exec(line);
    if (mod) {
      module = mod[2];
      continue;
    }
    const open = /^(\w+)\s*\(\s*$/.exec(line);
    if (open) {
      block = open[1];
      continue;
    }
    if (block !== null && line === ")") {
      block = null;
      continue;
    }
    let body: string | undefined;
    let kind: string | null;
    if (block !== null) {
      kind = block;
      body = line;
    } else {
      const single = /^(replace|use)\s+(.*)$/.exec(line);
      kind = single ? single[1] : null;
      body = single?.[2];
    }
    if (!body) continue;
    if (kind === "replace") {
      const rep = /^([^\s=]+)(?:\s+v\S+)?\s*=>\s*(\.{1,2}(?:\/\S*)?)(?:\s+v\S+)?$/.exec(body);
      if (rep) replaces.push([rep[1], rep[2]]);
    } else if (kind === "use") {
      const use = /^"?(\.{1,2}(?:\/[^"]*)?)"?$/.exec(body);
      if (use) uses.push(use[1]);
    }
  }
  return { module, replaces, uses };
}

/** Go modules of the project and the files of each package directory; null when there is no `go.mod`. */
export function buildGoModules(root: string, indexedPaths: Iterable<string>): GoModules | null {
  const paths = [...indexedPaths];
  const pathSet = new Set(paths);
  const modules: Array<{ path: string; dir: string }> = [];
  const moduleDirs: string[] = [];
  const addModuleDir = (dir: string): void => {
    if (!moduleDirs.includes(dir) && moduleDirs.length < MAX_MANIFESTS) moduleDirs.push(dir);
  };

  // A go.work comes first: its replaces win over a go.mod's (same path, earlier
  // entry), and the directories it `use`s are read even past the go.mod cap.
  for (const dir of manifestDirs(paths, "go.work").slice(0, MAX_GO_WORKS)) {
    const text = readBounded(path.join(root, dir, "go.work"));
    if (text === null) continue;
    const { replaces, uses } = parseGoDirectives(text);
    for (const [from, target] of replaces) {
      const targetDir = joinPath(dir, target);
      if (targetDir !== null) modules.push({ path: from, dir: targetDir });
    }
    for (const use of uses.slice(0, MAX_MANIFESTS)) {
      const useDir = joinPath(dir, use);
      if (useDir !== null && pathSet.has(useDir ? `${useDir}/go.mod` : "go.mod")) {
        addModuleDir(useDir);
      }
    }
  }
  for (const dir of manifestDirs(paths, "go.mod")) addModuleDir(dir);

  for (const dir of moduleDirs) {
    const text = readBounded(path.join(root, dir, "go.mod"));
    if (text === null) continue;
    const { module, replaces } = parseGoDirectives(text);
    if (module) modules.push({ path: module, dir });
    for (const [from, target] of replaces) {
      const targetDir = joinPath(dir, target);
      if (targetDir !== null) modules.push({ path: from, dir: targetDir });
    }
  }
  if (modules.length === 0) return null;
  modules.sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));

  const filesByDir = new Map<string, string[]>();
  for (const rel of paths) {
    if (!rel.endsWith(".go") || rel.endsWith("_test.go")) continue;
    const dir = dirOf(rel);
    const list = filesByDir.get(dir);
    if (list) list.push(rel);
    else filesByDir.set(dir, [rel]);
  }
  for (const list of filesByDir.values()) list.sort();
  return { modules, filesByDir };
}

/** Whether an import path lies under a module of the project (whether or not its package is indexed). */
export function isGoProjectImport(specifier: string, go: GoModules | null): boolean {
  return !!go?.modules.some((m) => specifier === m.path || specifier.startsWith(`${m.path}/`));
}

/** The package files an in-project Go import path names, or nothing for any other import. */
export function resolveGoTargets(specifier: string, go: GoModules | null): string[] {
  if (!go) return [];
  for (const m of go.modules) {
    if (specifier !== m.path && !specifier.startsWith(`${m.path}/`)) continue;
    const dir = joinPath(m.dir, specifier.slice(m.path.length + 1));
    if (dir === null) return [];
    return (go.filesByDir.get(dir) ?? []).slice(0, MAX_GO_PACKAGE_FILES);
  }
  return [];
}
