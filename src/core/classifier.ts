import type { TaskCategory, ClassificationResult } from "./types";

interface CategoryRule {
  category: TaskCategory;
  patterns: RegExp[];
  keywords: string[];
  weight: number;
  priority: number; // Higher priority breaks ties among overlapping intents
}

const CATEGORY_RULES: CategoryRule[] = [
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
    priority: 8,
  },
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
    priority: 7,
  },
  {
    category: "refactor",
    patterns: [
      /\b(?:refactor|clean\s+up|restructure|modularize|deduplicate|extract\s+method|extract\s+class)\b/i,
      /\bsimplify\s+(?:the\s+)?(?:code|logic|function|class|module)\b/i,
      /\brename\s+symbol\b/i,
      /\brename\s+[\w.$]+\s+(?:to|into|as)\s+\w/i,
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
    priority: 6,
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
    priority: 5,
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
    priority: 4,
  },
  {
    category: "implement",
    patterns: [
      /\b(?:implement|create|add|build|introduce|develop)\b/i,
      /\bwrite\s+(?:a\s+|new\s+)?(?:function|class|handler|method|service)\b/i,
    ],
    keywords: ["implement", "add", "create", "build", "new feature", "develop", "introduce"],
    weight: 0.85,
    priority: 3,
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
    priority: 2,
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
    priority: 1,
  },
];

export interface TaskIntentHints {
  prefersTests: boolean;
  prefersConfig: boolean;
  prefersDocs: boolean;
}

export interface ExtractedSearchTokens {
  tokens: string[];
  exactTerms: string[];
  intentHints: TaskIntentHints;
}

// Keyword regexes are fixed at module scope (bounded by CATEGORY_RULES), so
// compile each once instead of rebuilding ~70 RegExp objects per
// classifyTask() call. No /g flag: shared instances stay stateless.
const keywordRegexCache = new Map<string, RegExp>();

function keywordRegex(kw: string): RegExp {
  let re = keywordRegexCache.get(kw);
  if (!re) {
    re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    keywordRegexCache.set(kw, re);
  }
  return re;
}

/**
 * Extracts normalized query tokens, decomposing camelCase, snake_case, and file paths.
 */
export function extractSearchTokens(query: string): ExtractedSearchTokens {
  const safeQuery = (query || "").slice(0, 4000);
  const rawWords = safeQuery.match(/[A-Za-z0-9_.\-\\/]+/g) || [];
  const words: string[] = [];
  for (const rw of rawWords) {
    if (rw.includes(".") && !rw.startsWith(".")) {
      words.push(rw);
      for (const dp of rw.split(".")) {
        if (dp) words.push(dp);
      }
    } else {
      words.push(rw);
    }
  }

  const tokenSet = new Set<string>();
  const exactTermSet = new Set<string>();

  for (const rawWord of words) {
    const clean = rawWord.replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, "");
    if (!clean) continue;

    const lower = clean.toLowerCase();
    if (lower.length >= 1) {
      tokenSet.add(lower);
      exactTermSet.add(lower);
    }

    // Decompose camelCase (e.g. PtyManager -> pty, manager)
    const camelParts = clean.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/);
    if (camelParts.length > 1) {
      for (const part of camelParts) {
        const pLower = part.toLowerCase();
        if (pLower.length >= 1) tokenSet.add(pLower);
      }
    }

    // Decompose snake_case or kebab-case (e.g. create_pty -> create, pty)
    const splitParts = clean.split(/[_\-]+/);
    if (splitParts.length > 1) {
      for (const part of splitParts) {
        const pLower = part.toLowerCase();
        if (pLower.length >= 1) tokenSet.add(pLower);
      }
    }
  }

  const intentHints: TaskIntentHints = {
    prefersTests: /\b(?:test|tests|spec|coverage|vitest|jest|cargo\s+test|pytest)\b/i.test(
      safeQuery
    ),
    prefersConfig:
      /\b(?:config|configuration|settings|tsconfig|package\.json|cargo\.toml|options|env)\b/i.test(
        safeQuery
      ),
    prefersDocs: /\b(?:doc|docs|documentation|readme|guide|manual)\b/i.test(safeQuery),
  };

  return {
    tokens: Array.from(tokenSet),
    exactTerms: Array.from(exactTermSet),
    intentHints,
  };
}

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

  const trimmed = (task || "").trim().slice(0, 4000);
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
  let bestPriority = 0;
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
      const kwRegex = keywordRegex(kw);
      if (kwRegex.test(lower)) {
        score += 0.2 * rule.weight;
        ruleKeywordsFound.push(kw);
      }
    }

    // Tie-breaker: prefer higher action specificity (priority) when scores are close
    const isHigherScore = score > bestScore;
    const isCloseTieWithHigherPriority =
      Math.abs(score - bestScore) < 0.15 && score > 0.3 && rule.priority > bestPriority;

    if (isHigherScore || isCloseTieWithHigherPriority) {
      bestScore = score;
      bestPriority = rule.priority;
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
