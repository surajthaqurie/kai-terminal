import { describe, it, expect } from "vitest";
import { estimateTokens, truncateToTokenBudget } from "../core/tokenCounter";

/**
 * Guard rails for the character-class token HEURISTIC on representative text.
 * These pin determinism, labelling and sane bounds only. They deliberately make
 * no claim about accuracy: no real tokenizer is available in this repo to measure
 * against, so how close the numbers are to any model's count is unknown.
 */
const FIXTURES: Record<string, string> = {
  typescript: [
    "export async function loadThing(id: string, opts: { retries: number }): Promise<Thing> {",
    "  const response = await fetch(`/api/things/${id}`, { method: 'GET' });",
    "  if (!response.ok) throw new Error(`failed: ${response.status}`);",
    "  return (await response.json()) as Thing;",
    "}",
  ].join("\n"),
  rust: [
    "pub fn parse<'a>(input: &'a str) -> Result<Vec<&'a str>, ParseError> {",
    '    let parts: Vec<&str> = input.split("::").collect();',
    "    if parts.is_empty() { return Err(ParseError::Empty); }",
    "    Ok(parts)",
    "}",
  ].join("\n"),
  markdown:
    "# Title\n\nKai indexes your project **locally**. It never calls a model, so any token figure is an *estimate*.\n\n- one\n- two\n",
  json: JSON.stringify({
    name: "kai",
    items: Array.from({ length: 12 }, (_, i) => ({ id: i, tag: `t${i}` })),
  }),
  minified: "function a(b){return b.map(function(c){return c*2}).filter(Boolean)}".repeat(20),
  indentation: ("    ".repeat(12) + "x\n").repeat(10),
  unicode: "日本語のテキスト 😀😀😀 ünïcödé — “quotes” ✓ naïve café",
  longIdentifier: "a".repeat(400),
  singleChar: "x",
};

describe("token heuristic on representative fixtures", () => {
  for (const [name, text] of Object.entries(FIXTURES)) {
    it(`${name}: deterministic, labelled as an estimate, and within sane bounds`, () => {
      const a = estimateTokens(text);
      const b = estimateTokens(text);
      expect(b).toEqual(a);
      expect(a.isEstimate).toBe(true);
      expect(a.measuredTokens).toBeUndefined();
      expect(a.characterCount).toBe(text.length);
      expect(a.byteCount).toBe(Buffer.byteLength(text, "utf8"));
      // Never zero for text, never more tokens than bytes, never absurdly few for its size.
      expect(a.estimatedTokens).toBeGreaterThanOrEqual(1);
      expect(a.estimatedTokens).toBeLessThanOrEqual(a.byteCount);
      expect(a.estimatedTokens).toBeGreaterThanOrEqual(Math.ceil(text.length / 12));
    });

    it(`${name}: truncation honours every budget it is given`, () => {
      const full = estimateTokens(text).estimatedTokens;
      for (const budget of [1, 3, 10, Math.ceil(full / 2), full, full + 50]) {
        const cut = truncateToTokenBudget(text, budget);
        expect(cut.metrics.estimatedTokens).toBeLessThanOrEqual(budget);
        expect(text.startsWith(cut.text)).toBe(true);
        expect(cut.metrics.isEstimate).toBe(true);
        if (budget >= full) expect(cut.text).toBe(text);
      }
    });
  }

  it("treats empty text as zero without claiming precision", () => {
    expect(estimateTokens("")).toMatchObject({ estimatedTokens: 0, isEstimate: true });
  });

  it("grows with more text of the same kind", () => {
    const one = estimateTokens(FIXTURES.typescript).estimatedTokens;
    const three = estimateTokens(
      [FIXTURES.typescript, FIXTURES.typescript, FIXTURES.typescript].join("\n")
    ).estimatedTokens;
    expect(three).toBeGreaterThan(one * 2);
    expect(three).toBeLessThanOrEqual(one * 3 + 3);
  });
});
