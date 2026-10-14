import type { ProjectIndex, ProjectMeta, TaskCategory } from "./types";
import { classifyTask } from "./classifier";
import { detectStaleIndexEntries } from "./indexer";
import { loadProjectIndex, saveProjectIndex, markProjectGraphStatus } from "./registry";
import { indexProject } from "./indexer";

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
  const impact = computeGraphImpact(sanitized, { uncertain: opts.uncertain });
  const scope: GraphScope = opts.forceFull && impact.scope !== "none" ? "full" : impact.scope;

  if (scope === "none") {
    const freshnessAfter = getGraphFreshness(loadProjectIndex(meta.id));
    return {
      codeValidation,
      graphScope: scope,
      graphResult: "skipped",
      freshnessAfter,
      message: `No relevant graph impact (${impact.reason}); rebuild skipped.`,
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
      };
    } catch (err) {
      markStaleGuarded(meta.id, baseGeneratedAt, `synchronization failed: ${String(err)}`);
      return {
        codeValidation,
        graphScope: scope,
        graphResult: "failed",
        freshnessAfter: failureFreshness(meta.id),
        message: `Graph synchronization failed (${String(err)}); code changes preserved, graph marked stale.`,
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
