import type { IndexedSymbol, ProjectIndex } from "./types";
import { buildReverseImportMap } from "./importResolver";

/**
 * Lookup structures derived from a loaded index, built lazily and kept for as
 * long as that index object lives (a WeakMap keyed by the object itself, so a
 * rebuilt or replaced index can never see another snapshot's tables and no
 * explicit invalidation exists to forget). They hold no source text.
 */

/** Split an identifier into lowercase words: camelCase, PascalCase, snake_case, kebab-case, digits, acronyms. */
export function splitIdentifier(name: string): string[] {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  return parts.length > 0 ? parts : [name.toLowerCase()];
}

/**
 * Light, deterministic suffix stemmer used only to align query words with
 * identifier words (`estimated`/`estimate`/`estimating`, `tokens`/`token`).
 * It is not linguistic stemming and is never shown to users.
 */
export function stemWord(word: string): string {
  let w = word.toLowerCase();
  for (const suffix of ["ing", "ed", "es", "s", "e"]) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

export interface SymbolNameEntry {
  name: string;
  lower: string;
  /** Stemmed identifier words. */
  stems: string[];
  symbols: IndexedSymbol[];
}

export interface SymbolNameTable {
  entries: SymbolNameEntry[];
  /** Entries by lowercase symbol name, for exact-name lookups. */
  byLower: Map<string, SymbolNameEntry>;
  /** How many distinct symbol names contain each stemmed word (rarity signal for ranking). */
  docFreq: Map<string, number>;
}

interface Derived {
  names?: SymbolNameTable;
  reverseImports?: Map<string, string[]>;
}

const derivedByIndex = new WeakMap<ProjectIndex, Derived>();

function derivedFor(index: ProjectIndex): Derived {
  let d = derivedByIndex.get(index);
  if (!d) {
    d = {};
    derivedByIndex.set(index, d);
  }
  return d;
}

export function getSymbolNameTable(index: ProjectIndex): SymbolNameTable {
  const d = derivedFor(index);
  if (d.names) return d.names;
  const entries: SymbolNameEntry[] = [];
  const byLower = new Map<string, SymbolNameEntry>();
  const docFreq = new Map<string, number>();
  for (const [name, symbols] of Object.entries(index.symbolIndex)) {
    if (!Array.isArray(symbols) || symbols.length === 0) continue;
    const stems = splitIdentifier(name).map(stemWord);
    const entry = { name, lower: name.toLowerCase(), stems, symbols };
    entries.push(entry);
    if (!byLower.has(entry.lower)) byLower.set(entry.lower, entry);
    for (const s of new Set(stems)) docFreq.set(s, (docFreq.get(s) ?? 0) + 1);
  }
  d.names = { entries, byLower, docFreq };
  return d.names;
}

/** Reverse import map (indexed file -> importers), computed once per index. Imports only; no call graph. */
export function getReverseImports(index: ProjectIndex): Map<string, string[]> {
  const d = derivedFor(index);
  if (!d.reverseImports) d.reverseImports = buildReverseImportMap(index);
  return d.reverseImports;
}
