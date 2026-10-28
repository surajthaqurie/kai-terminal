import type { IndexedDependency, IndexedSymbol } from "./types";
import { resolveRustTargets, type RustCrates } from "./rustGoModules";

/**
 * Cross-file half of Rust trait-impl export detection.
 *
 * The extractor reads one file at a time. For a method of `impl Trait for Type` whose
 * type and/or trait is declared in another file it records `implOf`: the path of each
 * with the file's own `use` bindings expanded (`crate::model::Foo`). The method is
 * callable from outside the crate when the type is an unrestricted `pub` item and the
 * trait is not a private one, so this pass reads the recorded export status of the
 * declarations those paths reach, using the dependency resolution already computed for
 * the build (re-export chains included). It reads no files and adds no storage.
 *
 * Fail closed: a type that cannot be tied to exactly one `pub` declaration leaves the
 * method unexported, as does a trait that resolves to a non-`pub` declaration, to no
 * declaration, or to several. Only a trait that provably lives outside the project
 * (the standard library, another crate) or that no project file declares (a prelude
 * trait such as `Default`) does not count against the method, because it can only be
 * implemented for a public trait.
 *
 * Known residual: a trait reached only through a glob import (`use crate::traits::*`)
 * is checked when the glob resolves to project files; a glob that does not resolve
 * (for example `use super::*` in an inline test module of a crate root) cannot be
 * examined, so a project trait that only that glob provides is treated like a prelude
 * trait.
 */

export type RustImplSymbol = Pick<IndexedSymbol, "name" | "isExported"> &
  Partial<Pick<IndexedSymbol, "kind" | "container" | "implOf">>;

export interface RustImplFile {
  dependencies: IndexedDependency[];
  symbols?: ReadonlyArray<RustImplSymbol>;
}

type Verdict = "public" | "private" | "unknown" | "external";

const INTERNAL_ROOTS = new Set(["crate", "self", "super"]);

export function settleRustImplExports(
  files: Record<string, RustImplFile>,
  has: (p: string) => boolean,
  crates: RustCrates | null
): void {
  // Top-level declarations by name, built lazily per file and only for files an `implOf` reaches.
  const declCache = new Map<string, Map<string, RustImplSymbol[]>>();
  const declsOf = (file: string): Map<string, RustImplSymbol[]> => {
    let table = declCache.get(file);
    if (!table) {
      table = new Map();
      const entry = Object.prototype.hasOwnProperty.call(files, file) ? files[file] : undefined;
      for (const sym of entry?.symbols ?? []) {
        if (sym.container) continue;
        const list = table.get(sym.name);
        if (list) list.push(sym);
        else table.set(sym.name, [sym]);
      }
      declCache.set(file, table);
    }
    return table;
  };

  const verdictOfDecls = (
    targets: readonly string[],
    skip: string,
    name: string,
    kind: IndexedSymbol["kind"]
  ): Verdict => {
    const found = new Set<RustImplSymbol>();
    for (const target of targets) {
      if (target === skip) continue;
      for (const sym of declsOf(target).get(name) ?? []) if (sym.kind === kind) found.add(sym);
    }
    if (found.size !== 1) return "unknown"; // none reached, or ambiguous
    return [...found][0].isExported ? "public" : "private";
  };

  const verdictOf = (
    rel: string,
    file: RustImplFile,
    path: string,
    kind: IndexedSymbol["kind"]
  ): Verdict => {
    const segs = path.split("::");
    const name = segs[segs.length - 1];
    if (segs.length === 1) {
      // Not bound by any `use` of this file: a prelude item or one a glob import provides.
      const globbed = new Set<string>();
      for (const dep of file.dependencies) {
        if (!dep.importedSymbols?.includes("*") || dep.resolution !== "resolved") continue;
        for (const t of dep.resolvedPaths ?? (dep.resolvedPath ? [dep.resolvedPath] : [])) {
          globbed.add(t);
        }
      }
      const verdict = verdictOfDecls([...globbed], rel, name, kind);
      return verdict === "unknown" ? "external" : verdict;
    }
    if (!INTERNAL_ROOTS.has(segs[0]) && !crates?.roots.has(segs[0])) return "external";

    const parent = segs.slice(0, -1).join("::");
    const matching = file.dependencies.filter(
      (d) =>
        (d.targetSpecifier === path || d.targetSpecifier === parent) &&
        d.importedSymbols?.includes(name)
    );
    let targets: string[];
    if (matching.length > 0) {
      // The dependency carries the re-export-expanded targets of this very `use`.
      targets = matching.flatMap((d) =>
        d.resolution === "resolved"
          ? (d.resolvedPaths ?? (d.resolvedPath ? [d.resolvedPath] : []))
          : []
      );
    } else {
      // Written inline in the impl header, or reached through a bound module (`net::Client`).
      targets = resolveRustTargets(parent, [name], rel, has, crates);
    }
    return verdictOfDecls(targets, rel, name, kind);
  };

  for (const [rel, file] of Object.entries(files)) {
    if (!file.symbols) continue;
    for (const sym of file.symbols) {
      const of = sym.implOf;
      if (!of) continue;
      const typeOk = of.type === undefined || verdictOf(rel, file, of.type, "class") === "public";
      let traitOk = true;
      if (typeOk && of.trait !== undefined) {
        const v = verdictOf(rel, file, of.trait, "interface");
        traitOk = v === "public" || v === "external";
      }
      sym.isExported = typeOk && traitOk;
    }
  }
}
