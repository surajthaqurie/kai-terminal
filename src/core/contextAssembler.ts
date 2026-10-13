import crypto from "crypto";
import type { ProjectIndex, RetrievalOptions, ContextPackage, ContextOmission } from "./types";
import { classifyTask } from "./classifier";
import { retrieveContext } from "./retrieval";
import { selectRelevantSkills, formatSkillContent, BUILTIN_SKILLS } from "./skills";
import { TASK_TEMPLATES } from "./templates";
import { estimateTokens, truncateToTokenBudget } from "./tokenCounter";
import { detectStaleIndexEntries } from "./indexer";

export function assembleContext(
  index: ProjectIndex,
  options: RetrievalOptions
): { contextPackage: ContextPackage; renderedPrompt: string } {
  const originalTask = options.task;
  // Single source of truth for budget bounds (mirrors MCP/retrieval clamps).
  const tokenBudget = Math.min(
    Math.max(
      Number.isFinite(options.tokenBudget ?? 4000) ? Math.floor(options.tokenBudget ?? 4000) : 4000,
      200
    ),
    20000
  );
  // Deterministic timestamp if provided by caller/options, else current ISO time
  const assembledAt = options.assembledAt ?? new Date().toISOString();
  const tokenizer = options.tokenizer;

  // 1. Task classification
  const classification = classifyTask(originalTask, options.categoryOverride);

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

  const stalenessCheck = detectStaleIndexEntries(index);
  if (stalenessCheck.isStale) {
    indexFreshness = "stale";
  }

  // 3. Project rules & constraints (with duplicate removal)
  const applicableRules: Array<{ source: string; content: string }> = [];
  const omissions: ContextOmission[] = [];
  const seenRuleHashes = new Set<string>();
  let remainingBudget = tokenBudget - 500; // Reserve for task, guidelines, and metadata

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
    tokenBudget: Math.max(800, remainingBudget),
    fileBudget: options.fileBudget ?? 6,
    includeTests:
      options.includeTests ??
      (classification.category === "test" || classification.category === "debug"),
    tokenizer,
  });

  const sourceReferences = retrieval.matchedFiles.map((m) => ({
    relativePath: m.file.relativePath,
    startLine: m.startLine,
    endLine: m.endLine,
    relevanceScore: m.score,
    content: m.snippet || "",
  }));

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
    tokenMetrics: {
      characterCount: 0,
      byteCount: 0,
      estimatedTokens: 0,
      isEstimate: !tokenizer,
      measuredTokens: tokenizer ? 0 : undefined,
    },
    assembledAt,
  };

  // Render via prompt template, then enforce the token budget as a hard guarantee.
  const template = TASK_TEMPLATES[classification.category] || TASK_TEMPLATES.unknown;
  const render = (): string => {
    const text = template.renderPrompt(contextPackage);
    contextPackage.tokenMetrics = estimateTokens(text, tokenizer);
    return text;
  };

  let renderedPrompt = render();

  if (contextPackage.tokenMetrics.estimatedTokens > tokenBudget) {
    // 1. Drop advisory skills first.
    while (
      contextPackage.tokenMetrics.estimatedTokens > tokenBudget &&
      contextPackage.selectedSkills.length > 0
    ) {
      const dropped = contextPackage.selectedSkills.pop()!;
      omissions.push({
        type: "skill",
        identifier: dropped.id,
        reason: "budget_exceeded",
        estimatedTokens: estimateTokens(dropped.content, tokenizer).estimatedTokens,
      });
      renderedPrompt = render();
    }

    // 2. Drop lowest-scored source references (array is relevance-ordered).
    while (
      contextPackage.tokenMetrics.estimatedTokens > tokenBudget &&
      contextPackage.sourceReferences.length > 0
    ) {
      const dropped = contextPackage.sourceReferences.pop()!;
      omissions.push({
        type: "file",
        identifier: dropped.relativePath,
        reason: "budget_exceeded",
        estimatedTokens: Math.max(1, estimateTokens(dropped.content, tokenizer).estimatedTokens),
      });
      renderedPrompt = render();
    }

    // 3. Drop project rules last (they constrain generation).
    while (
      contextPackage.tokenMetrics.estimatedTokens > tokenBudget &&
      contextPackage.applicableRules.length > 0
    ) {
      const dropped = contextPackage.applicableRules.pop()!;
      omissions.push({
        type: "rule",
        identifier: dropped.source,
        reason: "budget_exceeded",
        estimatedTokens: estimateTokens(dropped.content, tokenizer).estimatedTokens,
      });
      renderedPrompt = render();
    }

    // 4. Last resort: hard-truncate the rendered string while ensuring the user task is preserved verbatim.
    if (contextPackage.tokenMetrics.estimatedTokens > tokenBudget) {
      const truncated = truncateToTokenBudget(renderedPrompt, tokenBudget, tokenizer);
      // Ensure the user's task was not severed by extreme budget truncation
      if (truncated.text.includes(originalTask)) {
        renderedPrompt = truncated.text;
        contextPackage.tokenMetrics = truncated.metrics;
      }
      contextPackage.knownLimitations.push(
        `Rendered prompt exceeded the ${tokenBudget}-token budget and was truncated ` +
          `(lowest-priority skills, sources, and rules were omitted first). ` +
          `User task was preserved verbatim.`
      );
    } else if (omissions.length > 0) {
      contextPackage.knownLimitations.push(
        `Context was reduced to fit the ${tokenBudget}-token budget; ` +
          `${omissions.length} item(s) omitted (see Omissions section).`
      );
      renderedPrompt = render();
      if (contextPackage.tokenMetrics.estimatedTokens > tokenBudget) {
        const truncated = truncateToTokenBudget(renderedPrompt, tokenBudget, tokenizer);
        if (truncated.text.includes(originalTask)) {
          renderedPrompt = truncated.text;
          contextPackage.tokenMetrics = truncated.metrics;
        }
        contextPackage.knownLimitations.push(
          `Rendered prompt still exceeded the ${tokenBudget}-token budget after ` +
            `recording omissions and was truncated.`
        );
      }
    }
  }

  // Final refresh pass: the metrics footer reflects measured numbers.
  renderedPrompt = render();
  if (contextPackage.tokenMetrics.estimatedTokens > tokenBudget) {
    const truncated = truncateToTokenBudget(renderedPrompt, tokenBudget, tokenizer);
    if (truncated.text.includes(originalTask)) {
      renderedPrompt = truncated.text;
      contextPackage.tokenMetrics = truncated.metrics;
    }
    contextPackage.knownLimitations.push(
      `Rendered prompt exceeded the ${tokenBudget}-token budget on the final ` +
        `metrics refresh and was truncated.`
    );
  }

  return { contextPackage, renderedPrompt };
}
