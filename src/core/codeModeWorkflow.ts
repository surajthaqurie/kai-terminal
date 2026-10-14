import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import type {
  IndexedDependency,
  IndexedSymbol,
  ProjectIndex,
  ProjectMeta,
  TaskCategory,
} from "./types";
import { classifyTask } from "./classifier";
import { detectStaleIndexEntries, indexProject, isSensitiveFile, toPosixRel } from "./indexer";
import {
  getProjectMeta,
  isWithinProjectBoundary,
  loadProjectIndex,
  markProjectGraphStatus,
  normalizePathForIdentity,
  resolveCanonicalPath,
  saveProjectIndex,
} from "./registry";
import { retrieveContext } from "./retrieval";

export type GraphFreshness = "fresh" | "stale" | "unindexed" | "unknown" | "refresh-failed";

/** Code Mode only: the new workflow must not run in any other mode. */
export function isCodeMode(mode: string | null | undefined): boolean {
  return mode === "code";
}

export function getGraphFreshness(index: ProjectIndex | null | undefined): GraphFreshness {
  if (!index) return "unindexed";
  try {
    if (!index.meta || !index.meta.lastIndexedAt) return "unindexed";
    if (index.meta.status === "failed") return "refresh-failed";
    if (index.meta.status === "stale") return "stale";
    if (index.meta.status === "indexing" || index.meta.status === "unindexed") return "unknown";
    const ageMs = Date.now() - new Date(index.meta.lastIndexedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs > 24 * 60 * 60 * 1000) return "stale";
    const check = detectStaleIndexEntries(index);
    if (check.isStale) return "stale";
    return "fresh";
  } catch {
    return "unknown";
  }
}

export interface TaskUnderstanding {
  category: TaskCategory;
  confidence: number;
  needsGraph: boolean;
  needsPromptOptions: boolean;
  isSimple: boolean;
  reason: string;
}

const GRAPH_DEPENDENT: ReadonlySet<TaskCategory> = new Set([
  "architecture",
  "implement",
  "refactor",
  "debug",
  "review",
  "test",
]);

/** Lightweight deterministic classification; no extra model call. */
export function understandTask(task: string, categoryOverride?: TaskCategory): TaskUnderstanding {
  const classification = classifyTask(task, categoryOverride);
  const category = classification.category;
  const trimmed = (task || "").trim();
  const isSimple =
    (category === "explain" || category === "documentation") &&
    classification.confidence >= 0.5 &&
    trimmed.length < 200 &&
    !/architect|refactor|depend|structur|graph|system\s+design|data\s+flow/i.test(trimmed);
  const needsGraph = !isSimple && GRAPH_DEPENDENT.has(category);
  const needsPromptOptions =
    !isSimple &&
    (category === "architecture" ||
      category === "implement" ||
      category === "refactor" ||
      category === "unknown" ||
      classification.confidence < 0.4);
  return {
    category,
    confidence: classification.confidence,
    needsGraph,
    needsPromptOptions,
    isSimple,
    reason: classification.reason,
  };
}

export interface PromptOption {
  id: "option1" | "option2";
  title: string;
  prompt: string;
  outcome: string;
  tradeoffs: string;
}

function relevantFileHint(relevantFiles: string[]): string {
  if (relevantFiles.length === 0) return "";
  return ` Relevant files: ${relevantFiles.slice(0, 3).join(", ")}.`;
}

function recommendedFor(category: TaskCategory): string {
  switch (category) {
    case "architecture":
      return "Extend the existing module structure following current dependency direction; avoid new cross-layer imports.";
    case "refactor":
      return "Refactor in place with minimal API changes, preserving existing exports and behavior.";
    case "debug":
      return "Fix the root cause with the smallest change and keep existing error-handling conventions.";
    case "implement":
      return "Implement following existing patterns in adjacent files, reusing current helpers and types.";
    case "test":
      return "Add focused tests using the repo's existing test framework alongside the changed code.";
    case "review":
      return "Review against existing conventions and list only actionable findings.";
    default:
      return "Follow existing codebase patterns and keep the change minimal.";
  }
}

function alternativeFor(category: TaskCategory): string | null {
  switch (category) {
    case "architecture":
      return "Introduce a small isolated module behind the existing interface when coupling would otherwise grow.";
    case "implement":
      return "Add a separate helper/module instead of extending the existing one, trading one extra file for lower coupling.";
    case "refactor":
      return "Extract a shared helper and migrate call sites, trading a wider diff for less duplication.";
    case "debug":
      return "Harden the call path with explicit validation plus a regression test, trading a larger change for prevention.";
    case "unknown":
      return "Scope the task first to the smallest reproducible slice, then implement only that slice.";
    default:
      return null;
  }
}

/**
 * Build at most two concise prompt options. Returns [] for simple tasks
 * (execute directly) so prompt generation never blocks them.
 */
export function buildPromptOptions(
  task: string,
  understanding: TaskUnderstanding,
  relevantFiles: string[] = []
): PromptOption[] {
  const trimmed = (task || "").trim().slice(0, 2000);
  if (!trimmed || !understanding.needsPromptOptions) return [];
  const hint = relevantFileHint(relevantFiles);
  const option1: PromptOption = {
    id: "option1",
    title: "Recommended (safest)",
    prompt: `${trimmed} — ${recommendedFor(understanding.category)}${hint}`,
    outcome: "Completes the requested task with minimal risk to existing behavior.",
    tradeoffs: "May defer larger structural improvements to keep the diff small.",
  };
  const alt = alternativeFor(understanding.category);
  if (!alt) return [option1];
  return [
    option1,
    {
      id: "option2",
      title: "Alternative (different trade-off)",
      prompt: `${trimmed} — ${alt}${hint}`,
      outcome: "Same goal via a structurally different approach for comparison.",
      tradeoffs: "Larger or more invasive change; weigh against the recommended path.",
    },
  ];
}

export interface PromptSession {
  originalTask: string;
  options: PromptOption[];
  activePrompt: string;
  selectedId: "option1" | "option2" | null;
}

export function createPromptSession(task: string, options: PromptOption[]): PromptSession {
  return {
    originalTask: task,
    options,
    activePrompt: options[0]?.prompt ?? task,
    selectedId: options.length > 0 ? "option1" : null,
  };
}

const AFFIRM_CONTINUE =
  /^(yes|yeah|yep|ok|okay|sure|proceed|continue|go\s*ahead|do\s*it|lgtm|ship\s*it|looks\s*good)\b/i;

function wordOverlap(a: string, b: string): number {
  const tokenize = (s: string): Set<string> =>
    new Set(
      (s.toLowerCase().match(/[a-z0-9_]+/g) || []).filter((w) => w.length >= 3 && !STOP.has(w))
    );
  const STOP = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "please",
    "could",
    "would",
    "should",
  ]);
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sb) if (sa.has(w)) inter++;
  return inter / Math.max(sa.size, sb.size);
}

export type SelectionKind = "option1" | "option2" | "custom" | "default1" | "reassess";

export function resolvePromptSelection(
  session: PromptSession,
  userMessage: string
): { kind: SelectionKind; prompt: string } {
  const msg = (userMessage || "").trim();
  const lower = msg.toLowerCase();
  if (/option\s*2|second\s+option|alternative\b/.test(lower)) {
    const opt2 = session.options.find((o) => o.id === "option2");
    if (opt2) return { kind: "option2", prompt: opt2.prompt };
    return { kind: "option1", prompt: session.options[0]?.prompt ?? session.originalTask };
  }
  if (/option\s*1|first\s+option|recommended\b/.test(lower)) {
    return { kind: "option1", prompt: session.options[0]?.prompt ?? session.originalTask };
  }
  if (!msg) {
    // No user input at all: fall back to the recommended default.
    return {
      kind: "default1",
      prompt: session.options[0]?.prompt ?? session.originalTask,
    };
  }
  if (AFFIRM_CONTINUE.test(msg) && msg.length <= 20) {
    // Pure continuation ("yes", "go ahead") with no extra instruction:
    // the only case where defaulting to option 1 is unambiguous.
    return {
      kind: "default1",
      prompt: session.options[0]?.prompt ?? session.originalTask,
    };
  }
  const overlap = wordOverlap(session.originalTask, msg);
  if (msg.length > 20 && overlap < 0.2) {
    return { kind: "reassess", prompt: msg };
  }
  // Any other user message is a user-supplied prompt and takes precedence:
  // never silently drop it by falling back to the recommended default.
  // (This covers overlapping refinements such as "refactor auth module
  // with tabs" as well as affirmations with extra instructions such as
  // "proceed with tabs please".)
  return { kind: "custom", prompt: msg };
}

export function validateGraphCandidate(candidate: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return { valid: false, errors: ["candidate must be an object"] };
  }
  const c = candidate as Record<string, unknown>;
  if (typeof c.meta !== "object" || c.meta === null) errors.push("meta is required");
  else {
    const m = c.meta as Record<string, unknown>;
    if (typeof m.id !== "string" || !m.id) errors.push("meta.id is required");
    if (typeof m.canonicalPath !== "string" || !m.canonicalPath)
      errors.push("meta.canonicalPath is required");
  }
  if (typeof c.files !== "object" || c.files === null || Array.isArray(c.files))
    errors.push("files must be a record");
  if (typeof c.symbolIndex !== "object" || c.symbolIndex === null || Array.isArray(c.symbolIndex))
    errors.push("symbolIndex must be a record");
  if (errors.length === 0) {
    const files = c.files as Record<string, unknown>;
    for (const [rel, f] of Object.entries(files)) {
      if (rel.includes("\0") || rel.split("/").includes("..")) {
        errors.push(`invalid file key: ${rel}`);
        break;
      }
      const file = f as Record<string, unknown>;
      if (typeof file.relativePath !== "string" || typeof file.sha256 !== "string") {
        errors.push(`file entry missing required fields: ${rel}`);
        break;
      }
      if (!Array.isArray(file.symbols) || !Array.isArray(file.dependencies)) {
        errors.push(`file entry has invalid symbols/dependencies: ${rel}`);
        break;
      }
    }
  }
  if (errors.length === 0) {
    const files = c.files as Record<string, unknown>;
    const symbols = c.symbolIndex as Record<string, unknown>;
    const symbolKeys = Reflect.ownKeys(symbols);
    for (const key of symbolKeys) {
      const name = String(key);
      if (name === "__proto__" || name === "constructor" || name === "prototype") {
        errors.push(`unsafe symbol key: ${name}`);
        break;
      }
      const list = (symbols as Record<string, unknown>)[name];
      if (!Array.isArray(list)) {
        errors.push(`symbol entry must be an array: ${name}`);
        break;
      }
      for (const s of list as Array<Record<string, unknown>>) {
        const fp = typeof s.filePath === "string" ? s.filePath : "";
        if (fp && !Object.prototype.hasOwnProperty.call(files, fp)) {
          errors.push(`symbol ${name} references unknown file: ${fp}`);
          break;
        }
      }
      if (errors.length > 0) break;
    }
  }
  if (errors.length === 0) {
    try {
      JSON.stringify(candidate);
    } catch {
      errors.push("candidate is not serializable");
    }
  }
  return { valid: errors.length === 0, errors };
}

export type GraphScope = "none" | "incremental" | "full";

const STRUCTURAL_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
]);

export function computeGraphImpact(
  changedFiles: string[],
  opts: { uncertain?: boolean } = {}
): { scope: GraphScope; reason: string } {
  if (opts.uncertain) return { scope: "full", reason: "change impact uncertain; full rebuild" };
  if (!changedFiles || changedFiles.length === 0)
    return { scope: "none", reason: "no relevant graph impact" };
  if (changedFiles.length > 10)
    return { scope: "full", reason: "broad change; full rebuild preferred" };
  for (const f of changedFiles) {
    const base = f.replace(/\\/g, "/").split("/").pop() || "";
    if (STRUCTURAL_FILES.has(base))
      return { scope: "full", reason: `structural file changed: ${base}` };
  }
  return { scope: "incremental", reason: "small known change; incremental sync" };
}

export function markGraphStale(projectId: string, reason?: string): void {
  markProjectGraphStatus(projectId, "stale", reason);
}

/**
 * Contract for `changedFiles` (used by `synchronizeGraphAfterChanges` and the
 * `kai_sync_graph` MCP tool):
 *
 * - The list is **caller-reported, not independently verified**: it describes
 *   which relative paths the caller's coding task changed. An empty list
 *   skips the rebuild, so a caller that omits real changes leaves the graph
 *   stale — the next graph-dependent task detects that via
 *   `detectStaleIndexEntries` / `getGraphFreshness` and can fall back to
 *   `kai_refresh_index`.
 * - Entries are sanitized here (non-strings dropped, separators normalized,
 *   empties dropped, capped at 50) so a malformed list cannot break the sync.
 */
export function sanitizeChangedFiles(changedFiles: unknown): string[] {
  if (!Array.isArray(changedFiles)) return [];
  return changedFiles
    .filter((f): f is string => typeof f === "string")
    .map((f) => f.replace(/\\/g, "/").trim())
    .filter((f) => f.length > 0 && f.length <= 1024 && !f.includes("\0"))
    .slice(0, 50);
}

/** Mark stale only when the on-disk graph is still the generation we based
 * our sync on; a concurrent sync that already published a newer valid graph
 * must never be overwritten or stale-marked by us. Returns true when the
 * mark was applied (or there was no previous graph to protect). */
export function markStaleGuarded(
  projectId: string,
  baseGeneratedAt: string | null,
  reason: string
): boolean {
  try {
    const current = loadProjectIndex(projectId);
    const currentGen = current?.generatedAt ?? null;
    if (baseGeneratedAt !== null && currentGen !== null && currentGen !== baseGeneratedAt) {
      return false; // a newer graph was published concurrently; leave it alone
    }
    markGraphStale(projectId, reason);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cross-platform absolute-path check. `path.isAbsolute` alone misses
 * Windows forms (`C:\x`, `C:/x`, `\\server\share`) when running on POSIX.
 */
export function isAbsoluteCrossPlatform(p: string): boolean {
  if (!p) return false;
  if (path.isAbsolute(p) || path.win32.isAbsolute(p)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  if (p.startsWith("\\\\") || p.startsWith("//")) return true;
  return false;
}

export interface PathResolution {
  accepted: string[];
  rejected: Array<{ path: string; reason: string }>;
}

/**
 * Validate caller-reported paths against the active project's canonical
 * root. Normalizes separators via `toPosixRel`, dedupes, caps at 50, and
 * rejects traversal attempts, absolute paths, symlink escapes, sensitive
 * files, and malformed entries. Missing-on-disk paths are still accepted
 * (they may be newly created or deleted files) after the lexical boundary
 * check passes.
 */
export function resolveChangedFilesAgainstRoot(
  raw: unknown,
  canonicalRoot: string
): PathResolution {
  const accepted: string[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw)) return { accepted, rejected };
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const original = entry;
    const norm = toPosixRel(entry).trim();
    if (!norm || norm.length > 1024 || norm.includes("\0")) {
      rejected.push({ path: String(original).slice(0, 120), reason: "malformed path" });
      continue;
    }
    if (isAbsoluteCrossPlatform(norm) || isAbsoluteCrossPlatform(entry.trim())) {
      rejected.push({ path: norm.slice(0, 120), reason: "absolute path outside project" });
      continue;
    }
    if (norm.split("/").includes("..")) {
      rejected.push({ path: norm.slice(0, 120), reason: "path traversal" });
      continue;
    }
    const clean = norm.replace(/^\.\//, "").replace(/^\/+/, "");
    if (!clean) {
      rejected.push({ path: norm.slice(0, 120), reason: "malformed path" });
      continue;
    }
    if (seen.has(clean)) continue;
    if (isSensitiveFile(clean) || isSensitiveFile(clean.split("/").pop() || "")) {
      rejected.push({ path: clean.slice(0, 120), reason: "sensitive or excluded file" });
      continue;
    }
    // Lexical boundary check first (covers created/deleted files that have
    // no on-disk target to realpath). A realpath check follows for files
    // that do exist, to catch symlink escapes.
    const lexical = path.resolve(path.join(canonicalRoot, clean));
    if (!isWithinProjectBoundary(lexical, canonicalRoot)) {
      rejected.push({ path: clean.slice(0, 120), reason: "escapes project boundary" });
      continue;
    }
    try {
      const real = fs.realpathSync(path.join(canonicalRoot, clean));
      if (!isWithinProjectBoundary(real, canonicalRoot)) {
        rejected.push({ path: clean.slice(0, 120), reason: "symlink escapes project" });
        continue;
      }
    } catch {
      // Missing on disk (created/deleted/renamed): lexical check above stands.
    }
    seen.add(clean);
    accepted.push(clean);
    if (accepted.length >= 50) break;
  }
  return { accepted, rejected };
}

/**
 * On-disk change signal independent of caller hints: files whose
 * size/mtime drifted (or vanished) since indexing. Bounded to 50 entries.
 */
export function detectChangedFilesFromDisk(index: ProjectIndex | null): string[] {
  if (!index) return [];
  try {
    const drift = detectStaleIndexEntries(index);
    return [...drift.staleFiles, ...drift.deletedFiles].slice(0, 50);
  } catch {
    return [];
  }
}

/**
 * Verify the intended project is still the registered project before
 * touching its index. Protects stale task callbacks from writing to a
 * different project after the user switches, closes, or deletes projects.
 */
export function verifyProjectIdentity(
  meta: ProjectMeta
): { ok: true } | { ok: false; reason: string } {
  let registered: ReturnType<typeof getProjectMeta>;
  try {
    registered = getProjectMeta(meta.id);
  } catch {
    return { ok: false, reason: `cannot verify project ${meta.id}; refusing to write` };
  }
  if (!registered) {
    return {
      ok: false,
      reason: `project is no longer registered (closed or deleted); refusing to write to another project's index`,
    };
  }
  try {
    if (
      normalizePathForIdentity(registered.canonicalPath) !==
      normalizePathForIdentity(meta.canonicalPath)
    ) {
      return {
        ok: false,
        reason: `project identity changed since task start (path mismatch); refusing to write to another project's index`,
      };
    }
  } catch {
    return { ok: false, reason: `cannot verify project identity; refusing to write` };
  }
  return { ok: true };
}

/** Read actual freshness, coercing `fresh` to `stale` on failure paths so a
 * failed refresh can never be reported as `fresh`. */
function failureFreshness(projectId: string): GraphFreshness {
  const actual = getGraphFreshness(loadProjectIndex(projectId));
  return actual === "fresh" ? "stale" : actual;
}

export interface SyncReport {
  codeValidation: { ran: boolean; passed: boolean; detail: string };
  graphScope: GraphScope;
  graphResult: "skipped" | "synced" | "failed" | "stale-preserved";
  freshnessAfter: GraphFreshness;
  message: string;
  changes?: { added: number; modified: number; renamed: number; deleted: number };
  /** Caller-reported paths rejected during project-boundary validation. */
  rejectedFiles?: Array<{ path: string; reason: string }>;
  /** Non-fatal notes (fallbacks used, concurrent races absorbed, etc.). */
  warnings?: string[];
}

/**
 * Guarded post-change graph synchronization. The candidate is built as a
 * dry run and validated BEFORE it can become the active graph, so an
 * invalid candidate never replaces the last-known-good graph (not even
 * briefly, and not via a crash between save and validation). Persistence
 * uses the existing atomic `saveProjectIndex`; a guarded stale-mark keeps
 * metadata and freshness consistent on failure without touching the caller's
 * source-code changes. A concurrent sync that publishes a newer valid graph
 * is never overwritten or stale-marked by an outdated attempt.
 */
export async function synchronizeGraphAfterChanges(
  meta: ProjectMeta,
  changedFiles: string[],
  codeValidation: { ran: boolean; passed: boolean; detail: string } = {
    ran: false,
    passed: false,
    detail: "no validation detail provided",
  },
  opts: { uncertain?: boolean; forceFull?: boolean } = {}
): Promise<SyncReport> {
  const sanitized = sanitizeChangedFiles(changedFiles);
  // Security boundary: caller hints are untrusted. Re-validate against the
  // canonical root and drop escapes/traversals before they influence scope.
  let canonicalRootForValidation: string | null = null;
  try {
    canonicalRootForValidation = resolveCanonicalPath(meta.canonicalPath);
  } catch {
    canonicalRootForValidation = null;
  }
  let rejectedFiles: Array<{ path: string; reason: string }> = [];
  let effectiveChanged = sanitized;
  if (canonicalRootForValidation) {
    const resolved = resolveChangedFilesAgainstRoot(changedFiles, canonicalRootForValidation);
    rejectedFiles = resolved.rejected;
    effectiveChanged = resolved.accepted;
  }
  const warnings: string[] = [];
  if (rejectedFiles.length > 0) {
    warnings.push(
      `${rejectedFiles.length} caller-reported path(s) rejected outside project boundary.`
    );
  }
  let impact = computeGraphImpact(effectiveChanged, { uncertain: opts.uncertain });
  if (impact.scope === "none") {
    // An empty caller list is not proof nothing changed: consult the
    // on-disk signal before assuming the graph is current. When drift is
    // found, take a safe broader refresh instead of skipping.
    const baseForCheck = loadProjectIndex(meta.id);
    const drifted = detectChangedFilesFromDisk(baseForCheck);
    if (drifted.length > 0) {
      impact = {
        scope: "full",
        reason: `caller reported no changes but ${drifted.length} file(s) differ on disk; safe broader refresh`,
      };
      warnings.push(`On-disk drift detected (${drifted.slice(0, 3).join(", ")}); refreshing.`);
    }
  }
  const scope: GraphScope = opts.forceFull && impact.scope !== "none" ? "full" : impact.scope;

  if (scope === "none") {
    const freshnessAfter = getGraphFreshness(loadProjectIndex(meta.id));
    return {
      codeValidation,
      graphScope: scope,
      graphResult: "skipped",
      freshnessAfter,
      message: `No relevant graph impact (${impact.reason}); rebuild skipped.`,
      rejectedFiles: rejectedFiles.length > 0 ? rejectedFiles : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // Active-project correctness: a stale callback must never write to a
  // project that was switched, closed, or deleted after the task started.
  const identity = verifyProjectIdentity(meta);
  if (!identity.ok) {
    return {
      codeValidation,
      graphScope: scope,
      graphResult: "failed",
      freshnessAfter: failureFreshness(meta.id),
      message: `Graph synchronization refused: ${identity.reason}. Source changes preserved.`,
      rejectedFiles: rejectedFiles.length > 0 ? rejectedFiles : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // Bounded retry: if a concurrent sync publishes a newer valid graph while
  // we build, rebuild once from the new base instead of overwriting it.
  for (let attempt = 0; attempt < 2; attempt++) {
    const base = loadProjectIndex(meta.id);
    const baseGeneratedAt = base?.generatedAt ?? null;
    try {
      // Dry run: no disk state is modified before validation.
      const candidate = await indexProject(meta, {
        forceRebuild: scope === "full",
        dryRun: true,
      });
      const check = validateGraphCandidate(candidate);
      if (!check.valid) {
        markStaleGuarded(
          meta.id,
          baseGeneratedAt,
          `candidate failed validation: ${check.errors[0]}`
        );
        return {
          codeValidation,
          graphScope: scope,
          graphResult: "stale-preserved",
          freshnessAfter: failureFreshness(meta.id),
          message: `Candidate failed validation (${check.errors[0]}); last-known-good graph preserved and marked stale.`,
          rejectedFiles: rejectedFiles.length > 0 ? rejectedFiles : undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }
      // The candidate must belong to the intended project; a project switch
      // mid-index must never publish under a mismatched identity.
      if (candidate.meta.id !== meta.id) {
        return {
          codeValidation,
          graphScope: scope,
          graphResult: "failed",
          freshnessAfter: failureFreshness(meta.id),
          message:
            "Graph synchronization refused: candidate project identity mismatch; last-known-good graph preserved.",
          rejectedFiles: rejectedFiles.length > 0 ? rejectedFiles : undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }
      // Re-verify identity after the (possibly slow) build: the user may
      // have switched or closed the project while indexing ran.
      const lateIdentity = verifyProjectIdentity(meta);
      if (!lateIdentity.ok) {
        return {
          codeValidation,
          graphScope: scope,
          graphResult: "failed",
          freshnessAfter: failureFreshness(meta.id),
          message: `Graph synchronization refused: ${lateIdentity.reason}. Source changes preserved.`,
          rejectedFiles: rejectedFiles.length > 0 ? rejectedFiles : undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }
      const current = loadProjectIndex(meta.id);
      const currentGen = current?.generatedAt ?? null;
      if (baseGeneratedAt !== null && currentGen !== null && currentGen !== baseGeneratedAt) {
        // A concurrent sync published a newer graph while we were building.
        // Retry once from the new base; if it races again, report without
        // overwriting the newer valid graph.
        if (attempt === 0) continue;
        return {
          codeValidation,
          graphScope: scope,
          graphResult: "failed",
          freshnessAfter: failureFreshness(meta.id),
          message:
            "Graph synchronization skipped: a concurrent sync published a newer valid graph; not overwritten.",
          rejectedFiles: rejectedFiles.length > 0 ? rejectedFiles : undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }
      saveProjectIndex(meta.id, candidate);
      const after = loadProjectIndex(meta.id);
      return {
        codeValidation,
        graphScope: scope,
        graphResult: "synced",
        freshnessAfter: getGraphFreshness(after),
        message: `Graph synchronized (${scope}; ${impact.reason}).`,
        changes: candidate.changes
          ? {
              added: candidate.changes.added.length,
              modified: candidate.changes.modified.length,
              renamed: candidate.changes.renamed.length,
              deleted: candidate.changes.deleted.length,
            }
          : undefined,
        rejectedFiles: rejectedFiles.length > 0 ? rejectedFiles : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (err) {
      markStaleGuarded(meta.id, baseGeneratedAt, `synchronization failed: ${String(err)}`);
      return {
        codeValidation,
        graphScope: scope,
        graphResult: "failed",
        freshnessAfter: failureFreshness(meta.id),
        message: `Graph synchronization failed (${String(err)}); code changes preserved, graph marked stale.`,
        rejectedFiles: rejectedFiles.length > 0 ? rejectedFiles : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }
  }
  // Unreachable: the loop always returns. Kept as a fail-closed guard so an
  // exception can never fall through into a false success response.
  return {
    codeValidation,
    graphScope: scope,
    graphResult: "failed",
    freshnessAfter: failureFreshness(meta.id),
    message: "Graph synchronization failed (exhausted retries); graph marked stale.",
  };
}

/** In-flight sync promises keyed by project id: duplicate completion
 * callbacks for the same project share one rebuild instead of racing. */
const syncInFlight = new Map<string, Promise<SyncReport>>();

/**
 * Deduplicating wrapper around {@link synchronizeGraphAfterChanges} for
 * completion-notification paths (MCP `kai_sync_graph`, lifecycle runner).
 * Concurrent callers for the same project await the same promise; sequential
 * calls run normally. Failures are never cached.
 */
export function synchronizeGraphDeduped(
  meta: ProjectMeta,
  changedFiles: string[],
  codeValidation: { ran: boolean; passed: boolean; detail: string } = {
    ran: false,
    passed: false,
    detail: "no validation detail provided",
  },
  opts: { uncertain?: boolean; forceFull?: boolean } = {}
): Promise<SyncReport> {
  const running = syncInFlight.get(meta.id);
  if (running) return running;
  const task = synchronizeGraphAfterChanges(meta, changedFiles, codeValidation, opts);
  syncInFlight.set(meta.id, task);
  task.then(
    () => {
      if (syncInFlight.get(meta.id) === task) syncInFlight.delete(meta.id);
    },
    () => {
      if (syncInFlight.get(meta.id) === task) syncInFlight.delete(meta.id);
    }
  );
  return task;
}

export type RefreshOutcome = "not-required" | "refreshed" | "refresh-failed";

export interface FreshIndexResult {
  index: ProjectIndex | null;
  freshnessBefore: GraphFreshness;
  freshnessAfter: GraphFreshness;
  refreshOutcome: RefreshOutcome;
  warning?: string;
}

/**
 * Automatic freshness gate for graph-dependent reads. When the loaded graph
 * is stale, unindexed, unknown, or previously failed, a single bounded
 * incremental refresh is attempted (reusing the existing indexer and locks)
 * so callers never unknowingly rely on an outdated graph. Never throws:
 * lock contention or indexer errors fall back to the stale index with a
 * truthful warning. Never recurses: at most one refresh attempt.
 */
export async function ensureFreshIndex(
  meta: ProjectMeta,
  index: ProjectIndex | null
): Promise<FreshIndexResult> {
  const freshnessBefore = getGraphFreshness(index);
  if (freshnessBefore === "fresh") {
    return { index, freshnessBefore, freshnessAfter: "fresh", refreshOutcome: "not-required" };
  }
  try {
    const refreshed = await indexProject(meta);
    return {
      index: refreshed,
      freshnessBefore,
      freshnessAfter: getGraphFreshness(refreshed),
      refreshOutcome: "refreshed",
    };
  } catch (err) {
    const after = loadProjectIndex(meta.id) ?? index;
    const freshnessAfter = after ? failureFreshness(meta.id) : "unindexed";
    return {
      index: after,
      freshnessBefore,
      freshnessAfter,
      refreshOutcome: "refresh-failed",
      warning: `Graph refresh failed (${String(err)}); using last-known index with bounded source-analysis fallback.`,
    };
  }
}

export interface SelectedFileResolution {
  selected: string[];
  excluded: Array<{ path: string; reason: string }>;
}

/**
 * Resolve caller-supplied selected files against the active project's
 * canonical root. Accepts a single path or an array; normalizes and
 * dedupes via existing cross-platform utilities; rejects absolute paths
 * outside the project, traversal attempts, symlink escapes, sensitive
 * files, and malformed entries. Missing-on-disk paths are kept (they may
 * be renamed, moved, deleted, or not-yet-created files).
 */
export function resolveSelectedFiles(raw: unknown, canonicalRoot: string): SelectedFileResolution {
  const list: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  if (list.length === 0) return { selected: [], excluded: [] };
  // Same boundary rules as sync hints: normalize, dedupe, cap at 50, and
  // reject escapes/traversals/sensitive files. Files merely missing on disk
  // are accepted (renamed, moved, deleted, or not-yet-created).
  const resolution = resolveChangedFilesAgainstRoot(list, canonicalRoot);
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const s of resolution.accepted) {
    if (!seen.has(s)) {
      seen.add(s);
      selected.push(s);
    }
  }
  return { selected, excluded: resolution.rejected };
}

export interface SupportingFile {
  path: string;
  reason: string;
}

export interface SupportingContext {
  supporting: SupportingFile[];
  dependencies: IndexedDependency[];
  symbols: IndexedSymbol[];
  testFiles: string[];
  rationale: string[];
}

/** Resolve `./x` style specifiers against a source file to an in-index path. */
function resolveSpecifierToIndex(
  specifier: string,
  sourceRel: string,
  index: ProjectIndex
): string | null {
  if (!specifier.startsWith(".")) return null;
  const dir = toPosixRel(sourceRel).split("/").slice(0, -1).join("/");
  const base = dir ? `${dir}/${specifier}` : specifier;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.py`, `${base}.go`];
  // Normalize `./` and `../` segments without touching the filesystem.
  for (const c of candidates) {
    const parts: string[] = [];
    for (const seg of c.split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    const norm = parts.join("/");
    if (Object.prototype.hasOwnProperty.call(index.files, norm)) return norm;
  }
  // Directory import pointing at an index file (./pkg -> ./pkg/index.ts).
  for (const suffix of ["/index.ts", "/index.js", "/__init__.py"]) {
    const parts: string[] = [];
    for (const seg of `${base}${suffix}`.split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    const norm = parts.join("/");
    if (Object.prototype.hasOwnProperty.call(index.files, norm)) return norm;
  }
  return null;
}

/**
 * Expand user-selected primary targets into bounded supporting context:
 * direct imports, callers (reverse dependencies), co-defined symbols, and
 * related tests. Purely index-driven and capped so results stay bounded.
 */
export function expandSupportingFiles(index: ProjectIndex, selected: string[]): SupportingContext {
  const supporting: SupportingFile[] = [];
  const dependencies: IndexedDependency[] = [];
  const symbols: IndexedSymbol[] = [];
  const testFiles: string[] = [];
  const rationale: string[] = [];
  const seen = new Set<string>(selected);
  const push = (p: string, reason: string): void => {
    if (seen.has(p) || supporting.length >= 10) return;
    if (!Object.prototype.hasOwnProperty.call(index.files, p)) return;
    seen.add(p);
    supporting.push({ path: p, reason });
  };

  for (const rel of selected) {
    const file = Object.prototype.hasOwnProperty.call(index.files, rel)
      ? index.files[rel]
      : undefined;
    if (!file) {
      rationale.push(
        `${rel}: not in index (new, deleted, or unsupported type); task text is the primary constraint.`
      );
      continue;
    }
    for (const sym of file.symbols.slice(0, 20)) {
      if (symbols.length < 15) symbols.push(sym);
    }
    for (const dep of file.dependencies.slice(0, 20)) {
      if (dependencies.length < 15) dependencies.push(dep);
      const target = resolveSpecifierToIndex(dep.targetSpecifier, rel, index);
      if (target) push(target, `imported by selected file ${rel}`);
    }
    // Related tests by naming convention.
    const base =
      rel
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? "";
    if (base) {
      for (const [otherRel, other] of Object.entries(index.files)) {
        if (seen.has(otherRel) || testFiles.length + supporting.length >= 12) break;
        if (!other.isTest) continue;
        const otherLower = otherRel.toLowerCase();
        if (otherLower.includes(base.toLowerCase())) {
          testFiles.push(otherRel);
          push(otherRel, `test file related to selected file ${rel}`);
        }
      }
    }
  }

  // Callers: files whose resolved imports point at a selected file.
  if (selected.length > 0 && supporting.length < 10) {
    for (const [otherRel, other] of Object.entries(index.files)) {
      if (seen.has(otherRel) || supporting.length >= 10) break;
      for (const dep of other.dependencies) {
        const target = resolveSpecifierToIndex(dep.targetSpecifier, otherRel, index);
        if (target && selected.includes(target)) {
          push(otherRel, `imports selected file ${target}`);
          break;
        }
      }
    }
  }

  if (supporting.length > 0) {
    rationale.push(
      `Included ${supporting.length} supporting file(s) via direct imports, callers, or related tests of the selected targets.`
    );
  }
  return { supporting, dependencies, symbols, testFiles, rationale };
}

export interface PlanInput {
  task: string;
  categoryOverride?: TaskCategory;
  selectedFiles?: unknown;
}

export interface PlanResult {
  mode: "code";
  category: TaskCategory;
  confidence: number;
  freshness: GraphFreshness;
  freshnessAfter: GraphFreshness;
  refreshOutcome: RefreshOutcome;
  project: { id: string; name: string; canonicalPath: string };
  selectedFiles: string[];
  excludedSelections: Array<{ path: string; reason: string }>;
  inferredFiles: string[];
  supportingFiles: SupportingFile[];
  dependencies: IndexedDependency[];
  symbols: IndexedSymbol[];
  relevantFiles: string[];
  options: PromptOption[];
  defaultOption: "option1" | "option2" | null;
  needsClarification: boolean;
  clarifyingQuestion?: string;
  crossModule: boolean;
  platformNote?: string;
  rationale: string[];
  warnings: string[];
  note: string;
}

/**
 * Graph-aware planning for `kai_plan_task`: deterministic classification,
 * freshness-gated context (single bounded auto-refresh, never recursive),
 * selected-file prioritization with dependency expansion, and at most two
 * prompt options. Works with a missing/failed graph via bounded fallbacks
 * and always reports freshness truthfully.
 */
export async function planCodeTask(
  meta: ProjectMeta,
  index: ProjectIndex | null,
  input: PlanInput
): Promise<PlanResult> {
  const task = (input.task || "").trim().slice(0, 4000);
  const understanding = understandTask(task, input.categoryOverride);
  const freshness = getGraphFreshness(index);

  let canonicalRoot = meta.canonicalPath;
  try {
    canonicalRoot = resolveCanonicalPath(meta.canonicalPath);
  } catch {
    canonicalRoot = meta.canonicalPath;
  }
  const { selected, excluded } = resolveSelectedFiles(input.selectedFiles, canonicalRoot);
  const warnings: string[] = [];
  for (const e of excluded) {
    warnings.push(`Selection excluded: ${e.path} (${e.reason}).`);
  }

  // Freshness gate: refresh once when graph-dependent planning requires it.
  // Unknown/low-confidence tasks still attempt bounded inference (they get
  // prompt options), so any non-simple task — or any explicit selection —
  // must not rely on a stale graph. Simple tasks without selections skip
  // the graph entirely and never trigger a rebuild.
  const usesGraph = understanding.needsGraph || selected.length > 0 || !understanding.isSimple;
  let workingIndex = index;
  let freshnessAfter = freshness;
  let refreshOutcome: RefreshOutcome = "not-required";
  if (usesGraph && freshness !== "fresh") {
    const ensured = await ensureFreshIndex(meta, index);
    workingIndex = ensured.index;
    freshnessAfter = ensured.freshnessAfter;
    refreshOutcome = ensured.refreshOutcome;
    if (ensured.warning) warnings.push(ensured.warning);
  }

  let inferredFiles: string[] = [];
  let supporting: SupportingFile[] = [];
  let dependencies: IndexedDependency[] = [];
  let symbols: IndexedSymbol[] = [];
  const rationale: string[] = [
    `Classified as ${understanding.category} (confidence ${understanding.confidence.toFixed(2)}): ${understanding.reason}`,
  ];

  if (workingIndex) {
    if (selected.length > 0) {
      const expanded = expandSupportingFiles(workingIndex, selected);
      supporting = expanded.supporting;
      dependencies = expanded.dependencies;
      symbols = expanded.symbols;
      rationale.push(...expanded.rationale);
      // Small inferred sweep for files the selection did not cover.
      try {
        const retrieved = retrieveContext(workingIndex, task, { fileBudget: 5, tokenBudget: 1500 });
        for (const m of retrieved.matchedFiles) {
          const p = m.file.relativePath;
          if (!selected.includes(p) && !supporting.some((s) => s.path === p)) {
            if (inferredFiles.length < 5) inferredFiles.push(p);
          }
        }
        if (retrieved.staleFiles.length > 0) {
          warnings.push(
            `${retrieved.staleFiles.length} retrieved file(s) changed on disk since indexing; results may be incomplete.`
          );
        }
      } catch {
        warnings.push("Context retrieval unavailable; relying on selected files only.");
      }
    } else if (!understanding.isSimple) {
      try {
        const retrieved = retrieveContext(workingIndex, task, { fileBudget: 5, tokenBudget: 1500 });
        inferredFiles = retrieved.matchedFiles.map((m) => m.file.relativePath).slice(0, 5);
        dependencies = retrieved.dependencies.slice(0, 15);
        symbols = retrieved.matchedSymbols.slice(0, 15);
        if (retrieved.staleFiles.length > 0) {
          warnings.push(
            `${retrieved.staleFiles.length} retrieved file(s) changed on disk since indexing; results may be incomplete.`
          );
        }
        if (inferredFiles.length === 0) {
          warnings.push("No strong file matches; task text is the primary constraint.");
        }
      } catch {
        warnings.push("Context retrieval unavailable; proceeding from task text only.");
      }
    }
  } else {
    warnings.push(
      "No project graph available; planning from task text with source-search fallback on next read."
    );
  }

  if (refreshOutcome === "refresh-failed") {
    warnings.push(
      "Graph refresh failed; results use the last-known index and are not authoritative."
    );
  }

  const relevantFiles = [...selected, ...inferredFiles, ...supporting.map((s) => s.path)].slice(
    0,
    3
  );
  const options = buildPromptOptions(task, understanding, relevantFiles);

  const topDirs = new Set(
    [...selected, ...inferredFiles].map((p) => p.split("/").slice(0, 1).join("/"))
  );
  const crossModule = topDirs.size > 2;
  if (crossModule) {
    rationale.push("Targets span more than two top-level modules; verify cross-module impacts.");
  }
  let platformNote: string | undefined;
  if (/windows|win32|macos|darwin|linux|platform|unc path|case-sensitive/i.test(task)) {
    platformNote =
      "Task may involve platform-specific behavior; verify path handling on Windows, macOS, and Linux.";
    rationale.push(platformNote);
  }

  const needsClarification =
    understanding.category === "unknown" &&
    understanding.confidence < 0.4 &&
    selected.length === 0 &&
    inferredFiles.length === 0;
  const clarifyingQuestion = needsClarification
    ? "The task scope is ambiguous and no relevant files were found. Which file or module should this change target, and what is the desired outcome?"
    : undefined;
  if (needsClarification && clarifyingQuestion)
    warnings.push("Task is ambiguous; clarification requested.");

  return {
    mode: "code",
    category: understanding.category,
    confidence: understanding.confidence,
    freshness,
    freshnessAfter,
    refreshOutcome,
    project: { id: meta.id, name: meta.name, canonicalPath: meta.canonicalPath },
    selectedFiles: selected,
    excludedSelections: excluded,
    inferredFiles,
    supportingFiles: supporting,
    dependencies,
    symbols,
    relevantFiles,
    options,
    defaultOption: options[0]?.id ?? null,
    needsClarification,
    clarifyingQuestion,
    crossModule,
    platformNote,
    rationale,
    warnings,
    note:
      options.length === 0
        ? "Simple task: execute directly without prompt options."
        : "If the user continues without choosing and continuation is clear, use option1.",
  };
}

export interface CodeTaskRequest {
  /** Caller-reported paths (hints only; on-disk drift is also consulted). */
  changedFiles?: unknown;
  codeValidation?: { ran: boolean; passed: boolean; detail: string };
  uncertain?: boolean;
  forceFull?: boolean;
}

export interface CodeTaskOutcome {
  /** completed | failed | cancelled — mirrors the task, never the sync. */
  taskOutcome: "completed" | "failed" | "cancelled";
  taskError?: string;
  syncReport: SyncReport;
  project: { id: string; canonicalPath: string };
}

/**
 * Lifecycle integration for Code Mode task execution. Captures the intended
 * project identity before running `taskFn`, then automatically synchronizes
 * the graph afterwards — on success, on failure, and on cancellation — so
 * no manual `kai_sync_graph` call is required.
 *
 * - Partial changes after failure/cancellation are synced when safe.
 * - A project switch/close/delete mid-task refuses to publish rather than
 *   writing to another project's index.
 * - Sync failure never rewrites the task outcome; both are reported.
 * - Concurrent completions for the same project share one rebuild.
 */
export async function runCodeTaskWithAutoSync(
  meta: ProjectMeta,
  taskFn: () => Promise<CodeTaskRequest | void> | CodeTaskRequest | void,
  opts: { signal?: AbortSignal } = {}
): Promise<CodeTaskOutcome> {
  const captured = {
    id: meta.id,
    canonicalPath: meta.canonicalPath,
    project: { id: meta.id, canonicalPath: meta.canonicalPath },
  };
  let request: CodeTaskRequest = {};
  let taskOutcome: CodeTaskOutcome["taskOutcome"] = "completed";
  let taskError: string | undefined;

  if (opts.signal?.aborted) {
    taskOutcome = "cancelled";
    taskError = "task cancelled before start";
  } else {
    try {
      const result = await taskFn();
      if (result && typeof result === "object") request = result;
    } catch (err) {
      taskOutcome = "failed";
      taskError = err instanceof Error ? err.message : String(err);
    }
    if (opts.signal?.aborted && taskOutcome === "completed") {
      taskOutcome = "cancelled";
      taskError = "task cancelled during execution";
    }
  }

  const intended: ProjectMeta = { ...meta, id: captured.id, canonicalPath: captured.canonicalPath };
  const syncReport = await synchronizeGraphDeduped(
    intended,
    Array.isArray(request.changedFiles) ? (request.changedFiles as string[]) : [],
    request.codeValidation ?? {
      ran: false,
      passed: false,
      detail: "no validation detail provided",
    },
    { uncertain: request.uncertain, forceFull: request.forceFull }
  );
  return { taskOutcome, taskError, syncReport, project: captured.project };
}

export interface ExternalCommandResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Portable subprocess runner for the `kai run` lifecycle wrapper. No shell
 * by default (direct argv, no string evaluation); callers targeting Windows
 * batch files may opt into `shell: true`. Kills the child on timeout or
 * abort so partial changes still reach synchronization via the caller.
 */
export function runExternalAgentCommand(
  command: string,
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
  } = {}
): Promise<ExternalCommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: opts.shell ?? false,
        stdio: "inherit",
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - started,
      });
      void err;
      return;
    }
    let timedOut = false;
    let timeout: NodeJS.Timeout | null = null;
    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      try {
        child.kill();
      } catch {
        // already exited
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (opts.timeoutMs && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          // already exited
        }
      }, opts.timeoutMs);
    }
    child.on("error", () => {
      cleanup();
      resolve({ exitCode: null, signal: null, timedOut, durationMs: Date.now() - started });
    });
    child.on("close", (code, sig) => {
      cleanup();
      resolve({
        exitCode: code,
        signal: typeof sig === "string" ? sig : sig ? String(sig) : null,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}
