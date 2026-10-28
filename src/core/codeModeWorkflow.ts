import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import type {
  IndexedDependency,
  IndexedSymbol,
  KnownStaleness,
  ProjectIndex,
  ProjectMeta,
  TaskCategory,
} from "./types";
import { classifyTask } from "./classifier";
import { detectStaleIndexEntries, indexProject, isSensitiveFile, toPosixRel } from "./indexer";
import {
  getProjectMeta,
  checkPersistenceConsistency,
  isWithinProjectBoundary,
  loadProjectIndex,
  markProjectGraphStatus,
  normalizePathForIdentity,
  resolveCanonicalPath,
  saveProjectIndex,
} from "./registry";
import { rankCandidates, isPotentialSecretPath } from "./retrieval";
import { getReverseImports } from "./indexDerived";
import { dependencyTargets } from "./importResolver";
import { AGENT_EXIT_CLEANUP_SEQ, TERMINAL_MODE_RESET_SEQ } from "../services/terminalModes";

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

/**
 * Freshness from snapshot metadata alone (status, age), with no filesystem drift
 * scan. Used right after this process rebuilt the index: the build itself just
 * walked the tree, so re-walking it to confirm is redundant work.
 */
export function getSnapshotFreshness(index: ProjectIndex | null | undefined): GraphFreshness {
  if (!index) return "unindexed";
  try {
    if (!index.meta || !index.meta.lastIndexedAt) return "unindexed";
    if (index.meta.status === "failed") return "refresh-failed";
    if (index.meta.status === "stale") return "stale";
    if (index.meta.status === "indexing" || index.meta.status === "unindexed") return "unknown";
    const ageMs = Date.now() - new Date(index.meta.lastIndexedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs > 24 * 60 * 60 * 1000) return "stale";
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

function markGraphStale(projectId: string, reason?: string): void {
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
function isAbsoluteCrossPlatform(p: string): boolean {
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
 *
 * Identity is the stable id + normalized canonical path AND the
 * registration incarnation token: deleting a project and re-registering
 * the same path yields the same id/path but a fresh incarnation, so an
 * older in-flight task captured under the previous registration is
 * rejected instead of publishing into the new project. A caller-provided
 * token is never trusted on its own — it is always compared against the
 * registry copy. Tasks carrying no token (legacy metadata) cannot prove
 * they belong to the current incarnation and are refused; purely legacy
 * flows where neither side carries a token keep the historical behavior.
 */
function verifyProjectIdentity(meta: ProjectMeta): { ok: true } | { ok: false; reason: string } {
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
    const capturedInc = typeof meta.incarnation === "string" ? meta.incarnation : null;
    const registeredInc =
      typeof registered.incarnation === "string" ? registered.incarnation : null;
    if (capturedInc && registeredInc) {
      if (capturedInc !== registeredInc) {
        return {
          ok: false,
          reason: `project was deleted and re-registered since task start (incarnation changed); refusing to publish a stale task into the new project`,
        };
      }
    } else if (!capturedInc && registeredInc) {
      return {
        ok: false,
        reason: `task carries no registration incarnation but the project was re-registered; refusing to write without proof of identity`,
      };
    } else if (capturedInc && !registeredInc) {
      return {
        ok: false,
        reason: `registered project carries no registration incarnation; refusing to write without proof of identity`,
      };
    }
  } catch {
    return { ok: false, reason: `cannot verify project identity; refusing to write` };
  }
  return { ok: true };
}

/**
 * Freshness that never reports `fresh` for a torn persistence snapshot.
 * `getGraphFreshness` is a pure function of the loaded index; a crash
 * between the `index.json` and `meta.json` renames can leave two copies
 * that still look fresh individually. Every graph read path that can
 * report freshness to a caller must go through here (or through
 * `ensureFreshIndex`, which rebuilds on mismatch) instead of calling
 * `getGraphFreshness` directly on unvalidated data.
 */
export function getValidatedFreshness(
  projectId: string,
  index: ProjectIndex | null | undefined
): GraphFreshness {
  if (!index) return "unindexed";
  let mismatched = false;
  try {
    mismatched = !checkPersistenceConsistency(projectId).consistent;
  } catch {
    mismatched = false;
  }
  const actual = getGraphFreshness(index);
  if (mismatched) return actual === "fresh" ? "stale" : actual;
  return actual;
}

/** Read actual freshness, coercing `fresh` to `stale` on failure paths so a
 * failed refresh can never be reported as `fresh`. Persistence consistency
 * is validated first so a torn snapshot can never read as `fresh` either. */
function failureFreshness(projectId: string): GraphFreshness {
  const actual = getValidatedFreshness(projectId, loadProjectIndex(projectId));
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
  let scope: GraphScope = opts.forceFull && impact.scope !== "none" ? "full" : impact.scope;

  if (scope === "none") {
    // A torn persistence snapshot must never be reported as fresh just
    // because no caller-reported change was in scope: validate the pairing
    // before skipping, and take a safe broader refresh on mismatch.
    let mismatched = false;
    try {
      mismatched = !checkPersistenceConsistency(meta.id).consistent;
    } catch {
      mismatched = true;
    }
    if (mismatched) {
      impact = {
        scope: "full",
        reason: "persisted snapshot is inconsistent; safe broader refresh",
      };
      warnings.push("Persisted index snapshot is inconsistent (likely partial write); rebuilding.");
      scope = "full";
    } else {
      const freshnessAfter = getValidatedFreshness(meta.id, loadProjectIndex(meta.id));
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
      // The candidate was built from disk over a non-atomic window: files
      // may have changed during the build or between drift detection and
      // publishing. Re-check before reporting fresh; if drift is found,
      // keep the graph marked stale so the next read schedules a safe
      // follow-up instead of falsely reporting fresh.
      let freshnessAfter = getGraphFreshness(after);
      let followUpWarning: string | undefined;
      try {
        if (after && detectStaleIndexEntries(after).isStale) {
          markProjectGraphStatus(
            meta.id,
            "stale",
            "disk changed during sync; follow-up refresh recommended"
          );
          freshnessAfter = getGraphFreshness(loadProjectIndex(meta.id));
          if (freshnessAfter === "fresh") freshnessAfter = "stale";
          followUpWarning =
            "Disk changed during synchronization; graph kept stale and a follow-up refresh is recommended.";
        }
      } catch {
        // best effort; keep the computed freshnessAfter
      }
      const mergedWarnings =
        followUpWarning !== undefined ? [...warnings, followUpWarning] : warnings;
      return {
        codeValidation,
        graphScope: scope,
        graphResult: "synced",
        freshnessAfter,
        message: `Graph synchronized (${scope}; ${impact.reason}).${followUpWarning ? " Follow-up refresh recommended." : ""}`,
        changes: candidate.changes
          ? {
              added: candidate.changes.added.length,
              modified: candidate.changes.modified.length,
              renamed: candidate.changes.renamed.length,
              deleted: candidate.changes.deleted.length,
            }
          : undefined,
        rejectedFiles: rejectedFiles.length > 0 ? rejectedFiles : undefined,
        warnings: mergedWarnings.length > 0 ? mergedWarnings : undefined,
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

/** In-flight sync promises keyed by project id plus a stable hash of the
 * requested change set: duplicate completion callbacks for the same
 * project AND the same change set share one rebuild instead of racing.
 * Different change sets or options run as separate tasks (serialized by
 * the index file lock plus a generation guard) so a narrow incremental
 * request can never inherit a broad full-rebuild result or vice versa. */
const syncInFlight = new Map<string, Promise<SyncReport>>();

function dedupKeyFor(
  meta: ProjectMeta,
  changedFiles: string[],
  codeValidation: { ran: boolean; passed: boolean; detail: string },
  opts: { uncertain?: boolean; forceFull?: boolean }
): string {
  const norm = [...new Set(sanitizeChangedFiles(changedFiles))].sort();
  // The incarnation is part of the key: a stale task reusing an old
  // registration must never share (or inherit) a fresh task's rebuild.
  const inc = typeof meta.incarnation === "string" ? meta.incarnation : "";
  return `${meta.id}::${inc}::${JSON.stringify({ f: norm, r: codeValidation.ran, p: codeValidation.passed, u: !!opts.uncertain, ff: !!opts.forceFull })}`;
}

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
  const key = dedupKeyFor(meta, changedFiles, codeValidation, opts);
  const running = syncInFlight.get(key);
  if (running) return running;
  const task = synchronizeGraphAfterChanges(meta, changedFiles, codeValidation, opts);
  syncInFlight.set(key, task);
  task.then(
    () => {
      if (syncInFlight.get(key) === task) syncInFlight.delete(key);
    },
    () => {
      if (syncInFlight.get(key) === task) syncInFlight.delete(key);
    }
  );
  return task;
}

const CLEAN_STALENESS: KnownStaleness = { isStale: false, staleFiles: [], deletedFiles: [] };

export type RefreshOutcome = "not-required" | "refreshed" | "refresh-failed";

export interface FreshIndexResult {
  index: ProjectIndex | null;
  freshnessBefore: GraphFreshness;
  freshnessAfter: GraphFreshness;
  refreshOutcome: RefreshOutcome;
  warning?: string;
  /** Set when the graph is known fresh, so later steps need not re-scan for drift. */
  knownStaleness?: KnownStaleness;
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
  // Crash-recovery: a partial write between meta.json and index.json must
  // never read as fresh. Force a rebuild when the copies disagree.
  let persistenceMismatched = false;
  try {
    persistenceMismatched = !checkPersistenceConsistency(meta.id).consistent;
  } catch {
    persistenceMismatched = false;
  }
  if (freshnessBefore === "fresh" && !persistenceMismatched) {
    return {
      index,
      freshnessBefore,
      freshnessAfter: "fresh",
      refreshOutcome: "not-required",
      knownStaleness: CLEAN_STALENESS,
    };
  }
  // Active-project correctness: never write to a project that was
  // switched, closed, or deleted after the caller loaded its meta.
  const identity = verifyProjectIdentity(meta);
  if (!identity.ok) {
    const after = loadProjectIndex(meta.id) ?? index;
    return {
      index: after,
      freshnessBefore,
      freshnessAfter: after ? failureFreshness(meta.id) : "unindexed",
      refreshOutcome: "refresh-failed",
      warning: `Graph refresh refused (${identity.reason}); using last-known index.`,
    };
  }
  try {
    const refreshed = await indexProject(meta);
    const freshnessAfter = getSnapshotFreshness(refreshed);
    return {
      index: refreshed,
      freshnessBefore,
      freshnessAfter,
      refreshOutcome: "refreshed",
      ...(freshnessAfter === "fresh" ? { knownStaleness: CLEAN_STALENESS } : {}),
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
  /** Import-graph nodes expanded (bounded by depth and file caps). */
  graphSteps?: number;
}

export interface GraphExpansionOptions {
  /** Import hops to follow from the selected files (default 1, at most 3). */
  depth?: number;
  /** Maximum supporting files to return (default 10, at most 25). */
  maxFiles?: number;
}

const DEFAULT_EXPANSION_DEPTH = 1;
const DEFAULT_EXPANSION_FILES = 10;
const MAX_EXPANSION_DEPTH = 3;
const MAX_EXPANSION_FILES = 25;
const MAX_TEST_AND_SUPPORT_FILES = 12;

/** Resolved in-index import targets of a file (persisted resolution, or resolved on the fly for legacy snapshots). */
function importTargets(index: ProjectIndex, rel: string): string[] {
  const file = Object.prototype.hasOwnProperty.call(index.files, rel)
    ? index.files[rel]
    : undefined;
  if (!file) return [];
  const has = (p: string): boolean => Object.prototype.hasOwnProperty.call(index.files, p);
  const out: string[] = [];
  for (const dep of file.dependencies) {
    for (const target of dependencyTargets(dep, rel, has)) {
      if (target !== rel && has(target) && !out.includes(target)) out.push(target);
    }
  }
  return out;
}

/**
 * Expand user-selected primary targets into bounded supporting context: files
 * they import and files that import them (import relationships only: no call
 * graph is built or implied), related tests, and co-defined symbols. Breadth-
 * first by import hop with an explicit depth and file cap, using the
 * per-index reverse-import map instead of rescanning every file. Package and
 * alias specifiers, and languages without an import resolver, are not followed;
 * that is reported in the rationale instead of being guessed.
 */
export function expandSupportingFiles(
  index: ProjectIndex,
  selected: string[],
  options: GraphExpansionOptions = {}
): SupportingContext {
  const depthLimit = Math.min(
    Math.max(1, Math.floor(options.depth ?? DEFAULT_EXPANSION_DEPTH)),
    MAX_EXPANSION_DEPTH
  );
  const fileCap = Math.min(
    Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_EXPANSION_FILES)),
    MAX_EXPANSION_FILES
  );
  const supporting: SupportingFile[] = [];
  const dependencies: IndexedDependency[] = [];
  const symbols: IndexedSymbol[] = [];
  const testFiles: string[] = [];
  const rationale: string[] = [];
  const seen = new Set<string>(selected);
  let steps = 0;
  const push = (p: string, reason: string): boolean => {
    if (seen.has(p) || supporting.length >= fileCap) return false;
    if (!Object.prototype.hasOwnProperty.call(index.files, p)) return false;
    seen.add(p);
    supporting.push({ path: p, reason });
    return true;
  };

  let unresolvedPackages = 0;
  let unresolvedRelative = 0;
  const present: string[] = [];
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
    present.push(rel);
    for (const sym of file.symbols.slice(0, 20)) {
      if (symbols.length < 15) symbols.push(sym);
    }
    for (const dep of file.dependencies) {
      if (dep.resolution === "non-relative" || dep.resolution === "unsupported") {
        unresolvedPackages++;
      } else if (dep.resolution === "unresolved") {
        unresolvedRelative++;
      }
    }
    for (const dep of file.dependencies.slice(0, 20)) {
      if (dependencies.length < 15) dependencies.push(dep);
    }
  }

  // Import hops: forward (files the frontier imports) and backward (files that import it).
  const reverse = getReverseImports(index);
  let frontier = present.map((rel) => ({ rel, origin: rel }));
  for (let depth = 1; depth <= depthLimit && frontier.length > 0; depth++) {
    const next: Array<{ rel: string; origin: string }> = [];
    for (const { rel, origin } of frontier) {
      steps++;
      for (const target of importTargets(index, rel)) {
        const via =
          depth === 1
            ? `imported by selected file ${rel}`
            : `imported by ${rel} (depth ${depth}, from ${origin})`;
        if (push(target, via)) next.push({ rel: target, origin });
      }
      for (const importer of reverse.get(rel) ?? []) {
        const via =
          depth === 1
            ? `imports selected file ${rel}`
            : `imports ${rel} (depth ${depth}, from ${origin})`;
        if (push(importer, via)) next.push({ rel: importer, origin });
      }
      if (supporting.length >= fileCap) break;
    }
    frontier = next;
    if (supporting.length >= fileCap) break;
  }

  // Related tests by naming convention (one pass over the test files).
  if (present.length > 0) {
    const tests = Object.entries(index.files).filter(([, f]) => f.isTest);
    for (const rel of present) {
      const base =
        rel
          .split("/")
          .pop()
          ?.replace(/\.[^.]+$/, "")
          .toLowerCase() ?? "";
      if (!base) continue;
      for (const [otherRel] of tests) {
        if (
          seen.has(otherRel) ||
          testFiles.length + supporting.length >= MAX_TEST_AND_SUPPORT_FILES
        ) {
          break;
        }
        if (otherRel.toLowerCase().includes(base)) {
          testFiles.push(otherRel);
          push(otherRel, `test file related to selected file ${rel}`);
        }
      }
    }
  }

  if (supporting.length > 0) {
    rationale.push(
      `Included ${supporting.length} supporting file(s) via imports (depth ${depthLimit}), importers, or related tests of the selected targets (import relationships only; no call graph).`
    );
  }
  if (unresolvedPackages > 0 || unresolvedRelative > 0) {
    rationale.push(
      `Not followed: ${unresolvedPackages} package/alias/unsupported-language import(s) and ${unresolvedRelative} relative import(s) that match no indexed file.`
    );
  }
  return { supporting, dependencies, symbols, testFiles, rationale, graphSteps: steps };
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
  /** Import-graph expansion steps taken while planning (telemetry; 0 when no files were selected). */
  graphSteps?: number;
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
  // Never plan against a torn snapshot as if it were fresh: validate the
  // persistence pairing before trusting a `fresh` reading.
  const rawFreshness = getGraphFreshness(index);
  const freshness =
    rawFreshness === "fresh" && !checkPersistenceConsistency(meta.id).consistent
      ? "stale"
      : rawFreshness;

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
  let graphSteps = 0;
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
      graphSteps = expanded.graphSteps ?? 0;
      // Small inferred sweep for files the selection did not cover. Ranking
      // uses index data only: planning needs paths, not source text.
      try {
        const ranking = rankCandidates(workingIndex, task);
        for (const m of ranking.ranked) {
          const p = m.file.relativePath;
          if (isPotentialSecretPath(p)) continue;
          if (!selected.includes(p) && !supporting.some((s) => s.path === p)) {
            if (inferredFiles.length < 5) inferredFiles.push(p);
          }
          if (inferredFiles.length >= 5) break;
        }
      } catch {
        warnings.push("Context retrieval unavailable; relying on selected files only.");
      }
    } else if (!understanding.isSimple) {
      try {
        const ranking = rankCandidates(workingIndex, task);
        inferredFiles = ranking.ranked
          .map((m) => m.file.relativePath)
          .filter((p) => !isPotentialSecretPath(p))
          .slice(0, 5);
        dependencies = ranking.dependencies.slice(0, 15);
        symbols = ranking.matchedSymbols.slice(0, 15);
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
    graphSteps,
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
  // Capture the full registration identity — including the incarnation
  // token — before running `taskFn`, and carry it through planning,
  // execution, synchronization, and publication. A delete + re-register
  // at the same path mints a new incarnation, so this captured identity
  // no longer verifies and the stale task cannot publish.
  const captured = {
    id: meta.id,
    canonicalPath: meta.canonicalPath,
    incarnation: typeof meta.incarnation === "string" ? meta.incarnation : null,
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

  const intended: ProjectMeta = {
    ...meta,
    id: captured.id,
    canonicalPath: captured.canonicalPath,
    incarnation: captured.incarnation,
  };
  // An abnormal task end (failure or cancellation) may have left partial
  // or still-mutating changes (e.g. a surviving detached descendant), so
  // the change scope is marked uncertain and takes the broader refresh
  // path. Sync failure still never rewrites the task outcome.
  const syncUncertain = request.uncertain === true || taskOutcome !== "completed";
  const syncReport = await synchronizeGraphDeduped(
    intended,
    Array.isArray(request.changedFiles) ? (request.changedFiles as string[]) : [],
    request.codeValidation ?? {
      ran: false,
      passed: false,
      detail: "no validation detail provided",
    },
    { uncertain: syncUncertain, forceFull: request.forceFull }
  );
  return { taskOutcome, taskError, syncReport, project: captured.project };
}

export type ExternalCommandOutcome = "exited" | "timeout" | "aborted" | "spawn-error";

export interface ExternalCommandResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** True when cancellation was requested (abort signal fired). */
  aborted: boolean;
  /** True when the child process could never be started. */
  spawnFailed: boolean;
  /** Human-readable spawn/child error, when known. */
  spawnError?: string;
  /** Distinct outcome: normal exit, timeout, abort, or spawn failure. */
  outcome: ExternalCommandOutcome;
  /** True once process-tree termination was attempted (timeout/abort). */
  treeKillAttempted: boolean;
  /**
   * True after timeout/abort termination was attempted. Termination is
   * attempted, not guaranteed: a detached descendant that escaped its
   * process group/session may still be running and modifying files, so
   * callers must treat freshness after such an outcome as point-in-time
   * and force a broader, follow-up refresh rather than trusting an
   * immediately-fresh graph.
   */
  descendantsMaySurvive: boolean;
  durationMs: number;
}

/**
 * Whether `command` needs shell evaluation for the target platform.
 * Restricted to Windows `.cmd`/`.bat` batch files only: POSIX never uses
 * a shell (direct argv, no string evaluation). `.ps1` scripts never use a
 * shell either; see {@link resolveSpawnTarget} for how they are launched.
 * Pure function of (command, platform) so the Windows branch is
 * unit-testable on any OS.
 */
export function needsShellForCommand(
  command: string,
  platform: string = process.platform
): boolean {
  if (platform !== "win32") return false;
  return /\.(cmd|bat)$/i.test((command ?? "").trim());
}

export interface SpawnTarget {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * Resolves the (command, args, shell) triple `runExternalAgentCommand` should
 * spawn. Windows `.ps1` scripts cannot be executed directly, so they run via
 * `powershell.exe -NoProfile -File <script> ...args` — still no shell (argv
 * stays an array) and WITHOUT `-ExecutionPolicy Bypass`, so the user's
 * execution policy is respected rather than silently overridden. Everything
 * else is unchanged: `.cmd`/`.bat` opt into a shell, all else spawns directly.
 * Pure function of (command, args, platform) so it is unit-testable anywhere.
 */
export function resolveSpawnTarget(
  command: string,
  args: string[],
  platform: string = process.platform
): SpawnTarget {
  if (platform === "win32" && /\.ps1$/i.test((command ?? "").trim())) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-File", command.trim(), ...args],
      shell: false,
    };
  }
  return { command, args, shell: needsShellForCommand(command, platform) };
}

/**
 * Portable subprocess runner for the `kai run` lifecycle wrapper. No shell
 * by default (direct argv, no string evaluation); callers targeting Windows
 * batch files may opt into `shell: true` (see `needsShellForCommand`).
 *
 * Termination: on timeout or abort the whole process tree is signalled —
 * the child's process group on POSIX (`detached: true` + negative-pid
 * kill, so direct descendants die with the parent) and `taskkill /T /F`
 * on Windows — with SIGTERM first and SIGKILL after a 2 s grace period.
 * The returned promise resolves on child `close` (reaped) exactly once;
 * abort, timeout, child error, spawn failure, and normal exit are
 * distinct, correctly reported outcomes. All timers and listeners are
 * cleaned up on every exit path.
 *
 * Guarantee limit (documented, not eliminated): a descendant that
 * detaches into its own session/group (double-fork, `setsid`, Windows
 * `DETACHED_PROCESS`) escapes tree termination and cannot be reaped
 * here. Such outcomes set `descendantsMaySurvive` and callers must treat
 * freshness as point-in-time with a follow-up refresh (see `kai run`).
 */

/**
 * Emit {@link TERMINAL_MODE_RESET_SEQ} so a TUI that died without restoring
 * terminal modes cannot keep injecting mouse/focus/paste input. Safe to
 * call on every path (success, timeout, signal, abort): non-TTY stdout
 * (piped/CI) is skipped so logs stay clean.
 *
 * `clearStaleUi` additionally erases the agent's leftover last frame below the
 * cursor ({@link AGENT_EXIT_CLEANUP_SEQ}); pass it once, right after the agent
 * exits and before anything else is printed.
 */
export function resetTerminalModesAfterAgent(opts: { clearStaleUi?: boolean } = {}): void {
  try {
    const out = process.stdout;
    if (!out || (out as unknown as { isTTY?: boolean }).isTTY !== true) return;
    out.write(
      opts.clearStaleUi ? TERMINAL_MODE_RESET_SEQ + AGENT_EXIT_CLEANUP_SEQ : TERMINAL_MODE_RESET_SEQ
    );
  } catch {
    // Terminal restore is best-effort; never fail the task over it.
  }
}

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
  const base = {
    exitCode: null as number | null,
    signal: null as string | null,
    timedOut: false,
    aborted: false,
    spawnFailed: false,
    spawnError: undefined as string | undefined,
    outcome: "exited" as ExternalCommandOutcome,
    treeKillAttempted: false,
    descendantsMaySurvive: false,
    durationMs: 0,
  };
  // An already-aborted signal short-circuits before spawning: no child is
  // created, so there is nothing to terminate or reap.
  if (opts.signal?.aborted) {
    return Promise.resolve({
      ...base,
      aborted: true,
      outcome: "aborted",
      durationMs: Date.now() - started,
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (patch: Partial<ExternalCommandResult>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ...base, ...patch, durationMs: Date.now() - started });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: opts.shell ?? false,
        stdio: "inherit",
        windowsHide: true,
        // POSIX: lead a fresh process group so tree termination can
        // signal the child AND its direct descendants via kill(-pid).
        // Windows uses taskkill /T /F instead (no detached flag, so the
        // child stays in the caller's console job for ^C propagation).
        detached: process.platform !== "win32",
      });
    } catch (err) {
      resolve({
        ...base,
        spawnFailed: true,
        spawnError: err instanceof Error ? err.message : String(err),
        outcome: "spawn-error",
        durationMs: Date.now() - started,
      });
      return;
    }
    let timedOut = false;
    let aborted = false;
    let spawnFailed = false;
    let spawnError: string | undefined;
    let treeKillAttempted = false;
    let timeout: NodeJS.Timeout | null = null;
    let escalateTimer: NodeJS.Timeout | null = null;
    let abortFallback: NodeJS.Timeout | null = null;
    const groupSignal = (sig: NodeJS.Signals): void => {
      const pid = typeof child.pid === "number" ? child.pid : undefined;
      if (process.platform === "win32") {
        if (pid !== undefined) {
          try {
            spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
            });
          } catch {
            // fall through to plain kill
          }
        }
        try {
          child.kill(sig);
        } catch {
          // already exited
        }
        return;
      }
      // POSIX: signal the whole process group first (child + direct
      // descendants), falling back to the child alone.
      if (pid !== undefined) {
        try {
          process.kill(-pid, sig);
          return;
        } catch {
          // Group kill failed (already reaped or permission): try direct.
        }
      }
      try {
        child.kill(sig);
      } catch {
        // already exited
      }
    };
    const killTree = (): void => {
      treeKillAttempted = true;
      groupSignal("SIGTERM");
      if (escalateTimer) {
        clearTimeout(escalateTimer);
        escalateTimer = null;
      }
      escalateTimer = setTimeout(() => {
        escalateTimer = null;
        groupSignal("SIGKILL");
      }, 2000);
      if (typeof (escalateTimer as unknown as { unref?: () => void }).unref === "function") {
        (escalateTimer as unknown as { unref: () => void }).unref();
      }
    };
    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (escalateTimer) {
        clearTimeout(escalateTimer);
        escalateTimer = null;
      }
      if (abortFallback) {
        clearTimeout(abortFallback);
        abortFallback = null;
      }
      opts.signal?.removeEventListener("abort", onAbort);
      child.removeAllListeners("error");
      child.removeAllListeners("close");
    };
    const onAbort = (): void => {
      aborted = true;
      killTree();
      // Resolution happens on child `close` (reaped). If the child already
      // exited, `close` has fired or will fire imminently; the guard below
      // covers a vanishing child whose `close` never arrives.
      if (abortFallback) clearTimeout(abortFallback);
      abortFallback = setTimeout(() => {
        abortFallback = null;
        finish({
          timedOut,
          aborted,
          spawnFailed,
          spawnError,
          outcome: spawnFailed ? "spawn-error" : timedOut ? "timeout" : "aborted",
          treeKillAttempted,
          descendantsMaySurvive: treeKillAttempted,
        });
      }, 2500);
      if (typeof (abortFallback as unknown as { unref?: () => void }).unref === "function") {
        (abortFallback as unknown as { unref: () => void }).unref();
      }
    };
    if (opts.signal) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (opts.timeoutMs && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timeout = null;
        timedOut = true;
        killTree();
      }, opts.timeoutMs);
      if (typeof (timeout as unknown as { unref?: () => void }).unref === "function") {
        (timeout as unknown as { unref: () => void }).unref();
      }
    }
    child.on("error", (err) => {
      // Spawn failure (ENOENT, EACCES, ...): no child exists to reap.
      // `close` may still follow — the settled guard keeps this single.
      spawnFailed = true;
      spawnError = err instanceof Error ? err.message : String(err);
      finish({
        timedOut,
        aborted,
        spawnFailed,
        spawnError,
        outcome: timedOut ? "timeout" : aborted ? "aborted" : "spawn-error",
        treeKillAttempted,
        descendantsMaySurvive: treeKillAttempted,
      });
    });
    child.on("close", (code, sig) => {
      finish({
        exitCode: code,
        signal: typeof sig === "string" ? sig : sig ? String(sig) : null,
        timedOut,
        aborted,
        spawnFailed,
        spawnError,
        outcome: spawnFailed
          ? "spawn-error"
          : timedOut
            ? "timeout"
            : aborted
              ? "aborted"
              : "exited",
        treeKillAttempted,
        descendantsMaySurvive: treeKillAttempted,
      });
    });
  });
}
