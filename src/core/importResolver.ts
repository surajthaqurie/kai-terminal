import type { DependencyResolution, IndexedDependency, ProjectIndex } from "./types";

/**
 * Import-specifier resolution against the set of indexed files.
 *
 * Only resolutions that are *known* to be correct are reported:
 *  - TypeScript/JavaScript relative specifiers (`./x`, `../y/z`), including the
 *    ESM convention of writing `.js` for a `.ts` source, and directory
 *    `index` files.
 *  - Python relative imports (`.mod`, `..pkg.mod`, `.`), including packages.
 *
 * Everything else is reported explicitly instead of guessed: non-relative
 * specifiers (packages and path aliases such as tsconfig `paths`, which are
 * NOT resolved) come back as `non-relative`, and languages without a resolver
 * (Rust, Go, ...) as `unsupported`. A relative specifier whose target is not
 * indexed is `unresolved`.
 */

export interface ImportResolution {
  resolvedPath: string | null;
  resolution: DependencyResolution;
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

function languageOfPath(rel: string): "ts" | "py" | "other" {
  const dot = rel.lastIndexOf(".");
  const ext = dot < 0 ? "" : rel.slice(dot).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) return "ts";
  if (ext === ".py") return "py";
  return "other";
}

function resolveTsRelative(
  specifier: string,
  sourceRel: string,
  has: (p: string) => boolean
): string | null {
  const dir = dirOf(sourceRel);
  const base = normalizeSegments(dir ? `${dir}/${specifier}` : specifier);
  if (base === null) return null;
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

function resolvePythonRelative(
  specifier: string,
  sourceRel: string,
  has: (p: string) => boolean
): string | null {
  const m = /^(\.+)(.*)$/.exec(specifier);
  if (!m) return null;
  const up = m[1].length - 1; // one dot = the current package
  let dir = dirOf(sourceRel);
  for (let i = 0; i < up; i++) {
    if (dir === "") return null;
    dir = dirOf(dir);
  }
  const modulePath = m[2].split(".").filter(Boolean).join("/");
  const base = [dir, modulePath].filter(Boolean).join("/");
  if (modulePath) {
    if (has(`${base}.py`)) return `${base}.py`;
    if (has(`${base}/__init__.py`)) return `${base}/__init__.py`;
    return null;
  }
  // `from . import x`: the package itself.
  const init = dir ? `${dir}/__init__.py` : "__init__.py";
  return has(init) ? init : null;
}

/**
 * Resolve a relative specifier to an indexed file path, or null. Language is
 * taken from the importing file's extension.
 */
export function resolveRelativeSpecifier(
  specifier: string,
  sourceRel: string,
  has: (p: string) => boolean
): string | null {
  if (!specifier.startsWith(".")) return null;
  const source = posix(sourceRel);
  switch (languageOfPath(source)) {
    case "ts":
      return resolveTsRelative(specifier, source, has);
    case "py":
      return resolvePythonRelative(specifier, source, has);
    default:
      return null;
  }
}

export function resolveDependency(
  dep: Pick<IndexedDependency, "targetSpecifier">,
  sourceRel: string,
  has: (p: string) => boolean
): ImportResolution {
  const lang = languageOfPath(posix(sourceRel));
  if (lang === "other") return { resolvedPath: null, resolution: "unsupported" };
  if (!dep.targetSpecifier.startsWith(".")) {
    return { resolvedPath: null, resolution: "non-relative" };
  }
  const resolved = resolveRelativeSpecifier(dep.targetSpecifier, sourceRel, has);
  return resolved
    ? { resolvedPath: resolved, resolution: "resolved" }
    : { resolvedPath: null, resolution: "unresolved" };
}

/**
 * Recompute `resolvedPath`/`resolution` for every dependency in `files`
 * against the set of indexed paths. Resolution depends on *other* files, so it
 * is recomputed on every build (also for files whose own content is unchanged):
 * a target added or deleted elsewhere changes the answer.
 */
export function resolveAllDependencies(
  files: Record<string, { dependencies: IndexedDependency[] }>
): void {
  const has = (p: string): boolean => Object.prototype.hasOwnProperty.call(files, p);
  for (const [rel, file] of Object.entries(files)) {
    for (const dep of file.dependencies) {
      const r = resolveDependency(dep, rel, has);
      dep.resolvedPath = r.resolvedPath;
      dep.resolution = r.resolution;
    }
  }
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
      const target =
        dep.resolvedPath !== undefined && dep.resolution !== undefined
          ? dep.resolvedPath
          : resolveDependency(dep, rel, has).resolvedPath;
      if (!target || target === rel || !has(target)) continue;
      let set = reverse.get(target);
      if (!set) {
        set = new Set<string>();
        reverse.set(target, set);
      }
      set.add(rel);
    }
  }
  const out = new Map<string, string[]>();
  for (const [target, importers] of reverse) out.set(target, Array.from(importers).sort());
  return out;
}
