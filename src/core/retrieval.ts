import fs from "fs";
import path from "path";
import crypto from "crypto";
import type {
  ProjectIndex,
  IndexedFile,
  IndexedSymbol,
  IndexedDependency,
  ContextOmission,
} from "./types";
import { estimateTokens, truncateToTokenBudget, type TokenizerFunction } from "./tokenCounter";
import { isWithinProjectBoundary } from "./registry";
import { extractSearchTokens } from "./classifier";
import { isBinaryFile, isSensitiveContent, isSensitiveFile } from "./indexer";
import { getSymbolNameTable, stemWord } from "./indexDerived";

export interface LineRange {
  startLine: number;
  endLine: number;
}

/** One ranked symbol for a query: why it matched and how strongly. */
export interface SymbolHit {
  symbol: IndexedSymbol;
  score: number;
  /** Query words (stemmed) that aligned with words of the symbol name. */
  matchedWords: string[];
  /** The symbol name is itself a query token (e.g. `estimateTokens` typed as written). */
  exactName: boolean;
}

/** A candidate file ranked from index data only (no disk access). */
export interface RankedFile {
  file: IndexedFile;
  score: number;
  /** Matched symbols in discovery order (deduplicated, capped). */
  matchedSymbols: IndexedSymbol[];
  /** Best-scored symbols first. */
  symbolHits: SymbolHit[];
  matchedDeps: IndexedDependency[];
  /** Query tokens found in the file path. */
  pathMatches: string[];
  matchedTokenCount: number;
}

export interface ScoredFileMatch extends RankedFile {
  startLine?: number;
  endLine?: number;
  snippet?: string;
  /** Other line ranges worth reading (metadata only; read them with kai_read_range). */
  moreRanges?: Array<LineRange & { symbol: string }>;
  /** True when the live file differs from the indexed snapshot (line numbers may have shifted). */
  changedSinceIndex?: boolean;
}

export interface RetrievalResult {
  matchedFiles: ScoredFileMatch[];
  matchedSymbols: IndexedSymbol[];
  dependencies: IndexedDependency[];
  /** At most MAX_OMISSIONS entries; see `omissionsTotal` for the real count. */
  omissions: ContextOmission[];
  omissionsTotal: number;
  /** Files that matched at all, before budgets. */
  candidateCount: number;
  usedTokens: number;
  staleFiles: string[];
}

// Bounds for per-query match accumulation. Symbol tables are unbounded
// (generated files can export thousands of symbols), and the per-file
// matchedSymbols dedup scan below is linear — without a cap, one
// pathological file turns retrieval quadratic. Consumers only read the top
// entries, so capping changes nothing for realistic inputs. Insertion order
// is preserved, keeping results deterministic.
const MAX_MATCHED_SYMBOLS_PER_FILE = 500;
const MAX_RANKED_SYMBOLS = 1000;
const MAX_SYMBOL_HITS_PER_FILE = 8;
const MAX_MATCHED_DEPS = 200;
export const MAX_OMISSIONS = 25;

/** A source range is whole-file below this many lines. */
const SMALL_FILE_LINES = 60;
const SNIPPET_CONTEXT_BEFORE = 3;
const MAX_SNIPPET_LINES = 60;
const MAX_MERGED_SNIPPET_LINES = 100;
const MERGE_GAP_LINES = 3;
const HEAD_LINES = 80;
const MAX_MORE_RANGES = 3;
export const MAX_INDEXED_FILE_BYTES = 512 * 1024;

const COMMON_TASK_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "what",
  "where",
  "when",
  "how",
  "write",
  "read",
  "make",
  "create",
  "does",
  "explain",
  "implement",
  "unit",
  "test",
  "tests",
  "some",
  "have",
  "more",
  "also",
  "been",
  "were",
  "will",
  "would",
  "should",
  "could",
  "why",
]);

/** Kinds that name real units of code outrank loose values when names tie. */
const KIND_WEIGHT: Record<IndexedSymbol["kind"], number> = {
  function: 1,
  class: 1,
  interface: 1,
  type: 0.9,
  module: 0.8,
  constant: 0.7,
  variable: 0.5,
};

/**
 * Checks if a relative path looks like a credential or secret file.
 */
export function isPotentialSecretPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  const fileName = normalized.split("/").pop() || "";
  const lowerName = fileName.toLowerCase();

  if (lowerName === ".env" || lowerName.startsWith(".env.")) return true;
  if (lowerName === "id_rsa" || lowerName === "id_ed25519" || lowerName === "id_ecdsa") return true;
  if (lowerName.endsWith(".pem") || lowerName.endsWith(".key") || lowerName.endsWith(".pkcs12"))
    return true;
  if (lowerName === "credentials.json" || lowerName === "client_secret.json") return true;
  if (/^(?:secret|token|credential|api_key)[s]?\.(?:json|ya?ml|toml|txt|env)$/i.test(lowerName))
    return true;

  return false;
}

/**
 * Checks file content for private keys or access credentials.
 */
function containsSecretContent(content: string): boolean {
  if (
    /-----BEGIN (?:RSA|DSA|EC|OPENSSH|PGP)? PRIVATE KEY-----/i.test(content) ||
    /\bAKIA[0-9A-Z]{16}\b/.test(content) ||
    /\b(?:ghp|gho|ghu|ghs|ghr|glpat)_[A-Za-z0-9_]{16,}\b/.test(content) ||
    /(?:api[_-]?key|secret[_-]?key|auth[_-]?token)\s*[:=]\s*['"][a-zA-Z0-9_\-\.]{20,}['"]/i.test(
      content
    )
  ) {
    return true;
  }
  return false;
}

export function estimateOmissionTokens(sizeBytes: number): number {
  return Math.max(1, Math.ceil(sizeBytes / 4));
}

// ---------------------------------------------------------------------------
// Safe source reading (shared by retrieval and kai_read_range)
// ---------------------------------------------------------------------------

export type SourceReadStatus =
  | "ok"
  | "not_indexed" // path is not an indexed file (never read)
  | "untrusted" // secret-looking path/content, or escapes the project root
  | "missing" // indexed file no longer exists on disk
  | "not_file"
  | "too_large"
  | "binary";

export interface SourceRead {
  status: SourceReadStatus;
  content?: string;
  /** sha256 of the live content (the indexed hash when stat metadata is unchanged). */
  contentHash?: string;
  /** Live bytes differ from the indexed snapshot. */
  changedSinceIndex?: boolean;
  sizeBytes?: number;
  reason?: string;
}

/**
 * Read an *indexed* file's live content with every protection retrieval has:
 * secret-path screening, lexical and realpath root confinement (symlink
 * escapes), regular-file and size checks, binary detection, and secret-content
 * screening. A path that is not in the index is never read.
 */
export function readIndexedSource(index: ProjectIndex, relPath: string): SourceRead {
  const norm = relPath.replace(/\\/g, "/");
  const file = Object.prototype.hasOwnProperty.call(index.files, norm)
    ? index.files[norm]
    : Object.prototype.hasOwnProperty.call(index.files, relPath)
      ? index.files[relPath]
      : undefined;
  if (!file) return { status: "not_indexed" };

  // Both name screens: this reader also backs symbol lookups and search snippets,
  // which never pass through the file-argument validation, so a hand-edited or
  // older index naming e.g. `.npmrc` or `service-account.json` must not be readable.
  if (
    isPotentialSecretPath(file.relativePath) ||
    isSensitiveFile(path.basename(file.relativePath))
  ) {
    return { status: "untrusted", reason: "path looks like a credential file" };
  }

  try {
    const joined = path.join(index.meta.canonicalPath, file.relativePath);
    const lexicalBase = path.resolve(index.meta.canonicalPath);
    const lexicalTarget = path.resolve(joined);
    if (lexicalTarget !== lexicalBase && !lexicalTarget.startsWith(lexicalBase + path.sep)) {
      return { status: "untrusted", reason: "path escapes the project root" };
    }

    let realBase: string;
    let realTarget: string;
    try {
      realBase = fs.realpathSync(index.meta.canonicalPath);
      realTarget = fs.realpathSync(joined);
    } catch {
      return { status: "missing" };
    }
    if (!isWithinProjectBoundary(realTarget, realBase)) {
      return { status: "untrusted", reason: "path resolves outside the project root" };
    }

    const stat = fs.statSync(realTarget);
    if (!stat.isFile()) return { status: "not_file" };
    if (stat.size > MAX_INDEXED_FILE_BYTES) {
      return { status: "too_large", sizeBytes: stat.size };
    }

    const buf = fs.readFileSync(realTarget);
    if (isBinaryFile(file.relativePath, buf)) return { status: "binary", sizeBytes: stat.size };
    const content = buf.toString("utf-8");
    if (containsSecretContent(content) || isSensitiveContent(content)) {
      return {
        status: "untrusted",
        reason: "content looks like a credential",
        sizeBytes: stat.size,
      };
    }

    // Staleness fast path: the indexer reuses cache entries on this exact
    // size+mtime(+ctime) predicate, so a match means the bytes are unchanged
    // since indexing and the sha256 pass can be skipped. Any mismatch falls
    // through to the full hash, which stays the ground truth.
    const statMatchesIndex =
      stat.size === file.sizeBytes &&
      stat.mtimeMs === file.mtimeMs &&
      (file.ctimeMs === undefined || stat.ctimeMs === undefined || stat.ctimeMs === file.ctimeMs);
    let contentHash: string;
    let changed = false;
    if (statMatchesIndex && file.sha256) {
      contentHash = file.sha256;
    } else {
      contentHash = crypto.createHash("sha256").update(content).digest("hex");
      changed = !!file.sha256 && contentHash !== file.sha256;
    }
    return { status: "ok", content, contentHash, changedSinceIndex: changed, sizeBytes: stat.size };
  } catch {
    return { status: "missing" };
  }
}

// ---------------------------------------------------------------------------
// Ranking (index data only)
// ---------------------------------------------------------------------------

export interface RankResult {
  ranked: RankedFile[];
  /** Best-scored symbols across the project, capped at MAX_RANKED_SYMBOLS. */
  matchedSymbols: IndexedSymbol[];
  dependencies: IndexedDependency[];
  queryTokens: string[];
}

function prepareQueryTokens(query: string): {
  queryTokens: string[];
  primaryTokens: string[];
  intentHints: ReturnType<typeof extractSearchTokens>["intentHints"];
} {
  const safeQuery = (query || "").slice(0, 2000);
  const extracted = extractSearchTokens(safeQuery);
  const rawTokens = safeQuery.toLowerCase().match(/\w+/g) || [];
  let queryTokens = extracted.tokens.filter((t) => t.length > 2);
  if (queryTokens.length === 0 && extracted.tokens.length > 0) {
    queryTokens = extracted.tokens;
  } else if (queryTokens.length === 0 && rawTokens.length > 0) {
    queryTokens = Array.from(new Set(rawTokens));
  }
  // Stop words are dropped from the coverage metrics but kept for fallback matching.
  const nonStop = queryTokens.filter((t) => !COMMON_TASK_STOP_WORDS.has(t));
  return {
    queryTokens,
    primaryTokens: nonStop.length > 0 ? nonStop : queryTokens,
    intentHints: extracted.intentHints,
  };
}

/**
 * Deterministic relevance ranking of indexed files for a query, from index
 * data only. Symbols are scored individually (word-aligned matches weighted by
 * how rare the word is across the project's symbol names, so a common word such
 * as `tokens` cannot outrank the specific `estimateTokens`); a file's symbol
 * score is dominated by its best symbol with diminishing credit for the next
 * two, which keeps many weak matches from piling up.
 */
export function rankCandidates(
  index: ProjectIndex,
  query: string,
  options: { includeTests?: boolean } = {}
): RankResult {
  const includeTests = options.includeTests ?? true;
  const { queryTokens, primaryTokens, intentHints } = prepareQueryTokens(query);

  const table = getSymbolNameTable(index);
  const nameCount = Math.max(1, table.entries.length);
  const queryTokenSet = new Set(queryTokens);
  const primaryQ = Array.from(new Set(primaryTokens)).map((raw) => ({
    raw,
    stem: stemWord(raw),
    stop: COMMON_TASK_STOP_WORDS.has(raw),
    idf: 1 + Math.log((nameCount + 1) / ((table.docFreq.get(stemWord(raw)) ?? 0) + 1)),
  }));
  const primaryCount = Math.max(1, primaryQ.length);

  const fileHits = new Map<string, { file: IndexedFile; hits: SymbolHit[] }>();
  const fileMatchedTokens = new Map<string, Set<string>>();
  const fileInfo = new Map<string, RankedFile>();
  const allHits: SymbolHit[] = [];

  const recordTokenMatch = (normPath: string, token: string): void => {
    let set = fileMatchedTokens.get(normPath);
    if (!set) {
      set = new Set<string>();
      fileMatchedTokens.set(normPath, set);
    }
    set.add(token);
  };
  const infoFor = (normPath: string, file: IndexedFile): RankedFile => {
    let info = fileInfo.get(normPath);
    if (!info) {
      info = {
        file,
        score: 0,
        matchedSymbols: [],
        symbolHits: [],
        matchedDeps: [],
        pathMatches: [],
        matchedTokenCount: 0,
      };
      fileInfo.set(normPath, info);
    }
    return info;
  };

  // 1. Symbol matching
  for (const entry of table.entries) {
    const matchedQ = primaryQ.filter((q) => !q.stop && entry.stems.includes(q.stem));
    const exactName = queryTokenSet.has(entry.lower);
    const partial = primaryQ.filter(
      (q) => !q.stop && q.raw.length >= 4 && !matchedQ.includes(q) && entry.lower.includes(q.raw)
    );
    // A name that is itself a stop word ("test", "create") only earns a token credit.
    const stopExact = exactName && COMMON_TASK_STOP_WORDS.has(entry.lower);
    if (matchedQ.length === 0 && partial.length === 0 && !exactName) continue;

    let score = 0;
    if (matchedQ.length > 0) {
      const wordScore = matchedQ.reduce((sum, q) => sum + 8 * q.idf, 0);
      const coverage = matchedQ.length / primaryCount;
      score += wordScore * (0.6 + 0.4 * coverage);
      // The name is wholly made of query words: it *is* the thing being asked about.
      if (entry.stems.length > 1 && matchedQ.length >= entry.stems.length) score += 10;
    }
    // Equal to a query word is a tie-breaker, not a trump card: in a multi-word
    // query one common word (`tokens`) must not beat a name that covers more of
    // the query with rarer words (`estimateTokens`).
    if (exactName) score += stopExact ? 2 : 12;
    score += Math.min(3, partial.length) * 2;
    if (score <= 0) continue;

    for (const sym of entry.symbols) {
      const normKey = sym.filePath.replace(/\\/g, "/");
      const file = Object.prototype.hasOwnProperty.call(index.files, normKey)
        ? index.files[normKey]
        : Object.prototype.hasOwnProperty.call(index.files, sym.filePath)
          ? index.files[sym.filePath]
          : undefined;
      if (!file) continue;
      if (!includeTests && file.isTest) continue;
      const hitScore = (score + (sym.isExported ? 2 : 0)) * (KIND_WEIGHT[sym.kind] ?? 1);
      const hit: SymbolHit = {
        symbol: sym,
        score: hitScore,
        matchedWords: matchedQ.map((q) => q.stem),
        exactName,
      };
      allHits.push(hit);
      let fh = fileHits.get(normKey);
      if (!fh) {
        fh = { file, hits: [] };
        fileHits.set(normKey, fh);
      }
      fh.hits.push(hit);
      for (const q of matchedQ) recordTokenMatch(normKey, q.raw);
      if (exactName) recordTokenMatch(normKey, entry.lower);
      for (const q of partial) recordTokenMatch(normKey, q.raw);
    }
  }

  for (const [normKey, fh] of fileHits) {
    const info = infoFor(normKey, fh.file);
    // Stable order: best score first, then source position.
    fh.hits.sort(
      (a, b) =>
        b.score - a.score ||
        a.symbol.location.line - b.symbol.location.line ||
        a.symbol.name.localeCompare(b.symbol.name)
    );
    const weights = [1, 0.4, 0.2];
    info.score += fh.hits.slice(0, 3).reduce((sum, h, i) => sum + h.score * weights[i], 0);
    info.symbolHits = fh.hits.slice(0, MAX_SYMBOL_HITS_PER_FILE);
    // Discovery order (kept for compatibility), bounded.
    const seen = new Set<string>();
    for (const h of fh.hits) {
      if (info.matchedSymbols.length >= MAX_MATCHED_SYMBOLS_PER_FILE) break;
      const key = `${h.symbol.name}:${h.symbol.location.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      info.matchedSymbols.push(h.symbol);
    }
  }

  // 2. File path and name matching
  for (const [relPath, file] of Object.entries(index.files)) {
    if (!includeTests && file.isTest) continue;

    const normRel = relPath.replace(/\\/g, "/");
    const pathLower = normRel.toLowerCase();
    const baseName = normRel.split("/").pop()?.toLowerCase() ?? normRel.toLowerCase();
    const baseWithoutExt = baseName.replace(/\.[^.]+$/, "");

    let pathScore = 0;
    const pathMatches: string[] = [];
    for (const q of queryTokens) {
      const isStopWord = COMMON_TASK_STOP_WORDS.has(q);
      const isPluralStemMatch =
        (baseWithoutExt.endsWith("s") && baseWithoutExt.slice(0, -1) === q) ||
        (q.endsWith("s") && q.slice(0, -1) === baseWithoutExt);

      if (baseWithoutExt === q || isPluralStemMatch) {
        pathScore += isStopWord ? 5.0 : 25.0; // Exact or singular/plural filename stem match
        recordTokenMatch(normRel, q);
        pathMatches.push(q);
      } else if (baseName === q) {
        pathScore += isStopWord ? 4.0 : 20.0;
        recordTokenMatch(normRel, q);
        pathMatches.push(q);
      } else if (baseName.includes(q)) {
        pathScore += isStopWord ? 1.0 : 6.0; // File name match
        recordTokenMatch(normRel, q);
        pathMatches.push(q);
      } else if (!isStopWord && pathLower.includes(q)) {
        pathScore += 2.0; // Directory match
        recordTokenMatch(normRel, q);
        pathMatches.push(q);
      }
    }

    if (pathScore > 0) {
      const info = infoFor(normRel, file);
      info.score += pathScore;
      info.pathMatches = pathMatches;
    }
  }

  // 3. Dependency matching
  const matchedDeps: IndexedDependency[] = [];
  const seenDeps = new Set<string>();
  for (const file of Object.values(index.files)) {
    if (!includeTests && file.isTest) continue;
    for (const dep of file.dependencies) {
      const specLower = dep.targetSpecifier.toLowerCase();
      for (const q of queryTokens) {
        if (!specLower.includes(q)) continue;
        const depKey = `${dep.sourceFile}:${dep.targetSpecifier}`;
        if (!seenDeps.has(depKey) && matchedDeps.length < MAX_MATCHED_DEPS) {
          seenDeps.add(depKey);
          matchedDeps.push(dep);
        }
        const normSource = file.relativePath.replace(/\\/g, "/");
        const existing = fileInfo.get(normSource);
        if (existing) {
          existing.score += 1.5;
          recordTokenMatch(normSource, q);
          if (!existing.matchedDeps.some((d) => d.targetSpecifier === dep.targetSpecifier)) {
            existing.matchedDeps.push(dep);
          }
        }
      }
    }
  }

  // 4. Multi-token coverage boost & intent adjustments
  for (const [normRel, match] of fileInfo.entries()) {
    const matchedSet = fileMatchedTokens.get(normRel);
    const matchedCount = matchedSet ? matchedSet.size : 0;
    match.matchedTokenCount = matchedCount;

    if (primaryTokens.length > 1 && matchedCount > 0) {
      // Conjunction boost: files matching multiple distinct query tokens get up to 2x multiplier
      const coverageRatio = Math.min(1.0, matchedCount / primaryTokens.length);
      match.score *= 1.0 + coverageRatio;
    }

    if (match.file.isTest) {
      if (intentHints.prefersTests) {
        match.score *= 1.3;
      } else {
        match.score *= 0.6; // Don't let test files drown out real implementation
      }
    }
    if (match.file.isConfig && intentHints.prefersConfig) {
      match.score *= 1.8;
    }
  }

  // 5. Deterministic ordering
  const ranked = Array.from(fileInfo.values()).sort(
    (a, b) => b.score - a.score || a.file.relativePath.localeCompare(b.file.relativePath)
  );
  const matchedSymbols = allHits
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.symbol.name.localeCompare(b.symbol.name) ||
        a.symbol.filePath.localeCompare(b.symbol.filePath) ||
        a.symbol.location.line - b.symbol.location.line
    )
    .slice(0, MAX_RANKED_SYMBOLS)
    .map((h) => h.symbol);

  return { ranked, matchedSymbols, dependencies: matchedDeps, queryTokens };
}

/** Short, deterministic explanation of why a file was selected. */
export function describeMatch(match: RankedFile): string {
  const parts: string[] = [];
  const top = match.symbolHits[0];
  if (top) {
    const how = top.exactName
      ? "exact name"
      : top.matchedWords.length > 0
        ? `matches ${top.matchedWords.join("+")}`
        : "partial name";
    parts.push(`symbol ${top.symbol.name} (${how})`);
    if (match.symbolHits.length > 1) parts.push(`+${match.symbolHits.length - 1} more symbol(s)`);
  }
  if (match.pathMatches.length > 0) {
    parts.push(`path matches ${Array.from(new Set(match.pathMatches)).slice(0, 3).join(", ")}`);
  }
  if (match.matchedDeps.length > 0) {
    parts.push(`imports ${match.matchedDeps[0].targetSpecifier}`);
  }
  return parts.length > 0 ? parts.join("; ") : "weak lexical match";
}

// ---------------------------------------------------------------------------
// Range selection
// ---------------------------------------------------------------------------

export interface RangeSelection {
  primary: LineRange;
  primarySymbol?: IndexedSymbol;
  more: Array<LineRange & { symbol: string }>;
  wholeFile: boolean;
}

/** Declaration range of a symbol, clamped to the file, with a little leading context. */
function symbolRange(sym: IndexedSymbol, lineCount: number): LineRange {
  const start = Math.max(1, sym.location.line - SNIPPET_CONTEXT_BEFORE);
  const declEnd = sym.location.endLine ?? Math.min(lineCount, sym.location.line + 45);
  const end = Math.min(lineCount, Math.max(declEnd, sym.location.line));
  return { startLine: start, endLine: end };
}

/**
 * Pick what to read from a ranked file: the declaration of its best-scored
 * symbol (not simply the first one found), widened to include nearby
 * high-scoring symbols whose ranges overlap or touch it, bounded in lines.
 * Other worthwhile ranges are reported as metadata only.
 */
export function selectRanges(
  hits: readonly SymbolHit[],
  lineCount: number,
  wholeFileOk: boolean
): RangeSelection {
  const total = Math.max(1, lineCount);
  if (wholeFileOk && total <= SMALL_FILE_LINES) {
    return {
      primary: { startLine: 1, endLine: total },
      primarySymbol: hits[0]?.symbol,
      more: [],
      wholeFile: true,
    };
  }
  if (hits.length === 0) {
    return {
      primary: { startLine: 1, endLine: Math.min(total, HEAD_LINES) },
      more: [],
      wholeFile: total <= HEAD_LINES,
    };
  }

  const best = hits[0];
  let primary = symbolRange(best.symbol, total);
  let capped = false;
  if (primary.endLine - primary.startLine + 1 > MAX_SNIPPET_LINES) {
    primary = { startLine: primary.startLine, endLine: primary.startLine + MAX_SNIPPET_LINES - 1 };
    capped = true;
  }

  const more: Array<LineRange & { symbol: string }> = [];
  const floor = best.score * 0.4;
  for (const hit of hits.slice(1)) {
    if (hit.score < floor) continue;
    const r = symbolRange(hit.symbol, total);
    const touches =
      r.startLine <= primary.endLine + MERGE_GAP_LINES &&
      r.endLine >= primary.startLine - MERGE_GAP_LINES;
    if (touches && !capped) {
      const merged = {
        startLine: Math.min(primary.startLine, r.startLine),
        endLine: Math.max(primary.endLine, r.endLine),
      };
      if (merged.endLine - merged.startLine + 1 <= MAX_MERGED_SNIPPET_LINES) {
        primary = merged;
        continue;
      }
    }
    // Skip a range already covered by the primary or by a kept secondary.
    const covered =
      (r.startLine >= primary.startLine && r.endLine <= primary.endLine) ||
      more.some((m) => r.startLine >= m.startLine && r.endLine <= m.endLine);
    if (!covered && more.length < MAX_MORE_RANGES) {
      more.push({ ...r, symbol: hit.symbol.name });
    }
  }
  more.sort((a, b) => a.startLine - b.startLine);
  return { primary, primarySymbol: best.symbol, more, wholeFile: false };
}

/** Rough source-token estimate for a line range without reading the file (bytes / 4, proportional). */
export function estimateRangeTokens(file: IndexedFile, range: LineRange): number {
  const lines = file.lineCount && file.lineCount > 0 ? file.lineCount : 0;
  if (lines === 0) return estimateOmissionTokens(file.sizeBytes);
  const span = Math.max(1, Math.min(lines, range.endLine) - Math.max(1, range.startLine) + 1);
  return Math.max(1, Math.ceil((file.sizeBytes * (span / lines)) / 4));
}

// ---------------------------------------------------------------------------
// Retrieval (ranking + safe source snippets under a token budget)
// ---------------------------------------------------------------------------

export interface SnippetRead {
  status: SourceReadStatus;
  snippet?: string;
  startLine?: number;
  endLine?: number;
  /** Token estimate of `snippet` (heuristic unless a tokenizer was supplied). */
  tokens?: number;
  /** Full-source hash (or the indexed hash when stat metadata is unchanged). */
  contentHash?: string;
  changedSinceIndex?: boolean;
  moreRanges?: Array<LineRange & { symbol: string }>;
  /** The snippet was cut to fit `remainingTokens`. */
  truncated?: boolean;
  /** The snippet did not fit `remainingTokens` and was not produced. */
  overBudget?: boolean;
  sizeBytes?: number;
}

/**
 * Read the snippet for one ranked file: the range around its best-scored
 * symbol, bounded by `remainingTokens`. All filesystem protections come from
 * `readIndexedSource`.
 */
export function readSnippet(
  index: ProjectIndex,
  item: RankedFile,
  remainingTokens: number,
  tokenizer?: TokenizerFunction
): SnippetRead {
  const read = readIndexedSource(index, item.file.relativePath);
  if (read.status !== "ok" || read.content === undefined) {
    return { status: read.status, sizeBytes: read.sizeBytes };
  }
  const content = read.content;
  const lines = content.split("\n");
  const selection = selectRanges(item.symbolHits, lines.length, content.length <= 3000);
  const startLine = Math.max(1, Math.min(selection.primary.startLine, lines.length));
  let endLine = Math.max(startLine, Math.min(selection.primary.endLine, lines.length));
  let snippet = lines.slice(startLine - 1, endLine).join("\n");
  let tokens = estimateTokens(snippet, tokenizer).estimatedTokens;
  let truncated = false;

  if (tokens > remainingTokens) {
    // Not enough budget for the whole range: keep a prefix when it is worth
    // having (>150 tokens), otherwise report that it did not fit.
    if (remainingTokens <= 150) {
      return {
        status: "ok",
        overBudget: true,
        tokens,
        startLine,
        endLine,
        contentHash: read.contentHash,
        changedSinceIndex: read.changedSinceIndex || undefined,
        moreRanges: selection.more.length > 0 ? selection.more : undefined,
      };
    }
    const cut = truncateToTokenBudget(snippet, remainingTokens, tokenizer);
    snippet = cut.text;
    tokens = cut.metrics.estimatedTokens;
    truncated = true;
    // Keep the reported range in step with the text actually returned.
    const keptLines = snippet.length === 0 ? 0 : snippet.split("\n").length;
    endLine = Math.max(startLine, startLine + keptLines - 1);
  }

  return {
    status: "ok",
    snippet,
    startLine,
    endLine,
    tokens,
    truncated: truncated || undefined,
    contentHash: read.contentHash,
    changedSinceIndex: read.changedSinceIndex || undefined,
    moreRanges: selection.more.length > 0 ? selection.more : undefined,
  };
}

/**
 * Deterministic relevance search over indexed symbols, file paths and
 * dependencies, returning source snippets chosen around each file's best
 * symbol and bounded by a token budget.
 */
export function retrieveContext(
  index: ProjectIndex,
  query: string,
  options: {
    tokenBudget?: number;
    fileBudget?: number;
    includeTests?: boolean;
    tokenizer?: TokenizerFunction;
    /**
     * Stop once a file scores below this fraction of the best match (0 = off).
     * Skipped files are reported as `low_relevance`, not silently dropped.
     */
    minScoreRatio?: number;
    /** Files kept regardless of `minScoreRatio`, so a weak top match still gets neighbours. */
    minFiles?: number;
  } = {}
): RetrievalResult {
  // Non-finite budgets (NaN, ±Infinity) fall back to the default instead of
  // silently voiding the bound below (comparisons against NaN are always
  // false, which would invert the include/omit decisions).
  const rawTokenBudget = options.tokenBudget ?? 3500;
  const tokenBudget = Math.min(
    Math.max(Number.isFinite(rawTokenBudget) ? rawTokenBudget : 3500, 200),
    20000
  );
  const rawFileBudget = options.fileBudget ?? 8;
  const fileBudget = Math.min(
    Math.max(Number.isFinite(rawFileBudget) ? Math.floor(rawFileBudget) : 8, 1),
    20
  );

  const ranking = rankCandidates(index, query, { includeTests: options.includeTests });
  const sortedFiles = ranking.ranked;

  const matchedFiles: ScoredFileMatch[] = [];
  const omissions: ContextOmission[] = [];
  let omissionsTotal = 0;
  const addOmission = (o: ContextOmission): void => {
    omissionsTotal++;
    if (omissions.length < MAX_OMISSIONS) omissions.push(o);
  };
  const staleFiles: string[] = [];
  const seenContentHashes = new Set<string>();
  let currentTokens = 0;
  const minScoreRatio =
    Number.isFinite(options.minScoreRatio) && (options.minScoreRatio as number) > 0
      ? Math.min(options.minScoreRatio as number, 1)
      : 0;
  const minFiles = Math.max(1, Math.floor(options.minFiles ?? 1));
  const scoreFloor =
    minScoreRatio > 0 && sortedFiles.length > 0 ? sortedFiles[0].score * minScoreRatio : 0;

  for (const item of sortedFiles) {
    const rel = item.file.relativePath;
    const sizeTokens = estimateOmissionTokens(item.file.sizeBytes);

    // Decided before any file is read: a weak match costs no I/O and no tokens.
    if (scoreFloor > 0 && matchedFiles.length >= minFiles && item.score < scoreFloor) {
      addOmission({
        type: "file",
        identifier: rel,
        reason: "low_relevance",
        estimatedTokens: sizeTokens,
      });
      continue;
    }

    if (matchedFiles.length >= fileBudget) {
      addOmission({
        type: "file",
        identifier: rel,
        reason: "budget_exceeded",
        estimatedTokens: sizeTokens,
      });
      continue;
    }

    const snip = readSnippet(index, item, tokenBudget - currentTokens, options.tokenizer);
    switch (snip.status) {
      case "untrusted":
      case "binary":
        addOmission({
          type: "file",
          identifier: rel,
          reason: "untrusted",
          estimatedTokens: sizeTokens,
        });
        continue;
      case "missing":
        staleFiles.push(rel);
        addOmission({
          type: "file",
          identifier: rel,
          reason: "stale",
          estimatedTokens: sizeTokens,
        });
        continue;
      case "too_large":
        addOmission({
          type: "file",
          identifier: rel,
          reason: "budget_exceeded",
          estimatedTokens: estimateOmissionTokens(snip.sizeBytes ?? item.file.sizeBytes),
        });
        continue;
      case "ok":
        break;
      default:
        continue; // not_file / not_indexed: nothing to report
    }

    if (snip.changedSinceIndex) staleFiles.push(rel);

    // Duplicate content elimination: keep only the higher-ranked of identical files.
    const contentHash = snip.contentHash as string;
    if (seenContentHashes.has(contentHash)) continue;
    seenContentHashes.add(contentHash);

    if (snip.overBudget || snip.snippet === undefined) {
      addOmission({
        type: "file",
        identifier: rel,
        reason: "budget_exceeded",
        estimatedTokens: snip.tokens ?? sizeTokens,
      });
      continue;
    }

    matchedFiles.push({
      ...item,
      snippet: snip.snippet,
      startLine: snip.startLine,
      endLine: snip.endLine,
      moreRanges: snip.moreRanges,
      changedSinceIndex: snip.changedSinceIndex,
    });
    currentTokens += snip.tokens ?? 0;
  }

  return {
    matchedFiles,
    matchedSymbols: ranking.matchedSymbols,
    dependencies: ranking.dependencies,
    omissions,
    omissionsTotal,
    candidateCount: sortedFiles.length,
    usedTokens: currentTokens,
    staleFiles,
  };
}
