import { describe, it, expect } from "vitest";
import { classifyTask } from "../core/classifier";
import { estimateTokens, truncateToTokenBudget } from "../core/tokenCounter";
import { TASK_TEMPLATES } from "../core/templates";
import { selectRelevantSkills, BUILTIN_SKILLS, formatSkillContent } from "../core/skills";

describe("Phase 1: Token Counting & Estimation", () => {
  it("distinguishes estimated token counts and reports true for isEstimate", () => {
    const text =
      "function calculateTotal(price: number, tax: number): number { return price * (1 + tax); }";
    const metrics = estimateTokens(text);

    expect(metrics.characterCount).toBe(text.length);
    expect(metrics.byteCount).toBeGreaterThanOrEqual(text.length);
    expect(metrics.estimatedTokens).toBeGreaterThan(0);
    expect(metrics.isEstimate).toBe(true);
    expect(metrics.measuredTokens).toBeUndefined();
  });

  it("handles empty strings gracefully", () => {
    const metrics = estimateTokens("");
    expect(metrics.characterCount).toBe(0);
    expect(metrics.byteCount).toBe(0);
    expect(metrics.estimatedTokens).toBe(0);
    expect(metrics.isEstimate).toBe(true);
  });

  it("accurately bounds text within token budget using truncateToTokenBudget", () => {
    const longText = 'console.log("Hello world");\n'.repeat(100);
    const initialTokens = estimateTokens(longText).estimatedTokens;
    expect(initialTokens).toBeGreaterThan(200);

    const { text, wasTruncated, metrics } = truncateToTokenBudget(longText, 50);
    expect(wasTruncated).toBe(true);
    expect(metrics.estimatedTokens).toBeLessThanOrEqual(50);
    expect(text.length).toBeLessThan(longText.length);
  });
});

describe("Phase 2: Deterministic Task Classification", () => {
  it("classifies explain tasks correctly", () => {
    const res = classifyTask("Explain how PtyManager handles child processes");
    expect(res.category).toBe("explain");
    expect(res.confidence).toBeGreaterThan(0.5);
    expect(res.isOverridden).toBe(false);
  });

  it("classifies implement tasks correctly", () => {
    const res = classifyTask("Implement a new health check endpoint in server");
    expect(res.category).toBe("implement");
    expect(res.confidence).toBeGreaterThan(0.5);
  });

  it("classifies debug tasks correctly", () => {
    const res = classifyTask("Fix bug causing panic on resize with zero rows");
    expect(res.category).toBe("debug");
    expect(res.confidence).toBeGreaterThan(0.5);
  });

  it("classifies refactor tasks correctly", () => {
    const res = classifyTask("Refactor the git cache to use LRU eviction");
    expect(res.category).toBe("refactor");
    expect(res.confidence).toBeGreaterThan(0.5);
  });

  it("classifies test tasks correctly", () => {
    const res = classifyTask("Write unit tests for paneLayout split fraction");
    expect(res.category).toBe("test");
    expect(res.confidence).toBeGreaterThan(0.5);
  });

  it("classifies review tasks correctly", () => {
    const res = classifyTask("Review this PR for security vulnerabilities");
    expect(res.category).toBe("review");
    expect(res.confidence).toBeGreaterThan(0.5);
  });

  it("classifies architecture tasks correctly", () => {
    const res = classifyTask("Describe the high-level architecture and IPC boundary");
    expect(res.category).toBe("architecture");
    expect(res.confidence).toBeGreaterThan(0.5);
  });

  it("classifies documentation tasks correctly", () => {
    const res = classifyTask("Update the README documentation with setup steps");
    expect(res.category).toBe("documentation");
    expect(res.confidence).toBeGreaterThan(0.5);
  });

  it("handles ambiguous queries safely as unknown with safe general strategy", () => {
    const res = classifyTask("Random string of characters 12345 xyz");
    expect(res.category).toBe("unknown");
    expect(res.confidence).toBeLessThanOrEqual(0.3);
  });

  it("allows explicit caller override of task classification", () => {
    const res = classifyTask("Write a test for something", "architecture");
    expect(res.category).toBe("architecture");
    expect(res.confidence).toBe(1.0);
    expect(res.isOverridden).toBe(true);
  });
});

describe("Phase 4: Prompt Templates & User Intent Preservation", () => {
  it("preserves the original user task verbatim across all category templates", () => {
    const sampleTask = "Implement critical security patch: DO NOT REMOVE THIS INSTRUCTION";
    const categories = Object.keys(TASK_TEMPLATES) as Array<keyof typeof TASK_TEMPLATES>;

    for (const cat of categories) {
      const template = TASK_TEMPLATES[cat];
      const pkg = {
        originalTask: sampleTask,
        classification: {
          category: cat,
          confidence: 0.9,
          reason: "Test reason",
          isOverridden: false,
          detectedKeywords: [],
        },
        projectMeta: {
          id: "test-id",
          name: "test-project",
          canonicalPath: "/test/path",
          indexFreshness: "fresh" as const,
          lastIndexedAt: new Date().toISOString(),
        },
        applicableRules: [],
        sourceReferences: [],
        symbols: [],
        dependencies: [],
        selectedSkills: [],
        knownLimitations: [],
        omissions: [],
        tokenMetrics: { characterCount: 10, byteCount: 10, estimatedTokens: 3, isEstimate: true },
        assembledAt: new Date().toISOString(),
      };

      const prompt = template.renderPrompt(pkg);
      expect(prompt).toContain(sampleTask);
      expect(prompt).toContain(cat);
      expect(prompt).toContain("Template Version: 1.0.0");
    }
  });
});

describe("Phase 5: On-Demand Skill Registry", () => {
  it("selects skills only when relevant to category, language, and keywords", () => {
    const matches = selectRelevantSkills(
      BUILTIN_SKILLS,
      "test",
      ["typescript"],
      ["vitest", "unit", "test"]
    );

    expect(matches.length).toBeGreaterThan(0);
    const vitestSkill = matches.find((m) => m.skill.id === "vitest-testing-patterns");
    expect(vitestSkill).toBeDefined();
  });

  it("enforces size bounds and non-execution on skill content", () => {
    const skill = BUILTIN_SKILLS[0];
    const formatted = formatSkillContent(skill);
    expect(typeof formatted).toBe("string");
    expect(formatted.length).toBeGreaterThan(0);
    expect(formatted).not.toContain("<script>");
  });
});
