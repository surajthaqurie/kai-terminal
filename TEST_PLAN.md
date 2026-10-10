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

## 3. Verification Commands

Run all verification checks locally prior to committing:

```bash
# 1. Frontend Checks (TypeScript + Prettier formatting + Vitest unit tests)
npm run check

# 2. Rust Backend Formatting Check
cargo fmt --manifest-path src-tauri/Cargo.toml --check

# 3. Rust Backend Linter Check
cargo clippy --no-default-features --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

# 4. Rust Backend Unit Tests
cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --lib

# 5. Real PTY Integration Tests
cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --test pty_integration_tests
```
