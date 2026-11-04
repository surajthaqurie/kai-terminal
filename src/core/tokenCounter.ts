import type { TokenMetrics } from "./types";

export type TokenizerFunction = (text: string) => number;

let globalCustomTokenizer: TokenizerFunction | null = null;
const modelTokenizers: Map<string, TokenizerFunction> = new Map();

/**
 * Register a global custom tokenizer function (e.g. tiktoken/js-tiktoken or bespoke model tokenizer).
 * When registered, token counts are that tokenizer's counts (`isEstimate: false`) rather than the
 * built-in heuristic. This global one applies whatever the model; per-model counts for OpenAI-family
 * models come from the bundled BPE vocabularies below, and every other model uses this or the heuristic.
 */
export function registerCustomTokenizer(fn: TokenizerFunction | null): void {
  globalCustomTokenizer = fn;
}

/**
 * Register an adapter tokenizer for a specific model family (e.g. "gpt-4o", "claude-3-5-sonnet").
 */
export function registerModelTokenizer(modelName: string, fn: TokenizerFunction | null): void {
  const norm = modelName.trim().toLowerCase();
  if (!fn) {
    modelTokenizers.delete(norm);
  } else {
    modelTokenizers.set(norm, fn);
  }
}

/** The OpenAI BPE vocabularies Kai bundles (lazy-loaded; see `loadModelTokenizer`). */
export type BundledEncoding = "o200k_base" | "cl100k_base";

const O200K_MODELS = /^(?:gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|chatgpt-4o|o[134])(?:$|[-.:@])/;
const CL100K_MODELS =
  /^(?:gpt-4|gpt-3\.5|gpt-35|text-embedding-(?:3-small|3-large|ada-002))(?:$|[-:@])/;

/**
 * The bundled vocabulary an OpenAI-family model name uses, or null for any other model (Claude,
 * Gemini, Llama, ... have no public offline tokenizer, so they are never matched here). A leading
 * `openai/` provider prefix is ignored.
 */
export function bundledEncodingFor(modelName?: string): BundledEncoding | null {
  if (!modelName) return null;
  const norm = modelName
    .trim()
    .toLowerCase()
    .replace(/^openai\//, "");
  if (O200K_MODELS.test(norm)) return "o200k_base";
  if (CL100K_MODELS.test(norm)) return "cl100k_base";
  return null;
}

const bundledTokenizers = new Map<BundledEncoding, TokenizerFunction>();
const bundledLoads = new Map<BundledEncoding, Promise<TokenizerFunction | null>>();

/**
 * Special-token spellings (`<|endoftext|>`) in source files and prompts are ordinary text to Kai,
 * so none are allowed or disallowed: they are counted as the plain characters they are, never thrown on.
 */
const PLAIN_TEXT = { allowedSpecial: new Set<string>(), disallowedSpecial: new Set<string>() };

async function importBundled(encoding: BundledEncoding): Promise<TokenizerFunction> {
  // Literal specifiers so the bundler emits one lazy chunk per vocabulary (1-2 MB each): nothing is
  // loaded, and startup is unaffected, until a caller asks for an OpenAI model's count.
  const { countTokens } =
    encoding === "o200k_base"
      ? await import("gpt-tokenizer/encoding/o200k_base")
      : await import("gpt-tokenizer/encoding/cl100k_base");
  return (text) => countTokens(text, PLAIN_TEXT);
}

/**
 * Makes the exact tokenizer for `modelName` available to `getModelTokenizer` / `estimateModelTokens`.
 * Resolves to the tokenizer a registered adapter or the bundled OpenAI vocabulary provides, or null
 * when neither applies or the bundled vocabulary cannot be loaded (a build that ships only
 * `dist/cli/index.js` has no lazy chunks): the caller then keeps the labeled heuristic.
 */
export async function loadModelTokenizer(modelName?: string): Promise<TokenizerFunction | null> {
  const registered = getModelTokenizer(modelName);
  if (registered) return registered;
  const encoding = bundledEncodingFor(modelName);
  if (!encoding) return null;
  let load = bundledLoads.get(encoding);
  if (!load) {
    load = importBundled(encoding).then(
      (fn) => {
        bundledTokenizers.set(encoding, fn);
        return fn;
      },
      () => null
    );
    bundledLoads.set(encoding, load);
  }
  return load;
}

/** Test seam: forget loaded bundled tokenizers. */
export function resetBundledTokenizers(): void {
  bundledTokenizers.clear();
  bundledLoads.clear();
}

/**
 * Returns the tokenizer for a model: a registered adapter first, else the bundled OpenAI vocabulary
 * once `loadModelTokenizer` has loaded it, else null (unsupported or not yet loaded).
 */
export function getModelTokenizer(modelName?: string): TokenizerFunction | null {
  if (!modelName) return null;
  const norm = modelName.trim().toLowerCase();
  const registered = modelTokenizers.get(norm);
  if (registered) return registered;
  const encoding = bundledEncodingFor(modelName);
  return (encoding && bundledTokenizers.get(encoding)) || null;
}

export interface ModelTokenMetrics extends TokenMetrics {
  model?: string;
  tokenizerName: string;
  isExact: boolean;
}

/**
 * Estimates or accurately measures tokens for a target model, synchronously, with whatever tokenizer
 * is available now: a registered adapter, or the bundled OpenAI vocabulary if `loadModelTokenizer`
 * has loaded it. Otherwise it falls back to the labeled heuristic and marks `isExact: false` and
 * `isEstimate: true`. Use `estimateModelTokensAsync` to load the bundled vocabulary first.
 */
export function estimateModelTokens(text: string, modelName?: string): ModelTokenMetrics {
  const modelTokenizer = getModelTokenizer(modelName);
  const metrics = estimateTokens(text, modelTokenizer);
  let tokenizerName = "kai-heuristic";
  if (modelTokenizer && !metrics.isEstimate) {
    const registered = modelName ? modelTokenizers.has(modelName.trim().toLowerCase()) : false;
    tokenizerName = registered
      ? `adapter-${modelName}`
      : `bundled-${bundledEncodingFor(modelName)}`;
  }
  return {
    ...metrics,
    model: modelName,
    tokenizerName,
    isExact: !metrics.isEstimate,
  };
}

/**
 * `estimateModelTokens` after loading the model's tokenizer. For an OpenAI-family model the count
 * is the exact count of its BPE vocabulary for this text (chat message framing is not added); for
 * any other model with no registered adapter it is the labeled heuristic.
 */
export async function estimateModelTokensAsync(
  text: string,
  modelName?: string
): Promise<ModelTokenMetrics> {
  await loadModelTokenizer(modelName);
  return estimateModelTokens(text, modelName);
}

/**
 * Deterministic token count that distinguishes measured counts from estimates.
 *
 * Without a tokenizer the result is a character-class HEURISTIC (word, symbol
 * and whitespace runs), not a model tokenizer. Measured against the bundled
 * o200k and cl100k vocabularies on this repository's source and Markdown it
 * counts about 1.7 to 1.9 times as many tokens: deliberately conservative, so
 * a budget sized with it is not overrun, but not a size to quote. Use it for
 * budgeting and relative sizes only; `isEstimate` is true for it and false only
 * when a tokenizer (a registered one, or `estimateModelTokens` for an OpenAI
 * model whose bundled vocabulary is loaded) produced the number.
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

  // Heuristic: runs of word characters, punctuation and whitespace are counted
  // with fixed per-run weights (long words are split at ~3.8 chars, whitespace
  // at 4). The constants are rules of thumb, not measured against a tokenizer.
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
