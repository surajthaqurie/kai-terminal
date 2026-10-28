import crypto from "crypto";
import type {
  ProjectIndex,
  RetrievalOptions,
  ContextPackage,
  ContextOmission,
  TaskCategory,
  TokenMetrics,
} from "./types";
import { classifyTask } from "./classifier";
import { retrieveContext, type ExpansionOptions } from "./retrieval";
import { selectRelevantSkills, formatSkillContent, BUILTIN_SKILLS } from "./skills";
import { TASK_TEMPLATES, DEFAULT_RENDERED_OMISSIONS } from "./templates";
import { estimateTokens, truncateToTokenBudget } from "./tokenCounter";
import { detectStaleIndexEntries } from "./indexer";
import { jsonEscapedBytes, clipEscapedBytes } from "./mcpResponse";

const MIN_BUDGET = 200;
const MAX_BUDGET = 20000;
const FALLBACK_BUDGET = 4000;

/**
 * Starting budgets (rendered package, estimated tokens) when the caller gives
 * none. They bound the whole package: ~500 reserved for the task and framing,
 * plus rules and skills, plus retrieved source. Only budgets below the legacy
 * flat default are used: they cut response size with the expected file still
 * retrieved on the benchmark tasks. Categories that need broad context (implement,
 * architecture, refactor) keep the legacy default because a larger one grew
 * responses by up to ~50% with no measured relevance gain. These are experimental
 * starting points, not measured optima; override with KAI_CONTEXT_BUDGETS (JSON,
 * category -> tokens) or an explicit `tokenBudget`.
 */
export const DEFAULT_CONTEXT_BUDGETS: Readonly<Record<TaskCategory, number>> = {
  explain: 1700,
  documentation: 1700,
  review: 3000,
  test: 3000,
  debug: 3000,
  implement: FALLBACK_BUDGET,
  architecture: FALLBACK_BUDGET,
  refactor: FALLBACK_BUDGET,
  unknown: FALLBACK_BUDGET,
};

/** Files below this fraction of the best match are not padded in under an adaptive budget. */
const ADAPTIVE_MIN_SCORE_RATIO = 0.25;
const ADAPTIVE_MIN_FILES = 2;
/** Measured fixed cost of the rendered package (template framing, omission and footer lines). */
const ADAPTIVE_FRAMING_TOKENS = 800;
/**
 * Which neighbours of the symbol a task names are worth their tokens. Callers are
 * the edit set of a refactor; the tests that import the symbol's file guard any
 * change to it. Other categories get none, since none are measured to need them.
 */
function expansionFor(category: string): ExpansionOptions | undefined {
  const callers = category === "refactor";
  const tests =
    category === "refactor" ||
    category === "debug" ||
    category === "implement" ||
    category === "test";
  // Implementation tasks usually name no symbol ("add an endpoint"): let a dominant
  // top file anchor the expansion so its contracts and tests are seen too.
  const fileAnchor = category === "implement";
  return callers || tests ? { callers, tests, ...(fileAnchor ? { fileAnchor } : {}) } : undefined;
}

/** Fraction of an adaptive package (after the fixed reserve) that rules and skills may use. */
const ADAPTIVE_RULES_SKILLS_SHARE = 0.4;
/** Smallest retrieval budget an adaptive package asks for; the generic floor (800) could exceed a small budget. */
const ADAPTIVE_MIN_RETRIEVAL_TOKENS = 400;
/** A lone source at or below this is dropped rather than shortened again (halving would leave a stub). */
const MIN_SHORTENABLE_SOURCE_TOKENS = 300;

function clampBudget(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(n, MIN_BUDGET), MAX_BUDGET);
}

/** Defaults with any valid KAI_CONTEXT_BUDGETS overrides applied; malformed input is ignored. */
export function resolveContextBudgets(
  raw: string | undefined = process.env.KAI_CONTEXT_BUDGETS
): Record<TaskCategory, number> {
  const budgets: Record<TaskCategory, number> = { ...DEFAULT_CONTEXT_BUDGETS };
  if (!raw) return budgets;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return budgets;
    for (const category of Object.keys(budgets) as TaskCategory[]) {
      const v = (parsed as Record<string, unknown>)[category];
      if (typeof v === "number" && Number.isFinite(v))
        budgets[category] = clampBudget(v, budgets[category]);
    }
  } catch {
    // Unparseable override: keep the defaults rather than failing a request.
  }
  return budgets;
}

export function assembleContext(
  index: ProjectIndex,
  options: RetrievalOptions
): { contextPackage: ContextPackage; renderedPrompt: string } {
  const originalTask = options.task;
  // Deterministic timestamp if provided by caller/options, else current ISO time
  const assembledAt = options.assembledAt ?? new Date().toISOString();
  const tokenizer = options.tokenizer;

  // 1. Task classification
  const classification = classifyTask(originalTask, options.categoryOverride);

  // Single source of truth for budget bounds (mirrors MCP/retrieval clamps).
  // An explicit budget is honoured as given; only an omitted one is task-aware.
  const adaptive = options.adaptiveBudget === true && options.tokenBudget === undefined;
  const budgetOrigin: "explicit" | "task-default" | "default" =
    options.tokenBudget !== undefined ? "explicit" : adaptive ? "task-default" : "default";
  const tokenBudget = clampBudget(
    adaptive ? resolveContextBudgets()[classification.category] : options.tokenBudget,
    FALLBACK_BUDGET
  );

  // 2. Check index freshness
  let indexFreshness: "fresh" | "stale" | "unindexed" = "fresh";
  if (!index.meta.lastIndexedAt) {
    indexFreshness = "unindexed";
  } else {
    const ageMs = Date.now() - new Date(index.meta.lastIndexedAt).getTime();
    if (ageMs > 24 * 60 * 60 * 1000) {
      // Older than 24 hours
      indexFreshness = "stale";
    }
  }

  // A caller that already ran its freshness gate for this request passes the
  // result in; otherwise the drift scan runs here.
  const stalenessCheck = options.knownStaleness ?? detectStaleIndexEntries(index);
  if (stalenessCheck.isStale) {
    indexFreshness = "stale";
  }

  // 3. Project rules & constraints (with duplicate removal)
  const applicableRules: Array<{ source: string; content: string }> = [];
  const omissions: ContextOmission[] = [];
  const seenRuleHashes = new Set<string>();
  // Reserve for task, guidelines, and metadata. The generic 500 undershoots the
  // measured framing (~610 tokens of template plus ~150 of omission and footer
  // lines): with it, a small adaptive package got a retrieval budget its framing
  // could not share, and the final fit step then dropped the top source wholesale.
  const available = tokenBudget - (adaptive ? ADAPTIVE_FRAMING_TOKENS : 500);
  // Adaptive packages are small, so rules and skills must not crowd out the
  // source the task is about: they share a fixed fraction, retrieval gets the rest.
  let remainingBudget = adaptive ? Math.floor(available * ADAPTIVE_RULES_SKILLS_SHARE) : available;
  const rulesSkillsAllowance = remainingBudget;

  for (const rawRule of index.rules) {
    const match = rawRule.match(/^\[Rule File:\s*([^\]]+)\]\n([\s\S]*)$/);
    const source = match ? match[1] : "project-rules";
    const content = match ? match[2] : rawRule;

    // Deduplicate identical rules from multiple rule files
    const ruleHash = crypto.createHash("sha256").update(content.trim()).digest("hex");
    if (seenRuleHashes.has(ruleHash)) continue;
    seenRuleHashes.add(ruleHash);

    const ruleTokens = estimateTokens(content, tokenizer).estimatedTokens;
    if (ruleTokens <= 600 && remainingBudget >= ruleTokens) {
      applicableRules.push({ source, content });
      remainingBudget -= ruleTokens;
    } else if (remainingBudget > 200) {
      const truncated = truncateToTokenBudget(content, 200, tokenizer);
      applicableRules.push({ source, content: truncated.text });
      remainingBudget -= truncated.metrics.estimatedTokens;
    } else {
      omissions.push({
        type: "rule",
        identifier: source,
        reason: "budget_exceeded",
        estimatedTokens: ruleTokens,
      });
    }
  }

  // 4. Relevant skills selection
  const selectedSkills: Array<{ id: string; name: string; reason: string; content: string }> = [];
  if (options.includeSkills !== false) {
    // Detect project languages from index
    const detectedLanguages = Array.from(
      new Set(Object.values(index.files).map((f) => f.language))
    );
    const matchedSkills = selectRelevantSkills(
      BUILTIN_SKILLS,
      classification.category,
      detectedLanguages,
      classification.detectedKeywords
    );

    for (const match of matchedSkills) {
      const formatted = formatSkillContent(match.skill);
      const skillTokens = estimateTokens(formatted, tokenizer).estimatedTokens;
      if (remainingBudget >= skillTokens) {
        selectedSkills.push({
          id: match.skill.id,
          name: match.skill.name,
          reason: match.reason,
          content: formatted,
        });
        remainingBudget -= skillTokens;
      } else {
        omissions.push({
          type: "skill",
          identifier: match.skill.id,
          reason: "budget_exceeded",
          estimatedTokens: skillTokens,
        });
      }
    }
  }

  // 5. Source code & symbol retrieval
  const retrieval = retrieveContext(index, originalTask, {
    tokenBudget: Math.max(
      adaptive ? ADAPTIVE_MIN_RETRIEVAL_TOKENS : 800,
      available - (rulesSkillsAllowance - remainingBudget)
    ),
    fileBudget: options.fileBudget ?? 6,
    includeTests:
      options.includeTests ??
      (classification.category === "test" || classification.category === "debug"),
    tokenizer,
    minScoreRatio: adaptive ? ADAPTIVE_MIN_SCORE_RATIO : 0,
    minFiles: ADAPTIVE_MIN_FILES,
    // Bounded neighbour expansion only for default budgets; an explicit tokenBudget
    // keeps the plain ranked list.
    expand: adaptive ? expansionFor(classification.category) : undefined,
  });

  const sourceReferences = retrieval.matchedFiles.map((m) => ({
    relativePath: m.file.relativePath,
    startLine: m.startLine,
    endLine: m.endLine,
    relevanceScore: m.score,
    ...(m.relation ? { relation: m.relation } : {}),
    content: m.snippet || "",
  }));

  // The retrieval list is a capped sample; keep the real total so the cap stays visible.
  const omissionsBeforeRetrieval = omissions.length;
  omissions.push(...retrieval.omissions);

  // 6. Known limitations / caveats
  const knownLimitations: string[] = [];
  if (retrieval.staleFiles && retrieval.staleFiles.length > 0) {
    indexFreshness = "stale";
    knownLimitations.push(
      `Detected ${retrieval.staleFiles.length} file(s) modified on disk (or deleted) since indexing (${retrieval.staleFiles.slice(0, 3).join(", ")}). Rebuild with 'kai graph rebuild'.`
    );
  } else if (stalenessCheck.isStale) {
    const allStale = [...stalenessCheck.staleFiles, ...stalenessCheck.deletedFiles];
    knownLimitations.push(
      `Detected ${allStale.length} file(s) modified on disk (or deleted) since indexing (${allStale.slice(0, 3).join(", ")}). Rebuild with 'kai graph rebuild'.`
    );
  } else if (indexFreshness === "stale") {
    knownLimitations.push(
      "Index is more than 24 hours old; consider rebuilding with `kai graph rebuild`."
    );
  }
  if (classification.category === "unknown") {
    knownLimitations.push(
      "Task category could not be determined with high confidence; using general retrieval."
    );
  }

  // Assemble package
  const contextPackage: ContextPackage = {
    originalTask,
    classification,
    projectMeta: {
      id: index.meta.id,
      name: index.meta.name,
      canonicalPath: index.meta.canonicalPath,
      indexFreshness,
      lastIndexedAt: index.meta.lastIndexedAt,
    },
    applicableRules,
    sourceReferences,
    symbols: retrieval.matchedSymbols.slice(0, 15),
    dependencies: retrieval.dependencies.slice(0, 15),
    selectedSkills,
    knownLimitations,
    omissions,
    omissionsTotal: omissionsBeforeRetrieval + retrieval.omissionsTotal,
    budget: { tokens: tokenBudget, origin: budgetOrigin },
    tokenMetrics: {
      characterCount: 0,
      byteCount: 0,
      estimatedTokens: 0,
      isEstimate: !tokenizer,
      measuredTokens: tokenizer ? 0 : undefined,
    },
    assembledAt,
  };

  // Render via prompt template, then enforce the token budget (and, when the
  // caller has a response ceiling, the byte budget) as a hard guarantee.
  const byteBudget =
    typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes)
      ? Math.max(1024, Math.floor(options.maxBytes))
      : undefined;
  const template = TASK_TEMPLATES[classification.category] || TASK_TEMPLATES.unknown;
  // The omission list is diagnostic only: under pressure it shrinks before any
  // source, skill or rule is dropped (the structured list is left intact).
  let omissionRenderLimit = DEFAULT_RENDERED_OMISSIONS;
  let droppedByAssembler = 0;
  let sourcesShortened = false;
  const render = (): string => {
    contextPackage.omissionRenderLimit = omissionRenderLimit;
    contextPackage.omissionsTotal =
      omissionsBeforeRetrieval + retrieval.omissionsTotal + droppedByAssembler;
    const text = template.renderPrompt(contextPackage);
    contextPackage.tokenMetrics = estimateTokens(text, tokenizer);
    return text;
  };

  let renderedPrompt = render();
  const bytesOver = (): boolean =>
    byteBudget !== undefined && jsonEscapedBytes(renderedPrompt) > byteBudget;
  const over = (): boolean =>
    contextPackage.tokenMetrics.estimatedTokens > tokenBudget || bytesOver();

  /**
   * Drop the lowest-priority optional item and report what it was worth.
   * Priority (dropped first to last): the diagnostic omission lines, advisory
   * skills, lowest-scored source references (the array is relevance-ordered),
   * project rules (they constrain generation), and finally every remaining
   * omission line (a one-line "...and N more" count stays).
   */
  const OMISSION_LINE_TOKENS = 28;
  const OMISSION_LINE_BYTES = 110;
  const shrinkOmissionList = (to: number): { tokens: number; bytes: number } | null => {
    if (omissionRenderLimit <= to) return null;
    const lines = Math.max(
      0,
      Math.min(omissions.length, omissionRenderLimit) - Math.min(omissions.length, to)
    );
    omissionRenderLimit = to;
    return { tokens: lines * OMISSION_LINE_TOKENS, bytes: lines * OMISSION_LINE_BYTES };
  };
  const dropOne = (): { tokens: number; bytes: number } | null => {
    const trimmed = omissionRenderLimit > 3 ? shrinkOmissionList(3) : null;
    if (trimmed) return trimmed;
    if (contextPackage.selectedSkills.length > 0) {
      droppedByAssembler++;
      const dropped = contextPackage.selectedSkills.pop()!;
      const tokens = estimateTokens(dropped.content, tokenizer).estimatedTokens;
      omissions.push({
        type: "skill",
        identifier: dropped.id,
        reason: "budget_exceeded",
        estimatedTokens: tokens,
      });
      return { tokens, bytes: jsonEscapedBytes(dropped.content) };
    }
    if (contextPackage.sourceReferences.length === 1) {
      // The best match is the point of the package: halve it (on a line boundary,
      // with the reported range kept in step) before giving it up entirely, so a
      // tight budget yields a shortened answer rather than framing alone.
      const only = contextPackage.sourceReferences[0];
      const before = estimateTokens(only.content, tokenizer).estimatedTokens;
      if (before > MIN_SHORTENABLE_SOURCE_TOKENS) {
        const cut = truncateToTokenBudget(only.content, Math.floor(before / 2), tokenizer).text;
        const lineEnd = cut.lastIndexOf("\n");
        const kept = lineEnd > 0 ? cut.slice(0, lineEnd) : cut;
        if (kept.length > 0 && kept.length < only.content.length) {
          const savedBytes = jsonEscapedBytes(only.content) - jsonEscapedBytes(kept);
          only.content = kept;
          if (only.startLine !== undefined) {
            only.endLine = only.startLine + kept.split("\n").length - 1;
          }
          sourcesShortened = true;
          const after = estimateTokens(kept, tokenizer).estimatedTokens;
          return { tokens: Math.max(1, before - after), bytes: Math.max(0, savedBytes) };
        }
      }
    }
    if (contextPackage.sourceReferences.length > 0) {
      droppedByAssembler++;
      const dropped = contextPackage.sourceReferences.pop()!;
      const tokens = Math.max(1, estimateTokens(dropped.content, tokenizer).estimatedTokens);
      omissions.push({
        type: "file",
        identifier: dropped.relativePath,
        reason: "budget_exceeded",
        estimatedTokens: tokens,
      });
      return { tokens, bytes: jsonEscapedBytes(dropped.content) };
    }
    if (contextPackage.applicableRules.length > 0) {
      droppedByAssembler++;
      const dropped = contextPackage.applicableRules.pop()!;
      const tokens = estimateTokens(dropped.content, tokenizer).estimatedTokens;
      omissions.push({
        type: "rule",
        identifier: dropped.source,
        reason: "budget_exceeded",
        estimatedTokens: tokens,
      });
      return { tokens, bytes: jsonEscapedBytes(dropped.content) };
    }
    return shrinkOmissionList(0);
  };

  /** Hard-truncate `text` to both budgets; the caller verifies the user task survived. */
  const truncateToBudgets = (text: string): { text: string; metrics: TokenMetrics } => {
    let candidate = text;
    let metrics = estimateTokens(candidate, tokenizer);
    if (metrics.estimatedTokens > tokenBudget) {
      const truncated = truncateToTokenBudget(candidate, tokenBudget, tokenizer);
      candidate = truncated.text;
      metrics = truncated.metrics;
    }
    if (byteBudget !== undefined && jsonEscapedBytes(candidate) > byteBudget) {
      candidate = clipEscapedBytes(candidate, byteBudget);
      metrics = estimateTokens(candidate, tokenizer);
    }
    return { text: candidate, metrics };
  };

  const budgetLabel =
    `${tokenBudget}-token budget` + (byteBudget !== undefined ? ` / ${byteBudget}-byte limit` : "");
  const cannotTruncateNote =
    `Rendered prompt exceeds the ${budgetLabel} but cannot be truncated without cutting ` +
    `the user task, so it is returned over budget (the task is kept verbatim).`;

  /**
   * Hard-truncate the rendered prompt to both budgets, unless that would sever the
   * user's task (then nothing changes). Returns whether the truncation was applied,
   * so callers never report a truncation that did not happen.
   */
  const hardTruncate = (): boolean => {
    const truncated = truncateToBudgets(renderedPrompt);
    if (!truncated.text.includes(originalTask)) return false;
    renderedPrompt = truncated.text;
    contextPackage.tokenMetrics = truncated.metrics;
    return true;
  };

  if (over()) {
    // One predictive pass: drop optional items until their known sizes cover the
    // excess (sizes exclude per-item headings, so this under-drops rather than
    // over-drops), then render once. The loop below only mops up the remainder.
    const needTokens = Math.max(0, contextPackage.tokenMetrics.estimatedTokens - tokenBudget);
    const needBytes =
      byteBudget !== undefined ? Math.max(0, jsonEscapedBytes(renderedPrompt) - byteBudget) : 0;
    let savedTokens = 0;
    let savedBytes = 0;
    let droppedAny = false;
    while (savedTokens < needTokens || savedBytes < needBytes) {
      const d = dropOne();
      if (!d) break;
      savedTokens += d.tokens;
      savedBytes += d.bytes;
      droppedAny = true;
    }
    if (droppedAny) renderedPrompt = render();
    while (over() && dropOne()) {
      renderedPrompt = render();
    }

    // Last resort: hard-truncate the rendered string while ensuring the user task is preserved verbatim.
    if (over()) {
      const applied = hardTruncate();
      contextPackage.knownLimitations.push(
        applied
          ? `Rendered prompt exceeded the ${budgetLabel} and was truncated ` +
              `(lowest-priority skills, sources, and rules were omitted first). ` +
              `User task was preserved verbatim.`
          : cannotTruncateNote
      );
    } else if (omissions.length > 0 || sourcesShortened) {
      contextPackage.knownLimitations.push(
        `Context was reduced to fit the ${budgetLabel}; ` +
          `${omissions.length} item(s) omitted (see Omissions section)` +
          (sourcesShortened
            ? "; the best-matching source was shortened (see its line range)."
            : ".")
      );
      renderedPrompt = render();
      if (over()) {
        const applied = hardTruncate();
        contextPackage.knownLimitations.push(
          applied
            ? `Rendered prompt still exceeded the ${budgetLabel} after ` +
                `recording omissions and was truncated.`
            : cannotTruncateNote
        );
      }
    }
  }

  // Final refresh pass: the metrics footer reflects measured numbers.
  renderedPrompt = render();
  if (over()) {
    const applied = hardTruncate();
    contextPackage.knownLimitations.push(
      applied
        ? `Rendered prompt exceeded the ${budgetLabel} on the final ` +
            `metrics refresh and was truncated.`
        : cannotTruncateNote
    );
  }

  return { contextPackage, renderedPrompt };
}
