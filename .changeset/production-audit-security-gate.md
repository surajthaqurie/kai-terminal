---
"kai-terminal": patch
---

Independent production audit and security release gate fixes:
- Fix npm package distribution: add files whitelist and prepack script to guarantee CLI bundle in published tarballs.
- Resolve critical symlink escape vulnerability in loadProjectRules and loadIgnorePatterns with realpath boundary verification and size bounding.
- Harden secret detection with PKCS#8 private keys, fine-grained GitHub PATs, and Anthropic/OpenAI API keys.
- Enforce MCP workspace boundary confinement to prevent unauthorized project directory access.
- Demarcate untrusted context boundaries and add safe code fence dynamic backtick escaping in context templates.
- Improve retrieval ranking: filter common task stop words from partial symbol matches, add singular/plural stem matching, and extract constant/variable symbols.
- Harmonize benchmark evaluations for equivalent condition testing across configs.
- Support flexible flag ordering in CLI unregister command.
