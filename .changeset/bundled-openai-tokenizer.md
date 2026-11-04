---
"kai-terminal": minor
---

Exact token counts for OpenAI models.

- **Added**: Kai now bundles the OpenAI BPE vocabularies (`o200k_base` for GPT-4o, GPT-4.1, GPT-5 and o-series; `cl100k_base` for GPT-4 and GPT-3.5). `estimateModelTokensAsync(text, model)` counts with the vocabulary for that model and reports it as exact. They load on first use, so startup is unchanged.
- **Unchanged**: Any other model (Claude, Gemini, ...) has no public offline tokenizer, so it keeps the labeled estimate unless you register your own with `registerModelTokenizer`. Counts without a model name are still estimates.
- **Clarified**: The built-in estimate counts about 1.7 to 1.9 times what the OpenAI tokenizers count on code and Markdown. It stays on the high side so budgets are not overrun.
