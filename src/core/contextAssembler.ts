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
  const assembledAt = new Date().toISOString();

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

  // 3. Project rules & constraints
  const applicableRules: Array<{ source: string; content: string }> = [];
  const omissions: ContextOmission[] = [];
  let remainingBudget = tokenBudget - 500; // Reserve for task, guidelines, and metadata

  for (const rawRule of index.rules) {
    const match = rawRule.match(/^\[Rule File:\s*([^\]]+)\]\n([\s\S]*)$/);
    const source = match ? match[1] : "project-rules";
    const content = match ? match[2] : rawRule;

    const ruleTokens = estimateTokens(content).estimatedTokens;
    if (ruleTokens <= 600 && remainingBudget >= ruleTokens) {
      applicableRules.push({ source, content });
      remainingBudget -= ruleTokens;
    } else if (remainingBudget > 200) {
      const truncated = truncateToTokenBudget(content, 200);
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
      const skillTokens = estimateTokens(formatted).estimatedTokens;
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
      isEstimate: true,
    },
    assembledAt,
  };

  // Render via prompt template, then enforce the token budget as a hard
  // guarantee. Component budgets above are advisory: template headers,
  // guidelines, and the metrics footer all consume tokens outside the
  // retrieval slice, so the final string can exceed tokenBudget. Enforcement
  // drops lowest-priority content first (skills, then lowest-scored sources,
  // then rules) and re-renders; only as a last resort is the rendered string
  // itself truncated. The user task section leads the template, so tail
  // truncation never corrupts the preserved task.
  const template = TASK_TEMPLATES[classification.category] || TASK_TEMPLATES.unknown;
  const render = (): string => {
    const text = template.renderPrompt(contextPackage);
    contextPackage.tokenMetrics = estimateTokens(text);
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
        estimatedTokens: estimateTokens(dropped.content).estimatedTokens,
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
        estimatedTokens: Math.max(1, estimateTokens(dropped.content).estimatedTokens),
      });
      // Re-render so the omissions section reflects the new drops.
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
        estimatedTokens: estimateTokens(dropped.content).estimatedTokens,
      });
      renderedPrompt = render();
    }

    // 4. Last resort: hard-truncate the rendered string. The task section
    // leads the template, so this preserves the verbatim task and cuts the
    // tail (metrics footer). Record the truncation where it survives.
    if (contextPackage.tokenMetrics.estimatedTokens > tokenBudget) {
      const truncated = truncateToTokenBudget(renderedPrompt, tokenBudget);
      renderedPrompt = truncated.text;
      contextPackage.tokenMetrics = truncated.metrics;
      contextPackage.knownLimitations.push(
        `Rendered prompt exceeded the ${tokenBudget}-token budget and was truncated ` +
          `(lowest-priority skills, sources, and rules were omitted first). ` +
          `Consider raising the budget or narrowing the task.`
      );
    } else if (omissions.length > 0) {
      contextPackage.knownLimitations.push(
        `Context was reduced to fit the ${tokenBudget}-token budget; ` +
          `${omissions.length} item(s) omitted (see Omissions section).`
      );
      renderedPrompt = render();
      // Rendering the new limitation may itself exceed the budget; if so,
      // hard-truncate (task section is leading, so it survives). The note
      // below lives in the structured package even though it is cut from
      // the rendered text.
      if (contextPackage.tokenMetrics.estimatedTokens > tokenBudget) {
        const truncated = truncateToTokenBudget(renderedPrompt, tokenBudget);
        renderedPrompt = truncated.text;
        contextPackage.tokenMetrics = truncated.metrics;
        contextPackage.knownLimitations.push(
          `Rendered prompt still exceeded the ${tokenBudget}-token budget after ` +
            `recording omissions and was truncated.`
        );
      }
    }
  }

  // Final refresh pass: the metrics footer embedded above reflects the
  // previous render's numbers (initially zeros). Re-render so the footer
  // shows measured values, then re-verify the hard budget guarantee —
  // only the footer's digits changed, so any overflow is a few tokens
  // at most and truncation cuts the footer tail, never the leading task.
  renderedPrompt = render();
  if (contextPackage.tokenMetrics.estimatedTokens > tokenBudget) {
    const truncated = truncateToTokenBudget(renderedPrompt, tokenBudget);
    renderedPrompt = truncated.text;
    contextPackage.tokenMetrics = truncated.metrics;
    contextPackage.knownLimitations.push(
      `Rendered prompt exceeded the ${tokenBudget}-token budget on the final ` +
        `metrics refresh and was truncated.`
    );
  }

  return { contextPackage, renderedPrompt };
}
