import type { TokenMetrics } from "./types";

/**
 * Deterministic token estimation distinguishing measured counts from estimates.
 * Follows standard cl100k / BPE code heuristics (~3.8 chars per token for mixed code and text).
 */
export function estimateTokens(text: string): TokenMetrics {
  if (!text) {
    return {
      characterCount: 0,
      byteCount: 0,
      estimatedTokens: 0,
      isEstimate: true,
    };
  }

  const characterCount = text.length;
  const byteCount = Buffer.byteLength(text, "utf-8");

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
  maxTokens: number
): { text: string; wasTruncated: boolean; metrics: TokenMetrics } {
  const initial = estimateTokens(text);
  if (initial.estimatedTokens <= maxTokens) {
    return { text, wasTruncated: false, metrics: initial };
  }

  // Binary search for slice boundary that fits within budget
  let low = 0;
  let high = text.length;
  let best = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid);
    const candidateTokens = estimateTokens(candidate).estimatedTokens;

    if (candidateTokens <= maxTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const truncated = text.slice(0, best);
  const metrics = estimateTokens(truncated);
  return {
    text: truncated,
    wasTruncated: true,
    metrics,
  };
}
