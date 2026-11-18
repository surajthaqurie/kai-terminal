import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  bundledEncodingFor,
  estimateChatTokensAsync,
  estimateModelTokens,
  estimateModelTokensAsync,
  estimateTokens,
  getModelTokenizer,
  loadModelTokenizer,
  registerCustomTokenizer,
  registerModelTokenizer,
  resetBundledTokenizers,
} from "../core/tokenCounter";

beforeEach(() => {
  registerCustomTokenizer(null);
  resetBundledTokenizers();
});

afterEach(() => {
  registerModelTokenizer("gpt-4o", null);
  registerCustomTokenizer(null);
  resetBundledTokenizers();
});

describe("bundled OpenAI tokenizers", () => {
  it("maps OpenAI-family model names to a vocabulary and nothing else", () => {
    for (const m of [
      "gpt-4o",
      "GPT-4o-mini",
      "gpt-4.1",
      "gpt-5",
      "o3-mini",
      "o1",
      "openai/gpt-4o",
    ]) {
      expect(bundledEncodingFor(m), m).toBe("o200k_base");
    }
    for (const m of ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo", "text-embedding-3-small"]) {
      expect(bundledEncodingFor(m), m).toBe("cl100k_base");
    }
    // No public offline tokenizer: never claimed.
    for (const m of [
      "claude-sonnet-5-5",
      "gemini-2.5-pro",
      "llama-3",
      "o10",
      "gpt-40",
      "",
      undefined,
    ]) {
      expect(bundledEncodingFor(m), String(m)).toBeNull();
    }
  });

  it("is lazy: nothing is exact until the vocabulary is loaded", () => {
    expect(getModelTokenizer("gpt-4o")).toBeNull();
    const before = estimateModelTokens("hello world", "gpt-4o");
    expect(before.isEstimate).toBe(true);
    expect(before.isExact).toBe(false);
    expect(before.tokenizerName).toBe("kai-heuristic");
  });

  it("counts exactly once loaded, with a bundled tokenizer name", async () => {
    const fn = await loadModelTokenizer("gpt-4o");
    expect(fn).toBeTypeOf("function");
    const m = estimateModelTokens("hello world", "gpt-4o");
    expect(m.isEstimate).toBe(false);
    expect(m.isExact).toBe(true);
    expect(m.estimatedTokens).toBe(2);
    expect(m.measuredTokens).toBe(2);
    expect(m.tokenizerName).toBe("bundled-o200k_base");
  });

  it("uses the right vocabulary per model (cl100k reference value)", async () => {
    const m = await estimateModelTokensAsync("tiktoken is great!", "gpt-4");
    expect(m.isExact).toBe(true);
    expect(m.tokenizerName).toBe("bundled-cl100k_base");
    expect(m.estimatedTokens).toBe(6);
  });

  it("counts special-token spellings as plain text instead of throwing", async () => {
    const m = await estimateModelTokensAsync("a <|endoftext|> b", "gpt-4o");
    expect(m.isExact).toBe(true);
    expect(m.estimatedTokens).toBeGreaterThan(3);
  });

  it("handles empty text and non-ASCII text", async () => {
    expect((await estimateModelTokensAsync("", "gpt-4o")).estimatedTokens).toBe(0);
    const cjk = await estimateModelTokensAsync("你好，世界 🌍", "gpt-4o");
    expect(cjk.isExact).toBe(true);
    expect(cjk.estimatedTokens).toBeGreaterThan(0);
  });

  it("stays an honest estimate for models without a public tokenizer", async () => {
    const m = await estimateModelTokensAsync("hello world", "claude-sonnet-5-5");
    expect(m.isEstimate).toBe(true);
    expect(m.isExact).toBe(false);
    expect(m.tokenizerName).toBe("kai-heuristic");
    expect(await loadModelTokenizer("claude-sonnet-5-5")).toBeNull();
  });

  it("lets a registered adapter win over the bundled vocabulary", async () => {
    registerModelTokenizer("gpt-4o", () => 99);
    await loadModelTokenizer("gpt-4o");
    const m = estimateModelTokens("hello world", "gpt-4o");
    expect(m.estimatedTokens).toBe(99);
    expect(m.tokenizerName).toBe("adapter-gpt-4o");
  });

  it("does not change the model-less default: still the labeled heuristic", async () => {
    await loadModelTokenizer("gpt-4o");
    const m = estimateTokens("hello world");
    expect(m.isEstimate).toBe(true);
    expect(m.measuredTokens).toBeUndefined();
  });
});

describe("chat framing", () => {
  const messages = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello there, how are you?" },
  ];

  it("matches the OpenAI chat format exactly for an OpenAI model", async () => {
    const { encodeChat } = await import("gpt-tokenizer/model/gpt-4o");
    const m = await estimateChatTokensAsync(messages, "gpt-4o");
    expect(m.isExact).toBe(true);
    expect(m.isEstimate).toBe(false);
    expect(m.tokenizerName).toBe("bundled-o200k_base");
    // encodeChat includes the 3 reply-priming tokens too.
    expect(m.estimatedTokens).toBe(encodeChat(messages).length);
  });

  it("adds framing to the plain text count", async () => {
    const text = await estimateModelTokensAsync("Hello there, how are you?", "gpt-4o");
    const one = await estimateChatTokensAsync(
      [{ role: "user", content: "Hello there, how are you?", name: "kai" }],
      "gpt-4o"
    );
    const role = estimateModelTokens("user", "gpt-4o").estimatedTokens;
    const name = estimateModelTokens("kai", "gpt-4o").estimatedTokens;
    expect(one.estimatedTokens).toBe(text.estimatedTokens + role + name + 3 + 1 + 3);
  });

  it("stays a labeled estimate for models without a tokenizer", async () => {
    const m = await estimateChatTokensAsync(messages, "claude-sonnet");
    expect(m.isExact).toBe(false);
    expect(m.isEstimate).toBe(true);
    expect(m.measuredTokens).toBeUndefined();
    expect(m.tokenizerName).toBe("kai-heuristic");
    expect((await estimateChatTokensAsync([], "claude-sonnet")).estimatedTokens).toBe(0);
  });
});
