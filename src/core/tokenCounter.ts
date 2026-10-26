import type { TokenMetrics } from "./types";

export type TokenizerFunction = (text: string) => number;

let globalCustomTokenizer: TokenizerFunction | null = null;

/**
 * Register a global custom tokenizer function (e.g. tiktoken/js-tiktoken or bespoke model tokenizer).
 * When registered, token counts will be exact measurements rather than cl100k estimates.
 */
export function registerCustomTokenizer(fn: TokenizerFunction | null): void {
  globalCustomTokenizer = fn;
}

/**
 * Deterministic token estimation distinguishing measured counts from estimates.
 * Follows standard cl100k / BPE code heuristics (~3.8 chars per token for mixed code and text)
 * unless an optional exact tokenizer is provided.
 */
export function estimateTokens(
  text: string,
  customTokenizer?: TokenizerFunction | null
): TokenMetrics {
  if (!text) {
    const activeTokenizer = customTokenizer ?? globalCustomTokenizer;
    return {
      characterCount: 0,
      byteCount: 0,
      estimatedTokens: 0,
      measuredTokens: activeTokenizer ? 0 : undefined,
      isEstimate: !activeTokenizer,
    };
  }

  const characterCount = text.length;
  const byteCount = Buffer.byteLength(text, "utf-8");
  const activeTokenizer = customTokenizer ?? globalCustomTokenizer;

  if (activeTokenizer) {
    try {
      const measured = activeTokenizer(text);
      // Exact status requires a well-formed whole count: fractional output is
      // malformed and falls back to the labeled heuristic instead of being
      // presented as exact (Number.isInteger also implies finiteness).
      if (typeof measured === "number" && Number.isInteger(measured) && measured >= 0) {
        // Normalize -0 to +0 so serialized counts never carry a signed zero.
        const count = measured === 0 ? 0 : measured;
        return {
          characterCount,
          byteCount,
          estimatedTokens: count,
          measuredTokens: count,
          isEstimate: false,
        };
      }
    } catch {
      // Fallback to heuristic estimate if custom tokenizer encounters an error
    }
  }

  // Token heuristic:
  // Splitting on word boundaries, special symbols, whitespace, and code syntax
  // Average ratio across TypeScript, Rust, and Markdown is ~3.7 to 4.0 characters per token.
  // We use a deterministic token model:
  // Words, numbers, symbols, and whitespace chunks.
  const tokens = text.match(/\w+|[^\w\s]+|\s+/g);
  let estimated = 0;

  if (tokens) {
    for (const chunk of tokens) {
      if (/^\s+$/.test(chunk)) {
        // Repeated spaces/newlines (common in code indentation)
        estimated += Math.ceil(chunk.length / 4);
      } else if (chunk.length > 4) {
        // Longer words or tokens are subword-tokenized
        estimated += Math.ceil(chunk.length / 3.8);
      } else {
        estimated += 1;
      }
    }
  } else {
    estimated = Math.ceil(characterCount / 4);
  }

  return {
    characterCount,
    byteCount,
    estimatedTokens: Math.max(1, estimated),
    isEstimate: true,
  };
}

/**
 * Accurately bounds text to a strict token budget.
 * Returns truncated text and the remaining token metrics.
 */
export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
  customTokenizer?: TokenizerFunction | null
): { text: string; wasTruncated: boolean; metrics: TokenMetrics } {
  const initial = estimateTokens(text, customTokenizer);
  if (initial.estimatedTokens <= maxTokens) {
    return { text, wasTruncated: false, metrics: initial };
  }

  // Fast path: jump straight to a proportional guess, then correct with a
  // bounded number of refinement steps. The old binary search re-scanned the
  // candidate from scratch ~log2(n) times (≈18 full passes for a 260 KB
  // prompt); chars-per-token is stable enough that the guess lands within a
  // few percent, so ~4-6 passes suffice. The trailing guard loop keeps the
  // hard budget guarantee even for adversarial inputs.
  const avgCharsPerToken = Math.max(1, text.length / initial.estimatedTokens);
  let bound = Math.max(0, Math.min(text.length - 1, Math.floor(maxTokens * avgCharsPerToken)));

  for (let i = 0; i < 6; i++) {
    const candidateTokens = estimateTokens(text.slice(0, bound), customTokenizer).estimatedTokens;
    if (candidateTokens <= maxTokens) {
      const remaining = maxTokens - candidateTokens;
      if (remaining < 2 || bound >= text.length) break;
      const grown = Math.min(
        text.length,
        bound + Math.max(1, Math.floor(remaining * avgCharsPerToken))
      );
      if (grown <= bound) break;
      bound = grown;
    } else {
      const shrunk = Math.floor((bound * maxTokens) / candidateTokens);
      bound = Math.max(0, Math.min(bound - 1, shrunk));
    }
  }

  let truncated = text.slice(0, bound);
  let metrics = estimateTokens(truncated, customTokenizer);
  while (metrics.estimatedTokens > maxTokens && bound > 0) {
    bound = Math.max(0, Math.floor(bound * 0.9) - 1);
    truncated = text.slice(0, bound);
    metrics = estimateTokens(truncated, customTokenizer);
  }
  return {
    text: truncated,
    wasTruncated: true,
    metrics,
  };
}
