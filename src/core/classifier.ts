import type { TaskCategory, ClassificationResult } from "./types";

interface CategoryRule {
  category: TaskCategory;
  patterns: RegExp[];
  keywords: string[];
  weight: number;
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: "test",
    patterns: [
      /\b(?:write|add|generate|run|fix|improve)\s+(?:unit\s+)?tests?\b/i,
      /\b(?:vitest|jest|cargo\s+test|pytest|test\s+coverage|test\s+suite)\b/i,
      /\bassert(?:ions?)?\b/i,
      /\bmock(?:ing|s)?\b/i,
    ],
    keywords: ["test", "tests", "testing", "spec", "assert", "vitest", "jest", "coverage", "mock"],
    weight: 1.0,
  },
  {
    category: "debug",
    patterns: [
      /\b(?:fix|debug|troubleshoot|resolve)\s+(?:the\s+)?(?:bug|error|issue|crash|failure|exception|panic)\b/i,
      /\bwhy\s+(?:is|does)\s+.*\s+(?:failing|crashing|broken|returning\s+null|erroring)\b/i,
      /\bstack\s*trace\b/i,
      /\b(?:error|exception|panic|segfault|cannot\s+read\s+properties)\b/i,
    ],
    keywords: [
      "bug",
      "debug",
      "error",
      "issue",
      "fix",
      "crash",
      "fail",
      "failure",
      "broken",
      "panic",
      "exception",
    ],
    weight: 1.0,
  },
  {
    category: "refactor",
    patterns: [
      /\b(?:refactor|clean\s+up|restructure|modularize|deduplicate|extract\s+method|extract\s+class)\b/i,
      /\bsimplify\s+(?:the\s+)?(?:code|logic|function|class|module)\b/i,
      /\brename\s+symbol\b/i,
    ],
    keywords: [
      "refactor",
      "cleanup",
      "clean up",
      "restructure",
      "modularize",
      "deduplicate",
      "simplify",
    ],
    weight: 0.95,
  },
  {
    category: "documentation",
    patterns: [
      /\b(?:document|write\s+docs?|update\s+readme|add\s+docstrings?|api\s+docs?)\b/i,
      /\bexplain\s+in\s+readme\b/i,
      /\bdocumentation\b/i,
    ],
    keywords: ["doc", "docs", "documentation", "readme", "docstring", "jsdoc", "guide", "manual"],
    weight: 0.9,
  },
  {
    category: "review",
    patterns: [
      /\b(?:review|audit|critique|inspect)\s+(?:this\s+)?(?:code|pr|pull\s+request|diff|changes?)\b/i,
      /\bsecurity\s+review\b/i,
      /\bcode\s+smells?\b/i,
    ],
    keywords: ["review", "audit", "code review", "inspect", "critique", "pr", "pull request"],
    weight: 0.9,
  },
  {
    category: "architecture",
    patterns: [
      /\b(?:architecture|system\s+design|high-level|subsystem|module\s+structure|data\s+flow)\b/i,
      /\bhow\s+is\s+the\s+project\s+structured\b/i,
      /\bcomponents?\s+diagram\b/i,
    ],
    keywords: [
      "architecture",
      "design",
      "structure",
      "subsystem",
      "component",
      "layer",
      "ipc boundary",
      "data flow",
    ],
    weight: 0.85,
  },
  {
    category: "explain",
    patterns: [
      /\b(?:explain|clarify|describe|summarize)\b/i,
      /\b(?:how\s+does|walk\s+through|what\s+does)\b/i,
      /\bhelp\s+me\s+understand\b/i,
      /\boverview\s+of\b/i,
    ],
    keywords: [
      "explain",
      "understand",
      "walkthrough",
      "how does",
      "what does",
      "overview",
      "summary",
      "describe",
      "lifecycle",
    ],
    weight: 0.9,
  },
  {
    category: "implement",
    patterns: [
      /\b(?:implement|create|add|build|introduce|develop)\b/i,
      /\bwrite\s+(?:a\s+|new\s+)?(?:function|class|handler|method|service)\b/i,
    ],
    keywords: ["implement", "add", "create", "build", "new feature", "develop", "introduce"],
    weight: 0.85,
  },
];

export function classifyTask(task: string, explicitOverride?: TaskCategory): ClassificationResult {
  if (explicitOverride && explicitOverride !== "unknown") {
    return {
      category: explicitOverride,
      confidence: 1.0,
      reason: `Explicitly overridden by caller to "${explicitOverride}"`,
      isOverridden: true,
      detectedKeywords: [],
    };
  }

  const trimmed = task.trim().slice(0, 4000);
  if (!trimmed) {
    return {
      category: "unknown",
      confidence: 0.0,
      reason: "Empty task provided",
      isOverridden: false,
      detectedKeywords: [],
    };
  }

  const lower = trimmed.toLowerCase();
  let bestCategory: TaskCategory = "unknown";
  let bestScore = 0;
  let bestReason =
    "No strong category match detected; safe general-purpose retrieval strategy applied";
  const matchedKeywords: string[] = [];

  for (const rule of CATEGORY_RULES) {
    let score = 0;
    const ruleKeywordsFound: string[] = [];

    // Pattern matching (high confidence)
    for (const pattern of rule.patterns) {
      if (pattern.test(trimmed)) {
        score += 0.5 * rule.weight;
      }
    }

    // Keyword matching
    for (const kw of rule.keywords) {
      const kwRegex = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (kwRegex.test(lower)) {
        score += 0.2 * rule.weight;
        ruleKeywordsFound.push(kw);
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestCategory = rule.category;
      matchedKeywords.length = 0;
      matchedKeywords.push(...ruleKeywordsFound);
      bestReason = `Matched patterns and keywords for [${rule.category}]: ${ruleKeywordsFound.join(", ") || "regex pattern"}`;
    }
  }

  // Normalize confidence between 0.0 and 0.95
  const confidence = Math.min(0.95, Math.round(bestScore * 100) / 100);

  if (bestScore < 0.25) {
    return {
      category: "unknown",
      confidence: Math.max(0.1, confidence),
      reason: "Uncertain match; using general-purpose retrieval strategy",
      isOverridden: false,
      detectedKeywords: matchedKeywords,
    };
  }

  return {
    category: bestCategory,
    confidence,
    reason: bestReason,
    isOverridden: false,
    detectedKeywords: matchedKeywords,
  };
}
