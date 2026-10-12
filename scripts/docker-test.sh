#!/usr/bin/env bash
# Local Docker test runner — mirrors .github/workflows/ci.yml (Linux job)
# and TEST_PLAN.md section 4 verification commands.
#
# Usage (inside container, or via compose):
#   ./scripts/docker-test.sh all       # full gate: frontend + rust + pty + builds
#   ./scripts/docker-test.sh frontend  # typecheck + format:check + vitest + CLI smoke
#   ./scripts/docker-test.sh rust      # cargo fmt + clippy + lib unit tests
#   ./scripts/docker-test.sh pty       # real PTY integration tests
#   ./scripts/docker-test.sh build     # web frontend + release backend binary
set -euo pipefail
cd "$(dirname "$0")/.."

STEP="${1:-all}"

run_frontend() {
  echo "==> [1/5] TypeScript typecheck"
  npm run typecheck
  echo "==> [2/5] Prettier format check"
  npm run format:check
  echo "==> [3/5] Vitest unit tests"
  npm run test
  echo "==> [4/5] CLI build + smoke test"
  npm run build:cli
  node ./bin/kai.js --version
  node ./bin/kai.js --help
}

run_rust() {
  echo "==> Rust fmt check"
  cargo fmt --manifest-path src-tauri/Cargo.toml --check
  echo "==> Rust clippy lint"
  cargo clippy --no-default-features --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
  echo "==> Rust backend unit tests"
  cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --lib
}

run_pty() {
  echo "==> Real PTY integration tests (needs /dev/ptmx — run with --device or privileged)"
  cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --test pty_integration_tests -- --nocapture
}

run_build() {
  echo "==> Web frontend bundle"
  npm run build
  echo "==> Rust desktop backend binary (no-default-features)"
  cargo build --manifest-path src-tauri/Cargo.toml --release --no-default-features
}

case "$STEP" in
  frontend) run_frontend ;;
  rust) run_rust ;;
  pty) run_pty ;;
  build) run_build ;;
  all) run_frontend; run_rust; run_pty; run_build ;;
  *)
    echo "Unknown step: $STEP (expected: all|frontend|rust|pty|build)" >&2
    exit 1
    ;;
esac

echo "OK: docker-test.sh [$STEP] passed."
