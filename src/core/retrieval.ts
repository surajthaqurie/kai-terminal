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

export interface ScoredFileMatch {
  file: IndexedFile;
  score: number;
  matchedSymbols: IndexedSymbol[];
  matchedDeps: IndexedDependency[];
  startLine?: number;
  endLine?: number;
  snippet?: string;
  matchedTokenCount?: number;
}

export interface RetrievalResult {
  matchedFiles: ScoredFileMatch[];
  matchedSymbols: IndexedSymbol[];
  dependencies: IndexedDependency[];
  omissions: ContextOmission[];
  usedTokens: number;
  staleFiles: string[];
}

// Bounds for per-query match accumulation. Symbol tables are unbounded
// (generated files can export thousands of symbols), and the per-file
// matchedSymbols dedup scan below is linear — without a cap, one
// pathological file turns retrieval quadratic (measured: ~1.3 s for a
// single 6000-symbol file vs ~15 ms for a realistic 100-file project).
// Consumers only read the top entries (assembler slices 15 symbols), so
// capping changes nothing for realistic inputs. Insertion order is
// preserved, keeping results deterministic.
const MAX_MATCHED_SYMBOLS_PER_FILE = 500;
const MAX_RANKED_SYMBOLS = 1000;

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

interface ScoredSymbolMatch {
  symbol: IndexedSymbol;
  score: number;
}

/**
 * Checks if a relative path looks like a credential or secret file.
 */
function isPotentialSecretPath(relPath: string): boolean {
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

/**
 * Deterministic relevance search over indexed symbols, file paths, dependencies, and content
 */
export function retrieveContext(
  index: ProjectIndex,
  query: string,
  options: {
    tokenBudget?: number;
    fileBudget?: number;
    includeTests?: boolean;
    tokenizer?: TokenizerFunction;
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
  const safeQuery = (query || "").slice(0, 2000);

  // Extract query tokens with camelCase/snake_case decomposition & intent analysis
  const extracted = extractSearchTokens(safeQuery);
  const intentHints = extracted.intentHints;

  const includeTests = options.includeTests ?? true;

  const rawTokens = safeQuery.toLowerCase().match(/\w+/g) || [];
  let queryTokens = extracted.tokens.filter((t) => t.length > 2);
  if (queryTokens.length === 0 && extracted.tokens.length > 0) {
    queryTokens = extracted.tokens;
  } else if (queryTokens.length === 0 && rawTokens.length > 0) {
    queryTokens = Array.from(new Set(rawTokens));
  }

  // Filter out stop words from primary tokens list for coverage metrics,
  // but keep stop words for fallback matching
  const nonStopQueryTokens = queryTokens.filter((t) => !COMMON_TASK_STOP_WORDS.has(t));
  const primaryTokens = nonStopQueryTokens.length > 0 ? nonStopQueryTokens : queryTokens;

  const fileScores = new Map<string, ScoredFileMatch>();
  const fileMatchedTokens = new Map<string, Set<string>>();
  const symbolCandidateMap = new Map<string, ScoredSymbolMatch>();

  function recordTokenMatch(normPath: string, token: string) {
    let set = fileMatchedTokens.get(normPath);
    if (!set) {
      set = new Set<string>();
      fileMatchedTokens.set(normPath, set);
    }
    set.add(token);
  }

  // 1. Symbol matching (highest priority boost)
  for (const [symName, syms] of Object.entries(index.symbolIndex)) {
    const symLower = symName.toLowerCase();

    for (const q of queryTokens) {
      const isStopWord = COMMON_TASK_STOP_WORDS.has(q);
      let boost = 0;
      let symScore = 0;

      if (symLower === q) {
        boost = isStopWord ? 2.0 : 12.0; // Exact symbol match
        symScore = isStopWord ? 2.0 : 15.0;
      } else if (!isStopWord && (symLower.startsWith(q) || symLower.endsWith(q))) {
        boost = 5.0; // Prefix or suffix match
        symScore = 7.0;
      } else if (!isStopWord && symLower.includes(q)) {
        boost = 3.0; // Substring symbol match
        symScore = 4.0;
      }

      if (boost > 0) {
        for (const sym of syms) {
          const normKey = sym.filePath.replace(/\\/g, "/");
          const file =
            (Object.prototype.hasOwnProperty.call(index.files, sym.filePath)
              ? index.files[sym.filePath]
              : undefined) ??
            (Object.prototype.hasOwnProperty.call(index.files, normKey)
              ? index.files[normKey]
              : undefined);

          if (file) {
            recordTokenMatch(normKey, q);
            const existing = fileScores.get(normKey) || {
              file,
              score: 0,
              matchedSymbols: [],
              matchedDeps: [],
            };
            existing.score += boost;
            if (
              existing.matchedSymbols.length < MAX_MATCHED_SYMBOLS_PER_FILE &&
              !existing.matchedSymbols.some(
                (s) => s.name === sym.name && s.location.line === sym.location.line
              )
            ) {
              existing.matchedSymbols.push(sym);
            }
            fileScores.set(normKey, existing);

            // Record scored symbol candidate
            const symKey = `${normKey}:${sym.name}:${sym.location.line}`;
            const existingSym = symbolCandidateMap.get(symKey);
            const finalScore = symScore + (sym.isExported ? 2.0 : 0.0);
            if (!existingSym || existingSym.score < finalScore) {
              symbolCandidateMap.set(symKey, { symbol: sym, score: finalScore });
            }
          }
        }
      }
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
    for (const q of queryTokens) {
      const isStopWord = COMMON_TASK_STOP_WORDS.has(q);
      const isPluralStemMatch =
        (baseWithoutExt.endsWith("s") && baseWithoutExt.slice(0, -1) === q) ||
        (q.endsWith("s") && q.slice(0, -1) === baseWithoutExt);

      if (baseWithoutExt === q || isPluralStemMatch) {
        pathScore += isStopWord ? 5.0 : 25.0; // Exact or singular/plural filename stem match
        recordTokenMatch(normRel, q);
      } else if (baseName === q) {
        pathScore += isStopWord ? 4.0 : 20.0;
        recordTokenMatch(normRel, q);
      } else if (baseName.includes(q)) {
        pathScore += isStopWord ? 1.0 : 6.0; // File name match
        recordTokenMatch(normRel, q);
      } else if (!isStopWord && pathLower.includes(q)) {
        pathScore += 2.0; // Directory match
        recordTokenMatch(normRel, q);
      }
    }

    if (pathScore > 0) {
      const existing = fileScores.get(normRel) || {
        file,
        score: 0,
        matchedSymbols: [],
        matchedDeps: [],
      };
      existing.score += pathScore;
      fileScores.set(normRel, existing);
    }
  }

  // 3. Dependency matching
  const matchedDeps: IndexedDependency[] = [];
  const seenDeps = new Set<string>();
  for (const file of Object.values(index.files)) {
    for (const dep of file.dependencies) {
      const specLower = dep.targetSpecifier.toLowerCase();
      for (const q of queryTokens) {
        if (specLower.includes(q)) {
          const depKey = `${dep.sourceFile}:${dep.targetSpecifier}`;
          if (!seenDeps.has(depKey)) {
            seenDeps.add(depKey);
            matchedDeps.push(dep);
          }
          const normSource = file.relativePath.replace(/\\/g, "/");
          const existing = fileScores.get(normSource);
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
  }

  // 4. Multi-token coverage boost & intent adjustments
  for (const [normRel, match] of fileScores.entries()) {
    const matchedSet = fileMatchedTokens.get(normRel);
    const matchedCount = matchedSet ? matchedSet.size : 0;
    match.matchedTokenCount = matchedCount;

    if (primaryTokens.length > 1 && matchedCount > 0) {
      // Conjunction boost: files matching multiple distinct query tokens get up to 2x multiplier
      const coverageRatio = Math.min(1.0, matchedCount / primaryTokens.length);
      match.score *= 1.0 + coverageRatio;
    }

    // Category intent adjustments:
    // If testing intent, boost test files; if non-test intent, downweight test files
    if (match.file.isTest) {
      if (intentHints.prefersTests) {
        match.score *= 1.3;
      } else {
        match.score *= 0.6; // Don't let test files drown out real implementation
      }
    }

    // If config intent, boost config files
    if (match.file.isConfig && intentHints.prefersConfig) {
      match.score *= 1.8;
    }
  }

  // 5. Deterministic sorting: highest score first, then lexicographical path tie-breaker
  const sortedFiles = Array.from(fileScores.values()).sort(
    (a, b) => b.score - a.score || a.file.relativePath.localeCompare(b.file.relativePath)
  );

  // 6. Ranked symbols (bounded: see MAX_RANKED_SYMBOLS above)
  const matchedSymbols = Array.from(symbolCandidateMap.values())
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.symbol.name.localeCompare(b.symbol.name) ||
        a.symbol.filePath.localeCompare(b.symbol.filePath) ||
        a.symbol.location.line - b.symbol.location.line
    )
    .slice(0, MAX_RANKED_SYMBOLS)
    .map((s) => s.symbol);

  const matchedFiles: ScoredFileMatch[] = [];
  const omissions: ContextOmission[] = [];
  const staleFiles: string[] = [];
  const seenContentHashes = new Set<string>();
  let currentTokens = 0;

  for (let i = 0; i < sortedFiles.length; i++) {
    const item = sortedFiles[i];

    if (matchedFiles.length >= fileBudget) {
      omissions.push({
        type: "file",
        identifier: item.file.relativePath,
        reason: "budget_exceeded",
        estimatedTokens: Math.max(1, Math.ceil(item.file.sizeBytes / 4)),
      });
      continue;
    }

    // Check potential secret file pattern before opening
    if (isPotentialSecretPath(item.file.relativePath)) {
      omissions.push({
        type: "file",
        identifier: item.file.relativePath,
        reason: "untrusted",
        estimatedTokens: Math.max(1, Math.ceil(item.file.sizeBytes / 4)),
      });
      continue;
    }

    // Read file snippet safely confined to the project root
    let content = "";
    try {
      const joined = path.join(index.meta.canonicalPath, item.file.relativePath);
      const lexicalBase = path.resolve(index.meta.canonicalPath);
      const lexicalTarget = path.resolve(joined);
      if (lexicalTarget !== lexicalBase && !lexicalTarget.startsWith(lexicalBase + path.sep)) {
        omissions.push({
          type: "file",
          identifier: item.file.relativePath,
          reason: "untrusted",
          estimatedTokens: Math.max(1, Math.ceil(item.file.sizeBytes / 4)),
        });
        continue;
      }

      let realBase: string;
      let realTarget: string;
      try {
        realBase = fs.realpathSync(index.meta.canonicalPath);
        realTarget = fs.realpathSync(joined);
      } catch {
        // File missing on disk (deleted/renamed)
        staleFiles.push(item.file.relativePath);
        omissions.push({
          type: "file",
          identifier: item.file.relativePath,
          reason: "stale",
          estimatedTokens: Math.max(1, Math.ceil(item.file.sizeBytes / 4)),
        });
        continue;
      }

      if (!isWithinProjectBoundary(realTarget, realBase)) {
        omissions.push({
          type: "file",
          identifier: item.file.relativePath,
          reason: "untrusted",
          estimatedTokens: Math.max(1, Math.ceil(item.file.sizeBytes / 4)),
        });
        continue;
      }

      const stat = fs.statSync(realTarget);
      if (!stat.isFile()) continue;

      if (stat.size > 512 * 1024) {
        omissions.push({
          type: "file",
          identifier: item.file.relativePath,
          reason: "budget_exceeded",
          estimatedTokens: Math.max(1, Math.ceil(stat.size / 4)),
        });
        continue;
      }

      content = fs.readFileSync(realTarget, "utf-8");

      // Verify content does not leak private keys or tokens
      if (containsSecretContent(content)) {
        omissions.push({
          type: "file",
          identifier: item.file.relativePath,
          reason: "untrusted",
          estimatedTokens: Math.max(1, Math.ceil(stat.size / 4)),
        });
        continue;
      }

      // Staleness fast path: the indexer reuses cache entries on this exact
      // size+mtime(+ctime) predicate, so a match means the bytes are
      // unchanged since indexing and the extra sha256 pass over the content
      // can be skipped. Any mismatch falls through to the full hash
      // comparison below, which stays the ground truth.
      const statMatchesIndex =
        stat.size === item.file.sizeBytes &&
        stat.mtimeMs === item.file.mtimeMs &&
        (item.file.ctimeMs === undefined ||
          stat.ctimeMs === undefined ||
          stat.ctimeMs === item.file.ctimeMs);

      // Check for content hash match with disk (staleness detection)
      if (item.file.sha256 && !statMatchesIndex) {
        const liveSha256 = crypto.createHash("sha256").update(content).digest("hex");
        if (liveSha256 !== item.file.sha256) {
          staleFiles.push(item.file.relativePath);
        }
      }

      // Duplicate content elimination:
      // If two files in the repository share identical content hash, keep only the higher-ranked
      const contentHash =
        item.file.sha256 || crypto.createHash("sha256").update(content).digest("hex");
      if (seenContentHashes.has(contentHash)) {
        continue;
      }
      seenContentHashes.add(contentHash);
    } catch {
      staleFiles.push(item.file.relativePath);
      continue;
    }

    // Determine targeted line range if symbols matched
    let snippet = content;
    let startLine: number | undefined;
    let endLine: number | undefined;

    if (item.matchedSymbols.length > 0 && content.length > 2000) {
      // Focus on lines around the first matched symbol
      const lines = content.split("\n");
      const targetLine = item.matchedSymbols[0].location.line;
      startLine = Math.max(1, targetLine - 15);
      endLine = Math.min(lines.length, targetLine + 45);
      snippet = lines.slice(startLine - 1, endLine).join("\n");
    } else if (content.length > 3000) {
      // Bound large files without specific symbol focus to top 80 lines
      const lines = content.split("\n");
      startLine = 1;
      endLine = Math.min(lines.length, 80);
      snippet = lines.slice(0, endLine).join("\n");
    }

    const snippetTokens = estimateTokens(snippet, options.tokenizer).estimatedTokens;

    if (currentTokens + snippetTokens > tokenBudget) {
      const remainingTokens = tokenBudget - currentTokens;
      if (remainingTokens > 150) {
        const truncated = truncateToTokenBudget(snippet, remainingTokens, options.tokenizer);
        item.snippet = truncated.text;
        item.startLine = startLine;
        item.endLine = endLine;
        matchedFiles.push(item);
        currentTokens += truncated.metrics.estimatedTokens;
      } else {
        omissions.push({
          type: "file",
          identifier: item.file.relativePath,
          reason: "budget_exceeded",
          estimatedTokens: snippetTokens,
        });
      }
      continue;
    } else {
      item.snippet = snippet;
      item.startLine = startLine;
      item.endLine = endLine;
      matchedFiles.push(item);
      currentTokens += snippetTokens;
    }
  }

  return {
    matchedFiles,
    matchedSymbols,
    dependencies: matchedDeps,
    omissions,
    usedTokens: currentTokens,
    staleFiles,
  };
}
