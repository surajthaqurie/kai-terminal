import type { SkillDefinition, TaskCategory } from "./types";
import { truncateToTokenBudget } from "./tokenCounter";

export const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    id: "typescript-strict-patterns",
    version: "1.0.0",
    name: "TypeScript Strict Patterns",
    description: "Guidelines for strict type annotations, avoiding `any`, and immutability.",
    relevantCategories: ["implement", "refactor", "test", "review"],
    languages: ["typescript"],
    keywords: ["typescript", "ts", "type", "interface", "generic"],
    content: `[Skill: TypeScript Strict Patterns]
- Always provide explicit return types on public functions.
- Avoid 'any'; prefer unknown with type narrowing or generic constraints.
- Prefer readonly arrays and immutability for shared service state.
- Keep domain types decoupled from UI components.`,
    trustClassification: "built-in",
    maxTokens: 300,
  },
  {
    id: "vitest-testing-patterns",
    version: "1.0.0",
    name: "Vitest Unit Testing Patterns",
    description: "Patterns for fast, isolated, deterministic Vitest tests.",
    relevantCategories: ["test", "debug", "review"],
    languages: ["typescript", "javascript"],
    keywords: ["vitest", "test", "spec", "describe", "it", "expect"],
    content: `[Skill: Vitest Testing Patterns]
- Group related test cases under descriptive describe/it blocks.
- Clean up test artifacts and mocks in beforeEach / afterEach.
- Favor parameterized testing (test.each) for edge cases and boundary inputs.
- Keep tests isolated from network and real user filesystem where possible.`,
    trustClassification: "built-in",
    maxTokens: 300,
  },
  {
    id: "security-boundaries-sanitization",
    version: "1.0.0",
    name: "Security Boundaries & Sanitization",
    description: "Path traversal prevention, secret scrubbing, and command isolation.",
    relevantCategories: ["implement", "review", "debug", "architecture"],
    languages: ["typescript", "javascript", "rust", "python"],
    keywords: ["security", "path", "traversal", "secret", "sanitize", "mcp", "ipc", "boundary"],
    content: `[Skill: Security Boundaries & Sanitization]
- Canonicalize all paths with realpathSync and assert project boundary prefix.
- Never execute user/indexed project scripts directly without explicit sandbox.
- Scrub known credentials (.env, tokens, private keys) before logging or IPC serialization.
- Validate all incoming RPC and tool arguments with strict schemas.`,
    trustClassification: "built-in",
    maxTokens: 350,
  },
  {
    id: "rust-safety-idioms",
    version: "1.0.0",
    name: "Rust Safety Idioms",
    description: "Idiomatic error handling, resource guards, and lifetime safety in Rust.",
    relevantCategories: ["implement", "review", "refactor", "debug"],
    languages: ["rust"],
    keywords: ["rust", "cargo", "safety", "unwrap", "result", "mutex", "borrow"],
    content: `[Skill: Rust Safety Idioms]
- Avoid unwrap()/expect() in production paths; prefer Result and ? operator.
- Guard against poisoned locks and handle Mutex poison gracefully.
- Validate IO bounds and paths before syscalls or child process spawning.
- Keep unsafe blocks minimized, thoroughly audited, and accompanied by safety comments.`,
    trustClassification: "built-in",
    maxTokens: 300,
  },
  {
    id: "clean-refactoring-invariants",
    version: "1.0.0",
    name: "Clean Refactoring Invariants",
    description: "Preserving behavioral invariants, public contracts, and incremental migration.",
    relevantCategories: ["refactor", "architecture", "review"],
    languages: ["typescript", "javascript", "rust", "python"],
    keywords: ["refactor", "cleanup", "architecture", "invariant", "contract", "modularize"],
    content: `[Skill: Clean Refactoring Invariants]
- Verify existing tests pass before and after each refactoring transformation.
- Keep public APIs and serialization formats backward compatible.
- Separate architectural reorganization from behavioral alterations.
- Extract interfaces at natural domain boundaries without speculative abstractions.`,
    trustClassification: "built-in",
    maxTokens: 300,
  },
];

export interface SkillMatchResult {
  skill: SkillDefinition;
  reason: string;
  score: number;
}

/**
 * Deterministically match relevant skills based on category, detected language, and query keywords
 */
export function selectRelevantSkills(
  skills: SkillDefinition[],
  category: TaskCategory,
  languages: string[],
  keywords: string[],
  maxSkillsCount: number = 2
): SkillMatchResult[] {
  const matches: SkillMatchResult[] = [];
  const seenSkillIds = new Set<string>();

  for (const skill of skills) {
    if (seenSkillIds.has(skill.id)) continue;

    let score = 0;
    const reasons: string[] = [];

    // Category match
    if (skill.relevantCategories.includes(category)) {
      score += 0.4;
      reasons.push(`matches task category [${category}]`);
    }

    // Language match
    const langMatch = skill.languages.some((l) => languages.includes(l));
    if (langMatch) {
      score += 0.3;
      reasons.push(`matches project language`);
    }

    // Keyword match
    const matchedKws = skill.keywords.filter((k) =>
      keywords.some(
        (q) =>
          q.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(q.toLowerCase())
      )
    );
    if (matchedKws.length > 0) {
      score += 0.3 * Math.min(matchedKws.length, 3);
      reasons.push(`matches keywords (${matchedKws.join(", ")})`);
    }

    if (score >= 0.5) {
      seenSkillIds.add(skill.id);
      matches.push({
        skill,
        reason: reasons.join("; "),
        score,
      });
    }
  }

  // Deterministic sort: highest relevance score, then lexicographical ID tie-breaker
  matches.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));

  return matches.slice(0, maxSkillsCount);
}

/**
 * Format and safely bound skill content
 */
export function formatSkillContent(skill: SkillDefinition): string {
  const { text } = truncateToTokenBudget(skill.content, skill.maxTokens);
  return text;
}
