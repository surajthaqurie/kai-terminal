import type { DependencyResolution, IndexedDependency, ProjectIndex } from "./types";
import { DEFAULT_PYTHON_ROOTS } from "./pythonRoots";
import { PYTHON_STDLIB_MODULES } from "./pythonStdlib";
import {
  isGoProjectImport,
  resolveGoTargets,
  resolveRustTargets,
  RUST_PATH_ATTR_PREFIX,
  type WorkspaceResolvers,
} from "./rustGoModules";
import type { PythonPackageDir } from "./pythonRoots";
import { settleRustImplExports, type RustImplSymbol } from "./rustImplExports";

/**
 * Import-specifier resolution against the set of indexed files.
 *
 * Only resolutions that are *known* to be correct are reported:
 *  - TypeScript/JavaScript relative specifiers (`./x`, `../y/z`), including the
 *    ESM convention of writing `.js` for a `.ts` source, and directory
 *    `index` files.
 *  - Python relative imports (`.mod`, `..pkg.mod`, `.`), including packages. A
 *    `from . import a, b` (or `from .pkg import a, b`) resolves every name that
 *    is a sibling/child module, not only the package `__init__.py`.
 *  - TypeScript/JavaScript path aliases declared in the nearest
 *    `tsconfig.json` (`compilerOptions.paths` and `baseUrl`, see
 *    `tsconfigAliases.ts`).
 *  - Python absolute imports of project modules (`import pkg.mod`,
 *    `from pkg import x`), looked up under the project root, `src/` and the source
 *    directories declared in `pyproject.toml` / `setup.cfg` (see `pythonRoots.ts`),
 *    including namespace packages whose modules sit in several of those roots. A
 *    module named like a standard-library module counts as project code only when
 *    the importing file sits in the same directory (where Python itself would pick
 *    the local file); otherwise it stays the standard library.
 *  - Re-exports: an import of a name that the target file re-exports
 *    (`export { x } from './x'`, `export * from`, a Python `__init__.py`
 *    `from .mod import x`) also records the file that defines it, so a barrel
 *    does not hide who really uses a symbol (see `addReExportTargets`). A TS/JS
 *    side-effect import of a barrel (`import './barrel'`) reaches what the barrel
 *    re-exports, as a namespace import does.
 *
 *  - Rust (`crate::`, `self::`, `super::`, `mod foo;`, `#[path = ".."] mod foo;`,
 *    workspace crates) and Go (import paths under a `go.mod` / `go.work` module of
 *    the project); see `rustGoModules.ts`.
 *
 * Everything else is reported explicitly instead of guessed: package names
 * come back as `non-relative`, and languages without a resolver as
 * `unsupported`. A relative specifier, or a specifier that matches a
 * configured alias, whose target is not indexed is `unresolved`.
 */

export interface ImportResolution {
  /** The first resolved target (kept for readers that know only one). */
  resolvedPath: string | null;
  resolution: DependencyResolution;
  /** Every resolved target when an import names several modules (Python `from . import a, b`). */
  resolvedPaths?: string[];
  /** True when a non-relative specifier resolved to a project file (tsconfig alias, Python project module). */
  internal?: boolean;
}

/**
 * tsconfig `paths` / `baseUrl`, already anchored to the project root
 * (posix, no leading `./`; `""` is the root itself).
 */
export interface PathAliases {
  baseUrl: string | null;
  paths: Array<{ pattern: string; targets: string[] }>;
}

const TS_JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"];
const TS_JS_INDEX_FILES = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs"];

/** ESM-style specifiers name the emitted extension; map it back to source candidates. */
const EMITTED_TO_SOURCE: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".js", ".jsx"],
  ".jsx": [".tsx", ".jsx"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
};

function posix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Normalise `.`/`..` segments without touching the filesystem; null when it escapes the root. */
function normalizeSegments(p: string): string | null {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

function languageOfPath(rel: string): "ts" | "py" | "rs" | "go" | "other" {
  const dot = rel.lastIndexOf(".");
  const ext = dot < 0 ? "" : rel.slice(dot).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) return "ts";
  if (ext === ".py") return "py";
  if (ext === ".rs") return "rs";
  if (ext === ".go") return "go";
  return "other";
}

/** Resolve a root-relative base path (no extension guessing done yet) to an indexed TS/JS file. */
function resolveTsBase(base: string, has: (p: string) => boolean): string | null {
  if (base !== "" && has(base)) return base;
  const dot = base.lastIndexOf(".");
  const slash = base.lastIndexOf("/");
  const ext = dot > slash ? base.slice(dot) : "";
  const emitted = EMITTED_TO_SOURCE[ext];
  if (emitted) {
    const stem = base.slice(0, -ext.length);
    for (const e of emitted) if (has(stem + e)) return stem + e;
  }
  for (const e of TS_JS_EXTENSIONS) if (has(base + e)) return base + e;
  for (const idx of TS_JS_INDEX_FILES) if (has(base + idx)) return base + idx;
  return null;
}

function resolveTsRelative(
  specifier: string,
  sourceRel: string,
  has: (p: string) => boolean
): string | null {
  const dir = dirOf(sourceRel);
  const base = normalizeSegments(dir ? `${dir}/${specifier}` : specifier);
  if (base === null) return null;
  return resolveTsBase(base, has);
}

/**
 * Candidate root-relative bases for a non-relative specifier, from tsconfig
 * `paths` (most specific pattern first, as TypeScript does) and `baseUrl`.
 * `matched` is true when a `paths` pattern applied at all, which makes a miss
 * an `unresolved` alias rather than a package name.
 */
function aliasCandidates(
  specifier: string,
  aliases: PathAliases
): { bases: string[]; matched: boolean } {
  const matches: Array<{ prefixLen: number; targets: string[]; star: string }> = [];
  for (const { pattern, targets } of aliases.paths) {
    const starAt = pattern.indexOf("*");
    if (starAt < 0) {
      if (specifier === pattern) matches.push({ prefixLen: pattern.length, targets, star: "" });
      continue;
    }
    const prefix = pattern.slice(0, starAt);
    const suffix = pattern.slice(starAt + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    ) {
      matches.push({
        prefixLen: prefix.length,
        targets,
        star: specifier.slice(prefix.length, specifier.length - suffix.length),
      });
    }
  }
  matches.sort((x, y) => y.prefixLen - x.prefixLen);
  const bases: string[] = [];
  for (const m of matches) {
    for (const t of m.targets) {
      const norm = normalizeSegments(t.replace("*", m.star));
      if (norm !== null) bases.push(norm);
    }
  }
  const matched = matches.length > 0;
  if (!matched && aliases.baseUrl !== null) {
    const norm = normalizeSegments(aliases.baseUrl ? `${aliases.baseUrl}/${specifier}` : specifier);
    if (norm !== null) bases.push(norm);
  }
  return { bases, matched };
}

/** `dir/name.py` or `dir/name/__init__.py` for a name imported from package `dir`. */
function pythonChildModule(dir: string, name: string, has: (p: string) => boolean): string | null {
  if (!/^[A-Za-z_]\w*$/.test(name)) return null;
  const base = dir ? `${dir}/${name}` : name;
  if (has(`${base}.py`)) return `${base}.py`;
  if (has(`${base}/__init__.py`)) return `${base}/__init__.py`;
  return null;
}

/**
 * Every indexed module a Python relative import refers to. Imported names that
 * are modules of the package (`from . import a, b` -> `a.py`, `b.py`) resolve
 * to those files; the package `__init__.py` is included only when the import
 * is bare or some name is not a module (it may be defined in `__init__`).
 */
function resolvePythonTargets(
  specifier: string,
  names: readonly string[],
  sourceRel: string,
  has: (p: string) => boolean
): string[] {
  const m = /^(\.+)(.*)$/.exec(specifier);
  if (!m) return [];
  const up = m[1].length - 1; // one dot = the current package
  let dir = dirOf(sourceRel);
  for (let i = 0; i < up; i++) {
    if (dir === "") return [];
    dir = dirOf(dir);
  }
  const modulePath = m[2].split(".").filter(Boolean).join("/");
  const base = [dir, modulePath].filter(Boolean).join("/");
  let packageDir: string;
  let init: string | null;
  if (modulePath) {
    if (has(`${base}.py`)) return [`${base}.py`];
    init = has(`${base}/__init__.py`) ? `${base}/__init__.py` : null;
    if (!init) return [];
    packageDir = base;
  } else {
    // `from . import x`: the package itself.
    packageDir = dir;
    const candidate = dir ? `${dir}/__init__.py` : "__init__.py";
    init = has(candidate) ? candidate : null;
  }
  const out: string[] = [];
  let nonModuleName = names.length === 0;
  for (const name of names) {
    const child = pythonChildModule(packageDir, name, has);
    if (child) {
      if (!out.includes(child)) out.push(child);
    } else {
      nonModuleName = true;
    }
  }
  if (init && nonModuleName && !out.includes(init)) out.unshift(init);
  return out;
}

/**
 * Resolve a relative specifier to an indexed file path, or null. Language is
 * taken from the importing file's extension.
 */
/**
 * Project modules behind an absolute Python import. A module is project code
 * only when a file for it exists in the index under a source root (the project
 * root, `src/` and the roots declared by the project's Python configs); anything
 * else (the standard library, installed packages) stays `non-relative`. A
 * package without `__init__.py` that has modules in several roots is a namespace
 * package: each imported name is looked up in every root. A package declared in
 * `package-dir` under a directory of another name (`"pkg" = "lib/other"`) is looked
 * up there first; if nothing is indexed for the import it is `unresolved`. Namespace
 * packages without any indexed child named in the import are not resolved.
 *
 * A top-level name that is also a standard-library module (`logging`, `types`)
 * resolves to the local file only when the importer sits in the directory that
 * holds it: that is the one case where Python itself prefers the local file.
 */
/** The declared `package-dir` entry an absolute Python import falls under (longest name wins), if any. */
function mappedPythonPackage(
  specifier: string,
  packageDirs: ReadonlyArray<PythonPackageDir>
): PythonPackageDir | null {
  let mapped: PythonPackageDir | null = null;
  for (const pkg of packageDirs) {
    if (
      (specifier === pkg.name || specifier.startsWith(`${pkg.name}.`)) &&
      (mapped === null || pkg.name.length > mapped.name.length)
    ) {
      mapped = pkg;
    }
  }
  return mapped;
}

function resolvePythonAbsoluteTargets(
  specifier: string,
  names: readonly string[],
  sourceRel: string,
  has: (p: string) => boolean,
  roots: readonly string[],
  packageDirs: ReadonlyArray<PythonPackageDir> = []
): string[] {
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(specifier)) return [];
  const shadowsStdlib = PYTHON_STDLIB_MODULES.has(specifier.split(".")[0]);
  const importerDir = dirOf(sourceRel);
  // A package mapped to a directory of another name (`package-dir`) is declared, so
  // it is tried before the roots; the longest declared name wins. The rest of the
  // dotted path is looked up inside that directory.
  const mapped = shadowsStdlib ? null : mappedPythonPackage(specifier, packageDirs);
  if (mapped) {
    const rest = specifier.slice(mapped.name.length); // "" or ".mod.sub"
    const anchor = mapped.dir ? `${mapped.dir}/_` : "_";
    const found = resolvePythonTargets(rest || ".", names, anchor, has);
    if (found.length > 0) return found;
  }
  for (const root of roots) {
    if (shadowsStdlib && importerDir !== root) continue;
    // Resolved as a relative import from a file that sits directly in `root`.
    const anchor = root ? `${root}/_` : "_";
    const found = resolvePythonTargets(`.${specifier}`, names, anchor, has);
    if (found.length > 0) return found;
  }
  if (shadowsStdlib || names.length === 0) return [];
  // Namespace package: `from ns import a, b` with `a` and `b` in different roots.
  const modulePath = specifier.split(".").join("/");
  const out: string[] = [];
  for (const root of roots) {
    const dir = root ? `${root}/${modulePath}` : modulePath;
    for (const name of names) {
      const child = pythonChildModule(dir, name, has);
      if (child && !out.includes(child)) out.push(child);
    }
  }
  return out;
}

export function resolveRelativeSpecifier(
  specifier: string,
  sourceRel: string,
  has: (p: string) => boolean,
  importedNames: readonly string[] = []
): string | null {
  return resolveRelativeTargets(specifier, sourceRel, has, importedNames)[0] ?? null;
}

function resolveRelativeTargets(
  specifier: string,
  sourceRel: string,
  has: (p: string) => boolean,
  importedNames: readonly string[]
): string[] {
  if (!specifier.startsWith(".")) return [];
  const source = posix(sourceRel);
  switch (languageOfPath(source)) {
    case "ts": {
      const one = resolveTsRelative(specifier, source, has);
      return one ? [one] : [];
    }
    case "py":
      return resolvePythonTargets(specifier, importedNames, source, has);
    default:
      return [];
  }
}

/**
 * Rust and Go. A Rust path through `crate` / `self` / `super` or a crate of the
 * same workspace, and a Go import path under a module of the project, resolve to
 * indexed files; the same forms that do not are `unresolved`, anything else (the
 * standard library, other crates and modules) is `non-relative`.
 */
function resolveNativeDependency(
  dep: Pick<IndexedDependency, "targetSpecifier"> &
    Partial<Pick<IndexedDependency, "importedSymbols">>,
  source: string,
  has: (p: string) => boolean,
  lang: "rs" | "go",
  workspace: WorkspaceResolvers
): ImportResolution {
  const specifier = dep.targetSpecifier;
  let targets: string[];
  let ownForm: boolean;
  if (lang === "rs") {
    targets = resolveRustTargets(
      specifier,
      dep.importedSymbols ?? [],
      source,
      has,
      workspace.rustCrates ?? null
    );
    const first = specifier.split("::")[0];
    ownForm =
      specifier.startsWith(RUST_PATH_ATTR_PREFIX) ||
      first === "crate" ||
      first === "self" ||
      first === "super" ||
      !!workspace.rustCrates?.roots.has(first);
  } else {
    targets = specifier.startsWith(".") ? [] : resolveGoTargets(specifier, workspace.go ?? null);
    ownForm = specifier.startsWith(".") || isGoProjectImport(specifier, workspace.go ?? null);
  }
  if (targets.length === 0) {
    return { resolvedPath: null, resolution: ownForm ? "unresolved" : "non-relative" };
  }
  return {
    resolvedPath: targets[0],
    resolution: "resolved",
    internal: true,
    ...(targets.length > 1 ? { resolvedPaths: targets } : {}),
  };
}

export function resolveDependency(
  dep: Pick<IndexedDependency, "targetSpecifier"> &
    Partial<Pick<IndexedDependency, "importedSymbols">>,
  sourceRel: string,
  has: (p: string) => boolean,
  aliases: PathAliases | null = null,
  pythonRoots: readonly string[] = DEFAULT_PYTHON_ROOTS,
  workspace: WorkspaceResolvers = {}
): ImportResolution {
  const source = posix(sourceRel);
  const lang = languageOfPath(source);
  if (lang === "other") return { resolvedPath: null, resolution: "unsupported" };
  if (lang === "rs" || lang === "go")
    return resolveNativeDependency(dep, source, has, lang, workspace);
  if (!dep.targetSpecifier.startsWith(".")) {
    if (lang === "ts" && aliases) {
      const { bases, matched } = aliasCandidates(dep.targetSpecifier, aliases);
      for (const base of bases) {
        const hit = resolveTsBase(base, has);
        if (hit) return { resolvedPath: hit, resolution: "resolved", internal: true };
      }
      if (matched) return { resolvedPath: null, resolution: "unresolved" };
    }
    if (lang === "py") {
      const targets = resolvePythonAbsoluteTargets(
        dep.targetSpecifier,
        dep.importedSymbols ?? [],
        source,
        has,
        pythonRoots,
        workspace.pythonPackages ?? []
      );
      if (targets.length > 0) {
        return {
          resolvedPath: targets[0],
          resolution: "resolved",
          internal: true,
          ...(targets.length > 1 ? { resolvedPaths: targets } : {}),
        };
      }
      // A declared `package-dir` package is project code: a miss is `unresolved`, not a package name.
      if (
        !PYTHON_STDLIB_MODULES.has(dep.targetSpecifier.split(".")[0]) &&
        mappedPythonPackage(dep.targetSpecifier, workspace.pythonPackages ?? [])
      ) {
        return { resolvedPath: null, resolution: "unresolved" };
      }
    }
    return { resolvedPath: null, resolution: "non-relative" };
  }
  const targets = resolveRelativeTargets(
    dep.targetSpecifier,
    sourceRel,
    has,
    dep.importedSymbols ?? []
  );
  if (targets.length === 0) return { resolvedPath: null, resolution: "unresolved" };
  return {
    resolvedPath: targets[0],
    resolution: "resolved",
    ...(targets.length > 1 ? { resolvedPaths: targets } : {}),
  };
}

/**
 * Every in-index target of a dependency: the persisted resolution when present,
 * otherwise resolved on the fly (snapshots written before resolution was
 * recorded). Aliases are not consulted on the fly; they only apply at build time.
 */
export function dependencyTargets(
  dep: IndexedDependency,
  sourceRel: string,
  has: (p: string) => boolean
): string[] {
  if (dep.resolvedPath !== undefined && dep.resolution !== undefined) {
    if (dep.resolvedPaths && dep.resolvedPaths.length > 0) return dep.resolvedPaths;
    return dep.resolvedPath ? [dep.resolvedPath] : [];
  }
  const r = resolveDependency(dep, sourceRel, has);
  return r.resolvedPaths ?? (r.resolvedPath ? [r.resolvedPath] : []);
}

/**
 * Recompute `resolvedPath`/`resolution` for every dependency in `files`
 * against the set of indexed paths. Resolution depends on *other* files, so it
 * is recomputed on every build (also for files whose own content is unchanged):
 * a target added or deleted elsewhere changes the answer.
 */
export function resolveAllDependencies(
  files: Record<string, ReExportFile>,
  aliases: PathAliases | ((sourceRel: string) => PathAliases | null) | null = null,
  pythonRoots: readonly string[] = DEFAULT_PYTHON_ROOTS,
  workspace: WorkspaceResolvers = {}
): void {
  const has = (p: string): boolean => Object.prototype.hasOwnProperty.call(files, p);
  for (const [rel, file] of Object.entries(files)) {
    const fileAliases = typeof aliases === "function" ? aliases(rel) : aliases;
    for (const dep of file.dependencies) {
      const r = resolveDependency(dep, rel, has, fileAliases, pythonRoots, workspace);
      dep.resolvedPath = r.resolvedPath;
      dep.resolution = r.resolution;
      if (r.resolvedPaths) dep.resolvedPaths = r.resolvedPaths;
      else delete dep.resolvedPaths;
      // A non-relative specifier that resolved to a project file is not an external package.
      if (r.internal) dep.isExternal = false;
    }
  }
  addReExportTargets(files);
  // Export status of Rust trait-impl methods depends on declarations in other files, so it
  // is settled on every build too, after the re-export targets it reads are in place.
  settleRustImplExports(files, has, workspace.rustCrates ?? null);
}

/** A re-export chain deeper than this is not followed (barrels of barrels of barrels...). */
const MAX_REEXPORT_DEPTH = 5;
/** Upper bound on files recorded per import, so a star-export hub cannot fan out without limit. */
const MAX_REEXPORT_TARGETS = 8;
/**
 * Upper bound on files examined while following one import through barrels (the
 * importer, its direct targets and every barrel or definer reached), so the walk of
 * a wide re-export tree costs a fixed amount per import whatever the depth.
 */
const MAX_REEXPORT_VISITED = 64;

/** What an importer asks a barrel for: named exports, `default`, or (namespace import) everything. */
interface WantedNames {
  names: ReadonlySet<string>;
  all: boolean;
}

function wantedNames(dep: IndexedDependency): WantedNames {
  const names = new Set(dep.importedSymbols);
  const bindings = dep.importBindings ?? [];
  if (bindings.includes("default")) names.add("default");
  return { names, all: bindings.includes("namespace") };
}

type ReExportFile = {
  dependencies: IndexedDependency[];
  symbols?: ReadonlyArray<RustImplSymbol>;
};

/**
 * Files that define the `wanted` names behind `barrel`, following re-exports:
 * named ones (`export { x } from`) when `x` is wanted, star ones when the
 * target exports a wanted name (or re-exports it onwards). A default import
 * wants `default` (`export { default } from`, `export { x as default } from`;
 * never through `export *`), a namespace import wants everything the barrel
 * re-exports. Import edges only; a name imported under another alias
 * (`export { a as b }`) matches as `b`, the name importers use.
 */
function reExportedDefiners(
  files: Record<string, ReExportFile>,
  barrel: string,
  wanted: WantedNames,
  depth: number,
  seen: Set<string>
): string[] {
  if (depth >= MAX_REEXPORT_DEPTH) return [];
  const file = Object.prototype.hasOwnProperty.call(files, barrel) ? files[barrel] : undefined;
  if (!file) return [];
  const out: string[] = [];
  for (const dep of file.dependencies) {
    const exportedNames = dep.reExportedNames;
    if (!exportedNames || !dep.resolvedPath) continue;
    const star = exportedNames.includes("*");
    if (!wanted.all) {
      // `export *` never re-exports `default`, so a default-only import cannot pass through one.
      const relevant = star
        ? [...wanted.names].some((n) => n !== "default")
        : exportedNames.some((n) => wanted.names.has(n));
      if (!relevant) continue;
    }
    for (const target of dep.resolvedPaths ?? [dep.resolvedPath]) {
      if (seen.size >= MAX_REEXPORT_VISITED) return out;
      if (seen.has(target) || !Object.prototype.hasOwnProperty.call(files, target)) continue;
      seen.add(target);
      const onwards = reExportedDefiners(files, target, wanted, depth + 1, seen);
      const definesWanted = files[target].symbols?.some(
        (sym) => sym.isExported && (wanted.all || wanted.names.has(sym.name))
      );
      // A star export proves nothing by itself: keep the target only when it
      // really exports a wanted name or leads to a file that does.
      if (!star || definesWanted || onwards.length > 0) out.push(target);
      out.push(...onwards);
    }
  }
  return out;
}

/**
 * Second pass over resolved imports: when an import targets a file that
 * re-exports one of the imported names, the file defining that name is added to
 * the dependency's `resolvedPaths` after the direct target. Persisted, so the
 * reverse import map and neighbour expansion see importers of a symbol that
 * reach it through a barrel. Bounded in depth and fan-out.
 */
function addReExportTargets(files: Record<string, ReExportFile>): void {
  // Compute every addition against the direct resolutions first, then apply:
  // a re-export dependency must not see targets added to it earlier in this pass.
  const additions: Array<{ dep: IndexedDependency; targets: string[] }> = [];
  for (const [rel, file] of Object.entries(files)) {
    for (const dep of file.dependencies) {
      if (dep.resolution !== "resolved" || !dep.resolvedPath) continue;
      const sideEffect = !dep.importedSymbols || dep.importedSymbols.length === 0;
      if (sideEffect) {
        // `import './barrel'` runs the barrel, which loads everything it re-exports, so
        // it reaches the same files a namespace import would. Only for TS/JS, and never
        // for a re-export statement itself (it is already a link of the barrel chain).
        if (
          languageOfPath(rel) !== "ts" ||
          dep.reExportedNames ||
          (dep.importBindings && dep.importBindings.length > 0)
        ) {
          continue;
        }
      }
      const wanted: WantedNames = sideEffect
        ? { names: new Set<string>(), all: true }
        : wantedNames(dep);
      const direct = dep.resolvedPaths ?? [dep.resolvedPath];
      const extra: string[] = [];
      for (const barrel of direct) {
        const seen = new Set<string>([rel, ...direct]);
        for (const t of reExportedDefiners(files, barrel, wanted, 0, seen)) {
          if (!extra.includes(t) && !direct.includes(t)) extra.push(t);
        }
      }
      if (extra.length > 0) {
        additions.push({ dep, targets: [...direct, ...extra.slice(0, MAX_REEXPORT_TARGETS)] });
      }
    }
  }
  for (const { dep, targets } of additions) dep.resolvedPaths = targets;
}

/**
 * Reverse import map: indexed file -> files that import it (sorted, unique).
 * Uses the persisted `resolvedPath` when present and falls back to resolving
 * on the fly for snapshots written before resolution was recorded. These are
 * import relationships only; no call graph is implied.
 */
export function buildReverseImportMap(index: Pick<ProjectIndex, "files">): Map<string, string[]> {
  const files = index.files;
  const has = (p: string): boolean => Object.prototype.hasOwnProperty.call(files, p);
  const reverse = new Map<string, Set<string>>();
  for (const [rel, file] of Object.entries(files)) {
    for (const dep of file.dependencies) {
      for (const target of dependencyTargets(dep, rel, has)) {
        if (target === rel || !has(target)) continue;
        let set = reverse.get(target);
        if (!set) {
          set = new Set<string>();
          reverse.set(target, set);
        }
        set.add(rel);
      }
    }
  }
  const out = new Map<string, string[]>();
  for (const [target, importers] of reverse) out.set(target, Array.from(importers).sort());
  return out;
}
