import path from "path";
import type {
  IndexedDependency,
  IndexedSymbol,
  KnownStaleness,
  ProjectIndex,
  ProjectMeta,
  TaskCategory,
} from "./types";
import { assembleContext } from "./contextAssembler";
import {
  describeMatch,
  estimateRangeTokens,
  isPotentialSecretPath,
  rankCandidates,
  readIndexedSource,
  readSnippet,
  selectRanges,
  type RankedFile,
} from "./retrieval";
import { estimateTokens } from "./tokenCounter";
import { indexProject, isSensitiveFile, toPosixRel } from "./indexer";
import { detectInstalledLspServers } from "./lspBridge";
import {
  getValidatedFreshness,
  isCodeMode,
  planCodeTask,
  synchronizeGraphDeduped,
  type GraphFreshness,
  type RefreshOutcome,
} from "./codeModeWorkflow";
import { getReverseImports } from "./indexDerived";
import { isWithinProjectBoundary, resolveCanonicalPath } from "./registry";
import {
  clipChars,
  clipEscapedBytes,
  jsonEscapedBytes,
  pageFields,
  parsePageArgs,
  sliceWindow,
  type Shrinkable,
} from "./mcpResponse";
import { EXTRACTOR_VERSION } from "./symbolExtractor";

/** What the protocol layer already established before a tool runs. */
export interface ToolContext {
  meta: ProjectMeta;
  index: ProjectIndex;
  canonicalRoot: string;
  /** Result of the automatic freshness gate (graph-reading tools only). */
  gate: {
    freshness: GraphFreshness;
    refreshOutcome: RefreshOutcome;
    warning?: string;
    knownStaleness?: KnownStaleness;
  };
  /** Wire-byte ceiling and the bytes the JSON-RPC wrapper already costs. */
  maxBytes: number;
  wrapperBytes: number;
}

export interface ToolMetrics {
  resultCount?: number;
  sourceRanges?: number;
  retrievalMs?: number;
  graphSteps?: number;
  hasMore?: boolean;
}

export type ToolOutcome =
  | { kind: "error"; code: number; message: string }
  | {
      kind: "json";
      payload: Record<string, unknown>;
      shrink?: Shrinkable[];
      metrics?: ToolMetrics;
    }
  | { kind: "text"; text: string; preserve?: string; metrics?: ToolMetrics };

const fail = (message: string, code = -32602): ToolOutcome => ({ kind: "error", code, message });

export const VALID_CATEGORIES = new Set([
  "explain",
  "implement",
  "debug",
  "refactor",
  "test",
  "review",
  "architecture",
  "documentation",
  "unknown",
]);

function parseCategory(value: unknown): TaskCategory | undefined {
  return (typeof value === "string" && VALID_CATEGORIES.has(value) ? value : undefined) as
    TaskCategory | undefined;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const shortHash = (sha: string | undefined): string | undefined =>
  sha ? sha.slice(0, 16) : undefined;

/** Heuristic estimate of a text's size in tokens (see tokenCounter: not a model tokenizer). */
export function estimateTextTokens(text: string): number {
  return estimateTokens(text).estimatedTokens;
}

function freshnessFields(ctx: ToolContext): Record<string, unknown> {
  const scan = ctx.index.scan;
  return {
    freshness: ctx.gate.freshness,
    refreshOutcome: ctx.gate.refreshOutcome,
    ...(ctx.gate.warning ? { refreshWarning: clipChars(ctx.gate.warning, 300) } : {}),
    // Never present a capped scan as complete: say so on every graph read.
    ...(scan && !scan.complete
      ? {
          indexScan: {
            complete: false,
            fileLimitReached: scan.fileLimitReached,
            fileLimit: scan.fileLimit,
            depthLimitReached: scan.depthLimitReached,
            unreadableDirs: scan.unreadableDirs,
          },
        }
      : {}),
  };
}

function scanSummary(index: ProjectIndex): Record<string, unknown> | undefined {
  const s = index.scan;
  if (!s) return undefined;
  return {
    complete: s.complete,
    fileLimitReached: s.fileLimitReached,
    fileLimit: s.fileLimit,
    depthLimitReached: s.depthLimitReached,
    unreadableDirs: s.unreadableDirs,
    skippedByReason: s.skippedByReason,
  };
}

function changeCounts(index: ProjectIndex): Record<string, number> {
  const c = index.changes;
  return {
    added: c?.added.length ?? 0,
    modified: c?.modified.length ?? 0,
    renamed: c?.renamed.length ?? 0,
    deleted: c?.deleted.length ?? 0,
    skipped: c?.skippedCount ?? Object.keys(index.skipped ?? {}).length,
  };
}

function changeDetails(index: ProjectIndex): Array<Record<string, string>> {
  const c = index.changes;
  if (!c) return [];
  return [
    ...c.added.map((p) => ({ type: "added", path: p })),
    ...c.modified.map((p) => ({ type: "modified", path: p })),
    ...c.renamed.map((r) => ({ type: "renamed", path: r.to, from: r.from })),
    ...c.deleted.map((p) => ({ type: "deleted", path: p })),
  ];
}

// ---------------------------------------------------------------------------
// Shared argument validation
// ---------------------------------------------------------------------------

type PathCheck = { ok: true; rel: string } | { ok: false; message: string };

/**
 * Validate a project-relative path argument: no traversal, absolute or UNC
 * forms, null bytes or sensitive names, and the resolved location must stay
 * inside the project root.
 */
function checkRelativePath(raw: string, canonicalRoot: string): PathCheck {
  const rawRel = raw.trim().slice(0, 1024);
  // Normalize Windows separators so `src\a.ts` resolves like `src/a.ts`.
  const rel = rawRel.replace(/\\/g, "/");
  const isWindowsAbsolute = /^[a-zA-Z]:\//.test(rel) || rel.startsWith("//");
  if (
    !rel ||
    rel.includes("\0") ||
    rawRel.includes("\0") ||
    rel.split("/").includes("..") ||
    path.isAbsolute(rel) ||
    path.isAbsolute(rawRel) ||
    isWindowsAbsolute
  ) {
    return { ok: false, message: "Invalid filePath" };
  }
  // Never expose sensitive files (credentials, private keys, environment files)
  if (isSensitiveFile(rel) || isSensitiveFile(rawRel) || isSensitiveFile(path.basename(rel))) {
    return {
      ok: false,
      message: `Access denied: sensitive or excluded file: ${clipChars(rel, 200)}`,
    };
  }
  // Confine the file path to the authorized canonical project boundary
  let canonicalFile: string;
  try {
    canonicalFile = resolveCanonicalPath(path.join(canonicalRoot, rel));
  } catch {
    return { ok: false, message: `File not found in index: ${clipChars(rel, 200)}` };
  }
  if (!isWithinProjectBoundary(canonicalFile, canonicalRoot)) {
    return {
      ok: false,
      message: `File path escapes project boundary: ${clipChars(rel, 200)}`,
    };
  }
  return { ok: true, rel };
}

function indexedFile(index: ProjectIndex, rel: string) {
  return Object.prototype.hasOwnProperty.call(index.files, rel) ? index.files[rel] : undefined;
}

function compactSymbol(s: IndexedSymbol, signatureChars = 160): Record<string, unknown> {
  return {
    name: s.name,
    kind: s.kind,
    filePath: s.filePath,
    location: {
      line: s.location.line,
      column: s.location.column,
      ...(s.location.endLine !== undefined ? { endLine: s.location.endLine } : {}),
    },
    ...(s.signature ? { signature: clipChars(s.signature, signatureChars) } : {}),
    isExported: s.isExported,
    ...(s.container ? { container: s.container } : {}),
  };
}

function compactDependency(d: IndexedDependency, includeSource = false): Record<string, unknown> {
  const MAX_SYMBOLS = 20;
  return {
    ...(includeSource ? { sourceFile: d.sourceFile } : {}),
    targetSpecifier: clipChars(d.targetSpecifier, 200),
    ...(typeof d.resolvedPath === "string" ? { resolvedPath: d.resolvedPath } : {}),
    ...(d.resolution ? { resolution: d.resolution } : {}),
    isExternal: d.isExternal,
    importedSymbols: d.importedSymbols.slice(0, MAX_SYMBOLS),
    ...(d.importedSymbols.length > MAX_SYMBOLS
      ? { importedSymbolsTotal: d.importedSymbols.length }
      : {}),
  };
}

/** Patch the standard page fields after the shaper kept fewer than all items. */
function patchPage(offset: number, total: number, countKey?: string) {
  return (kept: number, payload: Record<string, unknown>): void => {
    const f = pageFields(total, offset, kept);
    payload.returned = f.returned;
    payload.hasMore = f.hasMore;
    if (f.nextOffset !== undefined) payload.nextOffset = f.nextOffset;
    else delete payload.nextOffset;
    if (countKey) payload[countKey] = kept;
  };
}

// ---------------------------------------------------------------------------
// kai_project_info
// ---------------------------------------------------------------------------

export function toolProjectInfo(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  if (args.includeChanges !== undefined && typeof args.includeChanges !== "boolean") {
    return fail("includeChanges must be a boolean");
  }
  const includeChanges = args.includeChanges === true;
  const page = includeChanges ? parsePageArgs(args, { defaultLimit: 50, maxLimit: 200 }) : null;
  if (page && !page.ok) return fail(page.message);

  const { index, meta } = ctx;
  const languages = new Map<string, number>();
  for (const file of Object.values(index.files)) {
    languages.set(file.language, (languages.get(file.language) ?? 0) + 1);
  }
  const sorted = Array.from(languages.entries()).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
  const MAX_LANGUAGES = 15;
  const languageBreakdown: Record<string, number> = {};
  for (const [lang, n] of sorted.slice(0, MAX_LANGUAGES)) languageBreakdown[lang] = n;

  // Truthful freshness without triggering a refresh here: read tools own the
  // bounded auto-refresh gate; project_info only reports. The pairing is
  // validated first so a torn snapshot never reports `fresh`.
  const freshness = getValidatedFreshness(meta.id, index);

  const payload: Record<string, unknown> = {
    name: meta.name,
    canonicalPath: meta.canonicalPath,
    schemaVersion: meta.schemaVersion,
    lastIndexedAt: meta.lastIndexedAt,
    status: meta.status,
    totalFiles: Object.keys(index.files).length,
    totalSymbols: Object.keys(index.symbolIndex).length,
    languageBreakdown,
    ...(sorted.length > MAX_LANGUAGES ? { otherLanguages: sorted.length - MAX_LANGUAGES } : {}),
    rulesCount: index.rules.length,
    freshness,
    changes: changeCounts(index),
    ...(scanSummary(index) ? { scan: scanSummary(index) } : {}),
    extractorVersion: index.extractorVersion ?? null,
    ...(index.extractorVersion !== EXTRACTOR_VERSION
      ? { note: "Symbols come from an older extractor; the next graph read refreshes them." }
      : {}),
  };

  const shrink: Shrinkable[] = [];
  let hasMore = false;
  if (page && page.ok) {
    const all = changeDetails(index);
    const items = sliceWindow(all, page);
    const f = pageFields(all.length, page.offset, items.length);
    Object.assign(payload, { changeDetails: items, ...f });
    hasMore = f.hasMore;
    shrink.push({ key: "changeDetails", patch: patchPage(page.offset, all.length) });
  }
  return { kind: "json", payload, shrink, metrics: { hasMore } };
}

// ---------------------------------------------------------------------------
// kai_search_code
// ---------------------------------------------------------------------------

const SEARCH_TOKEN_BUDGET = 4000;
const MAX_SYMBOLS_PER_RESULT = 5;

export function toolSearchCode(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  if (typeof args.query !== "string" || !args.query.trim()) {
    return fail("query parameter is required and must be a non-empty string");
  }
  const page = parsePageArgs(args, { defaultLimit: 6, maxLimit: 20 });
  if (!page.ok) return fail(page.message);
  if (args.includeSource !== undefined && typeof args.includeSource !== "boolean") {
    return fail("includeSource must be a boolean");
  }
  // Metadata-first: search answers "where", kai_read_range answers "what does
  // it say". Snippets are opt-in (`includeSource: true`), which restores the
  // previous snippet-bearing response shape.
  const includeSource = args.includeSource === true;
  const query = args.query.trim().slice(0, 2000);
  const { index } = ctx;

  const t0 = Date.now();
  const ranking = rankCandidates(index, query, { includeTests: true });
  // Candidates: never list secret-looking paths; identical content appears once.
  const eligible: RankedFile[] = [];
  const seenHashes = new Set<string>();
  let omittedUntrusted = 0;
  for (const r of ranking.ranked) {
    if (isPotentialSecretPath(r.file.relativePath)) {
      omittedUntrusted++;
      continue;
    }
    if (r.file.sha256) {
      if (seenHashes.has(r.file.sha256)) continue;
      seenHashes.add(r.file.sha256);
    }
    eligible.push(r);
  }
  const total = eligible.length;
  const window = sliceWindow(eligible, page);

  let remainingTokens = SEARCH_TOKEN_BUDGET;
  let sourceRanges = 0;
  const items: Array<Record<string, unknown>> = [];
  for (const r of window) {
    const lineCount =
      r.file.lineCount ??
      Math.max(
        1,
        ...r.symbolHits.map((h) => h.symbol.location.endLine ?? h.symbol.location.line + 45)
      );
    const selection = selectRanges(r.symbolHits, lineCount, true);
    const item: Record<string, unknown> = {
      relativePath: r.file.relativePath,
      score: round2(r.score),
      reason: describeMatch(r),
      contentHash: shortHash(r.file.sha256),
      startLine: selection.primary.startLine,
      endLine: selection.primary.endLine,
      symbols: r.symbolHits.slice(0, MAX_SYMBOLS_PER_RESULT).map((h) => ({
        name: h.symbol.name,
        kind: h.symbol.kind,
        startLine: h.symbol.location.line,
        ...(h.symbol.location.endLine !== undefined ? { endLine: h.symbol.location.endLine } : {}),
        ...(h.symbol.container ? { container: h.symbol.container } : {}),
      })),
      estimatedSourceTokens: estimateRangeTokens(r.file, selection.primary),
    };
    if (selection.more.length > 0) item.moreRanges = selection.more;

    if (includeSource) {
      const snip = readSnippet(index, r, remainingTokens);
      if (snip.status === "ok" && snip.snippet !== undefined) {
        item.startLine = snip.startLine;
        item.endLine = snip.endLine;
        item.estimatedSourceTokens = snip.tokens;
        item.snippet = snip.snippet;
        if (snip.contentHash) item.contentHash = shortHash(snip.contentHash);
        if (snip.moreRanges) item.moreRanges = snip.moreRanges;
        remainingTokens -= snip.tokens ?? 0;
        sourceRanges++;
      } else {
        item.sourceOmitted = true;
        item.sourceOmittedReason = snip.overBudget ? "token_budget" : snip.status;
      }
      if (snip.changedSinceIndex) item.sourceChanged = true;
    }
    items.push(item);
  }
  const retrievalMs = Date.now() - t0;

  const f = pageFields(total, page.offset, items.length);
  const payload: Record<string, unknown> = {
    query,
    ...freshnessFields(ctx),
    includeSource,
    tokenEstimate: includeSource ? "heuristic" : "bytes/4",
    matchesCount: items.length,
    ...f,
    ...(omittedUntrusted > 0 ? { omittedUntrusted } : {}),
    files: items,
  };
  return {
    kind: "json",
    payload,
    shrink: [
      {
        key: "files",
        lighten: (item) => {
          const { snippet: _snippet, ...rest } = item as Record<string, unknown>;
          void _snippet;
          return { ...rest, sourceOmitted: true, sourceOmittedReason: "response_limit" };
        },
        patch: patchPage(page.offset, total, "matchesCount"),
      },
    ],
    metrics: { resultCount: items.length, sourceRanges, retrievalMs, hasMore: f.hasMore },
  };
}

// ---------------------------------------------------------------------------
// kai_find_symbol
// ---------------------------------------------------------------------------

export function toolFindSymbol(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  if (typeof args.name !== "string" || !args.name.trim()) {
    return fail("name parameter is required and must be a non-empty string");
  }
  const name = args.name.trim().slice(0, 256);
  if (name.includes("\0") || /[./\\]/.test(name)) return fail("invalid symbol name");
  const page = parsePageArgs(args, { defaultLimit: 25, maxLimit: 100 });
  if (!page.ok) return fail(page.message);

  const { index } = ctx;
  const found =
    Object.prototype.hasOwnProperty.call(index.symbolIndex, name) &&
    Array.isArray(index.symbolIndex[name])
      ? index.symbolIndex[name]
      : [];
  // Stable order so pages never shuffle between calls.
  const ordered = found
    .slice()
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.location.line - b.location.line);
  const items = sliceWindow(ordered, page).map(compactSymbol);
  const f = pageFields(ordered.length, page.offset, items.length);
  return {
    kind: "json",
    payload: {
      symbolName: name,
      ...freshnessFields(ctx),
      foundCount: ordered.length,
      ...f,
      symbols: items,
    },
    shrink: [{ key: "symbols", patch: patchPage(page.offset, ordered.length) }],
    metrics: { resultCount: items.length, hasMore: f.hasMore },
  };
}

// ---------------------------------------------------------------------------
// kai_get_dependencies
// ---------------------------------------------------------------------------

export function toolGetDependencies(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  if (typeof args.filePath !== "string" || !args.filePath.trim()) {
    return fail("filePath parameter is required and must be a non-empty string");
  }
  if (args.includeDependents !== undefined && typeof args.includeDependents !== "boolean") {
    return fail("includeDependents must be a boolean");
  }
  const page = parsePageArgs(args, { defaultLimit: 50, maxLimit: 200 });
  if (!page.ok) return fail(page.message);

  const checked = checkRelativePath(args.filePath, ctx.canonicalRoot);
  if (!checked.ok) return fail(checked.message);
  const rawRel = args.filePath.trim().slice(0, 1024);
  const file = indexedFile(ctx.index, checked.rel) ?? indexedFile(ctx.index, rawRel);
  if (!file) return fail(`File not found in index: ${clipChars(checked.rel, 200)}`);

  const summary = { resolved: 0, unresolved: 0, packageOrAlias: 0, unsupported: 0, external: 0 };
  for (const d of file.dependencies) {
    if (d.isExternal) summary.external++;
    if (d.resolution === "resolved") summary.resolved++;
    else if (d.resolution === "unresolved") summary.unresolved++;
    else if (d.resolution === "non-relative") summary.packageOrAlias++;
    else if (d.resolution === "unsupported") summary.unsupported++;
  }
  const items = sliceWindow(file.dependencies, page).map((d) => compactDependency(d));
  const f = pageFields(file.dependencies.length, page.offset, items.length);

  const dependents = getReverseImports(ctx.index).get(file.relativePath) ?? [];
  const payload: Record<string, unknown> = {
    filePath: checked.rel,
    ...freshnessFields(ctx),
    dependenciesCount: file.dependencies.length,
    ...f,
    resolutionSummary: summary,
    dependentsCount: dependents.length,
    dependencies: items,
  };
  const shrink: Shrinkable[] = [
    { key: "dependencies", patch: patchPage(page.offset, file.dependencies.length) },
  ];
  if (args.includeDependents === true) {
    // Dependents page with the same offset/limit as dependencies, so a caller
    // can walk both lists; `dependentsHasMore` is separate from `hasMore`.
    const window = sliceWindow(dependents, page);
    payload.dependents = window;
    if (page.offset + window.length < dependents.length) {
      payload.dependentsHasMore = true;
      payload.dependentsNextOffset = page.offset + window.length;
    }
    shrink.push({ key: "dependents" });
  }
  return {
    kind: "json",
    payload,
    shrink,
    metrics: { resultCount: items.length, hasMore: f.hasMore },
  };
}

// ---------------------------------------------------------------------------
// kai_get_context
// ---------------------------------------------------------------------------

export function toolGetContext(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  if (typeof args.task !== "string" || !args.task.trim()) {
    return fail("task parameter is required and must be a non-empty string");
  }
  const task = args.task.trim().slice(0, 4000);
  // No explicit budget: the task category picks a starting budget and weak
  // matches are not padded in. An explicit budget is clamped and honoured as-is.
  const tokenBudget =
    typeof args.tokenBudget === "number"
      ? Math.min(
          Math.max(Number.isFinite(args.tokenBudget) ? Math.floor(args.tokenBudget) : 4000, 200),
          20000
        )
      : undefined;
  const categoryOverride = parseCategory(args.categoryOverride);

  // Stale fallback results must never look authoritative: when the freshness
  // gate could not produce a fresh graph, surface it inline (additive prefix
  // only; tool name/args unchanged).
  let prefix = "";
  if (ctx.gate.freshness !== "fresh") {
    const warnLine =
      ctx.gate.refreshOutcome === "refresh-failed"
        ? `> Graph freshness warning: refresh failed (${clipChars(ctx.gate.warning ?? "using last-known index", 300)}); results below are a stale fallback, not authoritative. Run kai_sync_graph or kai_refresh_index, then retry.`
        : `> Graph freshness note: index is ${ctx.gate.freshness}; results below may be incomplete. Run kai_sync_graph or kai_refresh_index for authoritative context.`;
    prefix = `${warnLine}\n\n`;
  }
  // The prompt shares the response ceiling with the wrapper and the warning
  // prefix; leave headroom for the truncation notice too.
  const textBudget = ctx.maxBytes - ctx.wrapperBytes - jsonEscapedBytes(prefix) - 256;

  const t0 = Date.now();
  const { renderedPrompt, contextPackage } = assembleContext(ctx.index, {
    task,
    tokenBudget,
    adaptiveBudget: true,
    categoryOverride,
    maxBytes: textBudget,
    knownStaleness: ctx.gate.knownStaleness,
  });
  const retrievalMs = Date.now() - t0;

  return {
    kind: "text",
    text: `${prefix}${renderedPrompt}`,
    preserve: task,
    metrics: { sourceRanges: contextPackage.sourceReferences.length, retrievalMs },
  };
}

// ---------------------------------------------------------------------------
// kai_refresh_index
// ---------------------------------------------------------------------------

export async function toolRefreshIndex(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  if (args.forceRebuild !== undefined && typeof args.forceRebuild !== "boolean") {
    return fail("forceRebuild must be a boolean");
  }
  if (args.includeChanges !== undefined && typeof args.includeChanges !== "boolean") {
    return fail("includeChanges must be a boolean");
  }
  const page =
    args.includeChanges === true ? parsePageArgs(args, { defaultLimit: 50, maxLimit: 200 }) : null;
  if (page && !page.ok) return fail(page.message);

  const t0 = Date.now();
  const refreshed = await indexProject(ctx.meta, { forceRebuild: Boolean(args.forceRebuild) });
  const payload: Record<string, unknown> = {
    refreshed: true,
    totalFiles: Object.keys(refreshed.files).length,
    totalSymbols: Object.keys(refreshed.symbolIndex).length,
    changes: changeCounts(refreshed),
    ...(scanSummary(refreshed) ? { scan: scanSummary(refreshed) } : {}),
    durationMs: Date.now() - t0,
    timestamp: refreshed.generatedAt,
  };
  const shrink: Shrinkable[] = [];
  let hasMore = false;
  if (page && page.ok) {
    const all = changeDetails(refreshed);
    const items = sliceWindow(all, page);
    const f = pageFields(all.length, page.offset, items.length);
    Object.assign(payload, { changeDetails: items, ...f });
    hasMore = f.hasMore;
    shrink.push({ key: "changeDetails", patch: patchPage(page.offset, all.length) });
  }
  return { kind: "json", payload, shrink, metrics: { hasMore } };
}

// ---------------------------------------------------------------------------
// kai_get_lsp_status
// ---------------------------------------------------------------------------

export function toolLspStatus(): ToolOutcome {
  const detected = detectInstalledLspServers();
  const available = detected.some((d) => d.isAvailable);
  const servers = detected.map((d) => ({
    language: d.language,
    command: clipChars(d.command, 120),
    isAvailable: d.isAvailable,
    ...(d.version ? { version: clipChars(d.version, 80) } : {}),
    ...(d.installHint ? { installHint: clipChars(d.installHint, 200) } : {}),
  }));
  return {
    kind: "json",
    payload: {
      lspBridgeAvailable: available,
      degradedMode: !available,
      ...(available
        ? {}
        : {
            degradedReason:
              "No local language servers detected. Operating in degraded syntax-only mode.",
          }),
      serversCount: servers.length,
      servers,
    },
    shrink: [{ key: "servers" }],
    metrics: { resultCount: servers.length },
  };
}

// ---------------------------------------------------------------------------
// kai_plan_task
// ---------------------------------------------------------------------------

export async function toolPlanTask(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const mode = typeof args.mode === "string" ? args.mode : "code";
  if (typeof args.task !== "string" || !args.task.trim()) {
    return fail("task parameter is required and must be a non-empty string");
  }
  // Mode isolation: other modes retain existing behavior (no options).
  if (!isCodeMode(mode)) {
    return {
      kind: "json",
      payload: {
        mode: clipChars(mode, 40),
        options: [],
        modePreserved: true,
        reason: "prompt options are Code Mode only",
      },
    };
  }
  const task = args.task.trim().slice(0, 4000);
  // Backward-compatible selected files: array form preferred, single string
  // alias accepted, absent when the task names no files.
  const rawSelected =
    args.selectedFiles !== undefined
      ? args.selectedFiles
      : args.selectedFile !== undefined
        ? args.selectedFile
        : undefined;
  const t0 = Date.now();
  const plan = await planCodeTask(ctx.meta, ctx.index, {
    task,
    categoryOverride: parseCategory(args.categoryOverride),
    selectedFiles: rawSelected,
  });
  const retrievalMs = Date.now() - t0;
  const { graphSteps, ...rest } = plan;
  const payload: Record<string, unknown> = {
    ...rest,
    dependencies: plan.dependencies.map((d) => compactDependency(d, true)),
    symbols: plan.symbols.map((s) => compactSymbol(s, 80)),
  };
  return {
    kind: "json",
    payload,
    // Required: category, freshness, project, options, note. Everything else is
    // advisory context, listed from least to most important to keep.
    shrink: [
      { key: "supportingFiles" },
      { key: "dependencies" },
      { key: "symbols" },
      { key: "inferredFiles" },
      { key: "rationale" },
      { key: "excludedSelections" },
      { key: "warnings" },
      { key: "relevantFiles" },
      { key: "selectedFiles" },
    ],
    metrics: { resultCount: plan.relevantFiles.length, retrievalMs, graphSteps },
  };
}

// ---------------------------------------------------------------------------
// kai_sync_graph
// ---------------------------------------------------------------------------

export async function toolSyncGraph(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const mode = typeof args.mode === "string" ? args.mode : "code";
  if (!isCodeMode(mode)) {
    return {
      kind: "json",
      payload: {
        mode: clipChars(mode, 40),
        synced: false,
        modePreserved: true,
        reason: "graph sync is Code Mode only",
      },
    };
  }
  const changedFiles = Array.isArray(args.changedFiles)
    ? (args.changedFiles as unknown[])
        .filter((f): f is string => typeof f === "string")
        .map((f) => clipChars(f, 1024))
        .slice(0, 50)
    : [];
  // Deduped: duplicate completion callbacks share one rebuild instead of
  // racing; project identity is verified before publishing.
  const report = await synchronizeGraphDeduped(
    ctx.meta,
    changedFiles,
    {
      ran: typeof args.codeValidationRan === "boolean" ? args.codeValidationRan : false,
      // Fail-closed: an omitted outcome must never be reported as passed.
      passed: typeof args.codeValidationPassed === "boolean" ? args.codeValidationPassed : false,
      detail:
        typeof args.codeValidationDetail === "string"
          ? args.codeValidationDetail.slice(0, 500)
          : "no validation detail provided",
    },
    {
      uncertain: typeof args.uncertain === "boolean" ? args.uncertain : false,
      forceFull: typeof args.forceFull === "boolean" ? args.forceFull : false,
    }
  );
  const payload: Record<string, unknown> = {
    ...report,
    message: clipChars(report.message, 500),
    ...(report.rejectedFiles
      ? {
          rejectedFiles: report.rejectedFiles.map((r) => ({
            path: clipChars(r.path, 200),
            reason: clipChars(r.reason, 200),
          })),
        }
      : {}),
    ...(report.warnings ? { warnings: report.warnings.map((w) => clipChars(w, 300)) } : {}),
  };
  return {
    kind: "json",
    payload,
    shrink: [{ key: "rejectedFiles" }, { key: "warnings" }],
  };
}

// ---------------------------------------------------------------------------
// kai_read_range
// ---------------------------------------------------------------------------

export const READ_RANGE_DEFAULT_LINES = 200;
export const READ_RANGE_MAX_LINES = 400;
const READ_RANGE_MAX_CONTEXT = 20;
const READ_RANGE_MAX_SOURCE_BYTES = 32 * 1024;
const MAX_CANDIDATES = 20;
/** Fixed fields around the source text (keys, hash, numbers, notices). */
const READ_RANGE_ENVELOPE_BYTES = 1200;

const intArg = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) ? v : null;

function candidateList(symbols: IndexedSymbol[]): Array<Record<string, unknown>> {
  return symbols.slice(0, MAX_CANDIDATES).map((s) => ({
    filePath: s.filePath,
    name: s.name,
    kind: s.kind,
    startLine: s.location.line,
    ...(s.location.endLine !== undefined ? { endLine: s.location.endLine } : {}),
    ...(s.container ? { container: s.container } : {}),
  }));
}

/**
 * Read one targeted source range (explicit lines or a symbol) from an indexed
 * file. Every protection of snippet retrieval applies via `readIndexedSource`;
 * the path is validated like any other file argument, and results report their
 * relative path only.
 */
export function toolReadRange(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  const { index } = ctx;
  const symbolArg =
    typeof args.symbol === "string" && args.symbol.trim() ? args.symbol.trim().slice(0, 256) : null;
  if (args.symbol !== undefined && symbolArg === null)
    return fail("symbol must be a non-empty string");
  if (args.filePath !== undefined && (typeof args.filePath !== "string" || !args.filePath.trim())) {
    return fail("filePath must be a non-empty string");
  }
  const hasLines = args.startLine !== undefined || args.endLine !== undefined;
  if (symbolArg && hasLines) return fail("provide either symbol or startLine/endLine, not both");
  if (!symbolArg && !hasLines) return fail("provide a symbol, or startLine and endLine");
  if (!symbolArg && args.filePath === undefined)
    return fail("filePath is required with startLine/endLine");

  let maxLines = READ_RANGE_DEFAULT_LINES;
  if (args.maxLines !== undefined) {
    const m = intArg(args.maxLines);
    if (m === null || m < 1) return fail("maxLines must be a positive integer");
    maxLines = Math.min(m, READ_RANGE_MAX_LINES);
  }
  let contextLines = 0;
  if (args.contextLines !== undefined) {
    const c = intArg(args.contextLines);
    if (c === null || c < 0) return fail("contextLines must be a non-negative integer");
    contextLines = Math.min(c, READ_RANGE_MAX_CONTEXT);
  }
  let expectedHash: string | undefined;
  if (args.expectedHash !== undefined) {
    if (typeof args.expectedHash !== "string" || !/^[0-9a-fA-F]{8,64}$/.test(args.expectedHash)) {
      return fail(
        "expectedHash must be 8-64 hex characters (the contentHash from a previous result)"
      );
    }
    expectedHash = args.expectedHash.toLowerCase();
  }

  let rel: string | null = null;
  if (typeof args.filePath === "string") {
    const checked = checkRelativePath(args.filePath, ctx.canonicalRoot);
    if (!checked.ok) return fail(checked.message);
    const norm = toPosixRel(checked.rel);
    if (!indexedFile(index, norm)) {
      return fail(`File not found in index: ${clipChars(norm, 200)}`);
    }
    rel = norm;
  }

  // Resolve the symbol (if any) to a single definition before touching disk.
  let startLine = 0;
  let endLine = 0;
  let symbolInfo: Record<string, unknown> | undefined;
  let symbolSpan = false;
  if (symbolArg) {
    const [containerPart, namePart] = symbolArg.includes(".")
      ? [
          symbolArg.slice(0, symbolArg.lastIndexOf(".")),
          symbolArg.slice(symbolArg.lastIndexOf(".") + 1),
        ]
      : [undefined, symbolArg];
    if (!namePart || /[\\/\0]/.test(symbolArg)) return fail("invalid symbol name");
    let pool: IndexedSymbol[] =
      Object.prototype.hasOwnProperty.call(index.symbolIndex, namePart) &&
      Array.isArray(index.symbolIndex[namePart])
        ? index.symbolIndex[namePart]
        : [];
    if (rel) pool = pool.filter((s) => toPosixRel(s.filePath) === rel);
    if (containerPart) pool = pool.filter((s) => s.container === containerPart);
    pool = pool
      .slice()
      .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.location.line - b.location.line);
    if (pool.length === 0) {
      return {
        kind: "json",
        payload: {
          status: "not_found",
          symbol: clipChars(symbolArg, 120),
          ...(rel ? { filePath: rel } : {}),
        },
      };
    }
    if (pool.length > 1) {
      return {
        kind: "json",
        payload: {
          status: "ambiguous",
          symbol: clipChars(symbolArg, 120),
          message:
            "Several definitions match; call again with filePath (and a container, e.g. Class.method) or explicit lines.",
          total: pool.length,
          returned: Math.min(pool.length, MAX_CANDIDATES),
          candidates: candidateList(pool),
        },
        shrink: [{ key: "candidates" }],
        metrics: { resultCount: Math.min(pool.length, MAX_CANDIDATES) },
      };
    }
    const sym = pool[0];
    rel = toPosixRel(sym.filePath);
    startLine = sym.location.line;
    endLine = sym.location.endLine ?? sym.location.line;
    symbolSpan = true;
    symbolInfo = {
      name: sym.name,
      kind: sym.kind,
      ...(sym.container ? { container: sym.container } : {}),
      declaredLines: [sym.location.line, sym.location.endLine ?? sym.location.line],
    };
  } else {
    const s = intArg(args.startLine);
    const e = intArg(args.endLine);
    if (s === null || e === null || s < 1 || e < 1) {
      return fail("startLine and endLine must be positive integers");
    }
    if (e < s) return fail("invalid range: endLine is before startLine");
    if (e - s + 1 > maxLines) {
      return fail(
        `range too large: ${e - s + 1} lines requested, maximum ${maxLines}` +
          (maxLines < READ_RANGE_MAX_LINES
            ? ` (maxLines can be raised up to ${READ_RANGE_MAX_LINES})`
            : "")
      );
    }
    startLine = s;
    endLine = e;
  }
  if (!rel) return fail("filePath could not be determined");

  const read = readIndexedSource(index, rel);
  if (read.status === "missing") {
    return {
      kind: "json",
      payload: { status: "stale", filePath: rel, reason: "file no longer exists on disk" },
    };
  }
  if (read.status === "untrusted" || read.status === "binary") {
    return fail(`Access denied: file is not readable as source: ${clipChars(rel, 200)}`);
  }
  if (read.status === "too_large") return fail(`File too large to read: ${clipChars(rel, 200)}`);
  if (read.status !== "ok" || read.content === undefined) {
    return fail(`File not found in index: ${clipChars(rel, 200)}`);
  }

  const currentHash = (read.contentHash as string).slice(0, 16);
  const indexedHash = (indexedFile(index, rel)?.sha256 ?? "").slice(0, 16);
  if (expectedHash && !(read.contentHash as string).startsWith(expectedHash)) {
    return {
      kind: "json",
      payload: {
        status: "stale",
        filePath: rel,
        reason: "file changed since the hash you supplied; search again for fresh ranges",
        expectedHash: expectedHash.slice(0, 16),
        currentHash,
      },
    };
  }
  // Symbol ranges come from the index; if the file moved on since indexing they
  // cannot be trusted. Explicit line reads are served from live content.
  if (symbolSpan && read.changedSinceIndex) {
    return {
      kind: "json",
      payload: {
        status: "stale",
        filePath: rel,
        reason: "file changed since it was indexed; symbol line ranges may have shifted",
        currentHash,
        indexedHash,
      },
    };
  }

  const lines = read.content.split("\n");
  const totalLines = read.content.endsWith("\n") ? lines.length - 1 : lines.length;
  if (startLine > totalLines) {
    return fail(`out-of-range: file has ${totalLines} lines, startLine is ${startLine}`);
  }
  if (!symbolSpan && endLine > totalLines) {
    return fail(`out-of-range: file has ${totalLines} lines, endLine is ${endLine}`);
  }

  let from = Math.max(1, startLine - contextLines);
  let to = Math.min(totalLines, Math.max(endLine, startLine) + contextLines);
  let truncated = false;
  if (to - from + 1 > maxLines) {
    to = from + maxLines - 1;
    truncated = true;
  }

  // Fit the source to the response ceiling in one pass over its lines.
  const sourceBudget = Math.min(
    READ_RANGE_MAX_SOURCE_BYTES,
    ctx.maxBytes - ctx.wrapperBytes - READ_RANGE_ENVELOPE_BYTES
  );
  const picked: string[] = [];
  let used = 0;
  for (let n = from; n <= to; n++) {
    let line = lines[n - 1];
    let cost = jsonEscapedBytes(line) + 2; // +2: the escaped "\n" joining it to the next line
    if (used + cost > sourceBudget) {
      if (picked.length === 0) {
        // One very long line: cut it rather than return nothing.
        line = clipEscapedBytes(line, Math.max(0, sourceBudget - 2));
        cost = jsonEscapedBytes(line) + 2;
        picked.push(line);
        used += cost;
        to = n;
        truncated = true;
        break;
      }
      to = n - 1;
      truncated = true;
      break;
    }
    picked.push(line);
    used += cost;
  }
  const source = picked.join("\n");

  const payload: Record<string, unknown> = {
    status: "ok",
    filePath: rel,
    startLine: from,
    endLine: from + picked.length - 1,
    lineCount: picked.length,
    totalLines,
    contentHash: currentHash,
    ...(symbolInfo ? { symbol: symbolInfo } : {}),
    ...(truncated ? { truncated: true, nextStartLine: from + picked.length } : {}),
    ...(read.changedSinceIndex ? { indexStale: true } : {}),
    estimatedTokens: estimateTextTokens(source),
    tokenEstimate: "heuristic",
    source,
  };
  return { kind: "json", payload, metrics: { sourceRanges: 1, resultCount: picked.length } };
}
