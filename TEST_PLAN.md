# Test Plan & Verification Matrix

This document outlines the testing strategy, test plan execution matrix, and verification commands for Kai Terminal.

---

## 1. Testing Methodology

The test suite is divided into three verification layers:

1. **Frontend Unit Tests (`src/__tests__/`):** Tests React UI components, shortcut registry, split-pane layout algorithms, and workspace storage handling using Vitest.
2. **Rust Backend Unit Tests (`src-tauri/src/`):** Tests shell path detection, Windows version gate checks, chunked byte writes, and AI CLI status checking logic using standard Rust unit tests.
3. **Real PTY Integration Tests (`src-tauri/tests/pty_integration_tests.rs`):** Tests real pseudo-terminal master/slave spawning (`openpty` on Unix, ConPTY on Windows) against live system shell processes.

---

## 2. PTY Integration Test Matrix

The real PTY integration suite covers 13 core scenarios:

| # | Test Scenario | Description | Automated Test Target | Status |
| :--- | :--- | :--- | :--- | :--- |
| **1** | **PTY Startup** | Verify process spawning for standard system shells | `test_01_pty_creation_and_shell_startup` | **Passed** |
| **2** | **Session Environment** | Verify persistence of shell variables across input streams | `test_02_persistent_shell_variables` | **Passed** |
| **3** | **I/O Correctness** | Verify special character handling and multiline output | `test_03_input_output_correctness` | **Passed** |
| **4** | **ANSI & Unicode** | Verify 24-bit RGB color rendering and UTF-8 multi-byte characters | `test_04_ansi_colors_and_unicode` | **Passed** |
| **5** | **Window Resizing** | Verify terminal grid column/row dimension updates | `test_05_terminal_resizing` | **Passed** |
| **6** | **Subshell Processes** | Verify execution of background loops and subshells | `test_06_long_running_interactive_processes` | **Passed** |
| **7** | **Signal Handling** | Verify `Ctrl+C` interrupt (`\x03`) and `EOF` (`\x04`) signals | `test_07_ctrl_c_and_supported_signals` | **Passed** |
| **8** | **High-Volume Output** | Verify output streaming under continuous high-volume data | `test_08_high_volume_output_and_memory` | **Passed** |
| **9** | **Error Fallbacks** | Verify error handling for invalid shell paths or missing directories | `test_09_invalid_shells_and_working_directories` | **Passed** |
| **10** | **Concurrent Sessions** | Verify 8 simultaneous active PTY sessions operating independently | `test_10_multiple_simultaneous_sessions` | **Passed** |
| **11** | **Process Reaping** | Verify PID tracking and cleanup when process exits | `test_11_child_process_cleanup` | **Passed** |
| **12** | **Shutdown Safety** | Verify clean session termination on window close | `test_12_application_startup_and_shutdown` | **Passed** |
| **13** | **AI Tool Contract** | Verify PTY compatibility when launching interactive AI CLIs | `test_13_real_ai_cli_compatibility` | **Passed** |

---

## 3. Project Intelligence & MCP Verification Matrix

The intelligence test suite (`src/__tests__/intelligence.test.ts`, `src/__tests__/mcp_security.test.ts`, `src/__tests__/audit_production_security.test.ts`, and `src/__tests__/performance_benchmarks.test.ts`) covers comprehensive automated scenarios across 109 Vitest tests:

| # | Test Area | Description | Automated Target | Status |
| :--- | :--- | :--- | :--- | :--- |
| **1** | **Token Estimation** | Bounded heuristic estimation distinguishing estimates from measurements (`isEstimate`) | `intelligence.test.ts` | **Passed** |
| **2** | **Budget Bounding** | Strict text truncation to fit token budget bounds with two-pass enforcement | `intelligence.test.ts` | **Passed** |
| **3** | **Task Classification** | Deterministic rule matching for 8 categories (`explain`, `implement`, `debug`, etc.) | `intelligence.test.ts` | **Passed** |
| **4** | **Classifier Fallback** | Uncertain queries safely categorized as `unknown` with low confidence | `intelligence.test.ts` | **Passed** |
| **5** | **Caller Override** | Caller or agent explicitly overrides classification with 100% confidence | `intelligence.test.ts` | **Passed** |
| **6** | **Task Preservation** | User original task is preserved verbatim without rewriting across all templates | `intelligence.test.ts` | **Passed** |
| **7** | **Skill Matching** | On-demand skill selection based on category, language, and keywords | `intelligence.test.ts` | **Passed** |
| **8** | **Skill Safety** | Strict size bounding and non-execution of skill content | `intelligence.test.ts` | **Passed** |
| **9** | **MCP Handshake** | Valid `initialize` JSON-RPC response with protocol version and server info | `mcp_security.test.ts` | **Passed** |
| **10** | **MCP Tool Discovery**| `tools/list` exposes all 7 intelligence tools with valid JSON schemas | `mcp_security.test.ts` | **Passed** |
| **11** | **MCP Argument Guard**| Unknown tools or missing parameters return structured JSON-RPC error codes | `mcp_security.test.ts` | **Passed** |
| **12** | **MCP Workspace Confinement** | Tools reject file paths outside authorized project boundary | `mcp_security.test.ts` | **Passed** |
| **13** | **Secret Scrubbing** | Built-in patterns exclude `.env*`, `id_rsa*`, PKCS#8 keys, and API tokens | `audit_production_security.test.ts` | **Passed** |
| **14** | **Dynamic Code Fence** | Escapes triple/quadruple backticks preventing prompt breakout | `audit_production_security.test.ts` | **Passed** |
| **15** | **Binary Rejection** | Extension and null-byte checks skip binary and object files | `mcp_security.test.ts` | **Passed** |
| **16** | **Atomic Persistence**| Temporary file write and atomic rename prevent corrupt indexes | `mcp_security.test.ts` | **Passed** |
| **17** | **Lock Concurrency** | Exclusive `ProjectLock` with PID and timeout prevents index collision | `mcp_security.test.ts` | **Passed** |
| **18** | **Symlink Boundaries**| Traversal stops at project boundary; symlinks pointing outside root are rejected | `audit_production_security.test.ts` | **Passed** |
| **19** | **Retrieval Freshness**| Filter stop words, singular/plural stem matching, and extract constants | `audit_production_security.test.ts` | **Passed** |
| **20** | **Performance Benchmarks** | Evaluates 4 configurations with sub-10ms latency and ~70% token savings | `performance_benchmarks.test.ts` | **Passed** |

---

## 4. Verification Commands

Run all verification checks locally prior to committing:

```bash
# 1. Full TypeScript, Formatting & Intelligence Test Suite (Vitest - 16 test files, 109 tests)
npm run check

# 2. Standalone CLI Build
npm run build:cli

# 3. CLI Smoke & Benchmark Verification
./bin/kai.js --help
./bin/kai.js code .
./bin/kai.js status .
./bin/kai.js bench .

# 4. Rust Backend Formatting Check
cargo fmt --manifest-path src-tauri/Cargo.toml --check

# 5. Rust Backend Linter Check
cargo clippy --no-default-features --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

# 6. Rust Backend Unit Tests (40 tests)
cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --lib

# 7. Real PTY Integration Tests (13 tests)
cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --test pty_integration_tests
```
