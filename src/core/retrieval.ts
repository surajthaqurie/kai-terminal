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
import { estimateTokens, truncateToTokenBudget } from "./tokenCounter";

export interface ScoredFileMatch {
  file: IndexedFile;
  score: number;
  matchedSymbols: IndexedSymbol[];
  matchedDeps: IndexedDependency[];
  startLine?: number;
  endLine?: number;
  snippet?: string;
}

export interface RetrievalResult {
  matchedFiles: ScoredFileMatch[];
  matchedSymbols: IndexedSymbol[];
  dependencies: IndexedDependency[];
  omissions: ContextOmission[];
  usedTokens: number;
  staleFiles: string[];
}

export const COMMON_TASK_STOP_WORDS = new Set([
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
  } = {}
): RetrievalResult {
  const tokenBudget = Math.min(Math.max(options.tokenBudget ?? 3500, 200), 20000);
  const rawFileBudget = options.fileBudget ?? 8;
  const fileBudget = Math.min(
    Math.max(Number.isFinite(rawFileBudget) ? Math.floor(rawFileBudget) : 8, 1),
    20
  );
  const includeTests = options.includeTests ?? true;
  const safeQuery = query.slice(0, 2000);

  const rawTokens = safeQuery.toLowerCase().match(/\w+/g) || [];
  let queryTokens = Array.from(new Set(rawTokens)).filter((t) => t.length > 2);
  if (queryTokens.length === 0 && rawTokens.length > 0) {
    // Short-symbol fallback: a query like "c" or "go" would otherwise match
    // nothing (single-letter symbols are common in C/Rust/Go-adjacent code).
    // Only applies when the length filter removed everything, so normal
    // multi-token queries are unaffected.
    queryTokens = Array.from(new Set(rawTokens));
  }

  const fileScores = new Map<string, ScoredFileMatch>();

  // 1. Symbol matching (highest priority boost)
  const matchedSymbols: IndexedSymbol[] = [];
  for (const [symName, syms] of Object.entries(index.symbolIndex)) {
    const symLower = symName.toLowerCase();
    for (const q of queryTokens) {
      const isStopWord = COMMON_TASK_STOP_WORDS.has(q);
      let boost = 0;
      if (symLower === q) {
        boost = isStopWord ? 2.0 : 10.0; // Exact symbol match
      } else if (!isStopWord && symLower.includes(q)) {
        boost = 3.0; // Partial symbol match only for non-stop-words
      }

      if (boost > 0) {
        for (const sym of syms) {
          matchedSymbols.push(sym);
          // Windows legacy indexes stored backslash paths; normalize so
          // lookups succeed regardless of which separator was persisted.
          const normKey = sym.filePath.replace(/\\/g, "/");
          const file =
            (Object.prototype.hasOwnProperty.call(index.files, sym.filePath)
              ? index.files[sym.filePath]
              : undefined) ??
            (Object.prototype.hasOwnProperty.call(index.files, normKey)
              ? index.files[normKey]
              : undefined);
          if (file) {
            const existing = fileScores.get(normKey) || {
              file,
              score: 0,
              matchedSymbols: [],
              matchedDeps: [],
            };
            existing.score += boost;
            if (
              !existing.matchedSymbols.some(
                (s) => s.name === sym.name && s.location.line === sym.location.line
              )
            ) {
              existing.matchedSymbols.push(sym);
            }
            fileScores.set(normKey, existing);
          }
        }
      }
    }
  }

  // 2. File path and name matching
  for (const [relPath, file] of Object.entries(index.files)) {
    if (!includeTests && file.isTest) continue;

    // Normalize for cross-platform matching: `path.basename` on POSIX
    // does not split Windows `\` separators.
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
      } else if (baseName.includes(q)) {
        pathScore += isStopWord ? 1.0 : 6.0; // File name match
      } else if (!isStopWord && pathLower.includes(q)) {
        pathScore += 2.0; // Directory match
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
  for (const file of Object.values(index.files)) {
    for (const dep of file.dependencies) {
      const specLower = dep.targetSpecifier.toLowerCase();
      for (const q of queryTokens) {
        if (specLower.includes(q)) {
          matchedDeps.push(dep);
          const existing = fileScores.get(file.relativePath.replace(/\\/g, "/"));
          if (existing) {
            existing.score += 1.5;
            existing.matchedDeps.push(dep);
          }
        }
      }
    }
  }

  // Sort files by descending relevance score
  const sortedFiles = Array.from(fileScores.values()).sort((a, b) => b.score - a.score);

  const matchedFiles: ScoredFileMatch[] = [];
  const omissions: ContextOmission[] = [];
  const staleFiles: string[] = [];
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

    // Read file snippet or content safely, confined to the project root.
    // The index itself is trusted local data, but a corrupted index.json
    // must not become a path-traversal primitive.
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
      const realBase = fs.realpathSync(index.meta.canonicalPath);
      const realTarget = fs.realpathSync(joined);
      if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
        omissions.push({
          type: "file",
          identifier: item.file.relativePath,
          reason: "untrusted",
          estimatedTokens: Math.max(1, Math.ceil(item.file.sizeBytes / 4)),
        });
        continue;
      }
      const stat = fs.statSync(realTarget);
      if (!stat.isFile() || stat.size > 512 * 1024) continue;
      content = fs.readFileSync(realTarget, "utf-8");

      if (item.file.sha256) {
        const liveSha256 = crypto.createHash("sha256").update(content).digest("hex");
        if (liveSha256 !== item.file.sha256) {
          staleFiles.push(item.file.relativePath);
        }
      }
    } catch {
      continue; // Unreadable
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

    const snippetTokens = estimateTokens(snippet).estimatedTokens;

    if (currentTokens + snippetTokens > tokenBudget) {
      // Try truncating this snippet if budget has room, then keep packing
      // smaller later files instead of discarding everything after the
      // first over-budget file.
      const remainingTokens = tokenBudget - currentTokens;
      if (remainingTokens > 200) {
        const truncated = truncateToTokenBudget(snippet, remainingTokens);
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
