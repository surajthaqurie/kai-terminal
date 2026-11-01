#!/usr/bin/env bash
# Push the current branch, then move (repoint) a release tag to the new HEAD
# and force-push it so the `release.yml` workflow (on: push tags v*.*.*) rebuilds.
#
# Usage:
#   bash scripts/repoint-tag.sh <tag> [--commit-msg "msg"] [--yes] [--dry-run]
#
# Examples:
#   bash scripts/repoint-tag.sh v0.1.3 --commit-msg "fix(clippy): ..." --yes
#   bash scripts/repoint-tag.sh v0.1.3 --dry-run
#   npm run release:repoint -- v0.1.3 --commit-msg "fix(clippy): ..." --yes
#
# Steps:
#   1. Commit changes to TRACKED files (if any) using --commit-msg. Untracked
#      files are never added: `git add` them first if they belong in the release.
#   2. Push current branch to origin.
#   3. Recreate the annotated tag on HEAD and force-push it in place. The remote
#      tag is updated by one push, never deleted first, so a failed push leaves
#      the old release tag exactly where it was.
#
# --dry-run prints every command that would change the repository or the remote
# instead of running it.
#
# WARNING: repointing a published tag rewrites release history. Only use for
# fixing a broken (unpublished / failed-gate) release tag. Requires a clean
# fetch of remote tags first.
set -euo pipefail

TAG="${1:-}"
COMMIT_MSG="chore: repoint ${TAG}"
ASSUME_YES=0
DRY_RUN=0

shift || true
while [ "$#" -gt 0 ]; do
  case "$1" in
    --commit-msg)
      COMMIT_MSG="${2:-$COMMIT_MSG}"
      shift 2
      ;;
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$TAG" ]; then
  echo "Usage: bash scripts/repoint-tag.sh <tag> [--commit-msg \"msg\"] [--yes] [--dry-run]" >&2
  exit 1
fi

# Run a command that changes the repository or the remote, or just show it.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

BRANCH="$(git branch --show-current)"
if [ -z "$BRANCH" ]; then
  echo "Detached HEAD; checkout a branch first." >&2
  exit 1
fi

echo "Branch: $BRANCH"
echo "Tag:    $TAG"

# 1. Commit tracked changes if needed. `git add -A` would also sweep in every
# untracked file (local config, generated output) and ship it in the release.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree dirty — committing changes to tracked files..."
  run git add -u
  run git commit -m "$COMMIT_MSG"
else
  echo "Working tree clean — nothing to commit."
fi
UNTRACKED="$(git ls-files --others --exclude-standard)"
if [ -n "$UNTRACKED" ]; then
  echo "Note: untracked files are NOT included (git add them first if they belong in the release):"
  echo "$UNTRACKED" | head -20 | sed 's/^/  /'
fi

# 2. Sync tags, show where the tag points now.
git fetch origin --tags --prune --force
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG currently -> $(git rev-parse "$TAG")" "(target: $(git rev-parse "$TAG^{}"))"
else
  echo "Local tag $TAG does not exist yet."
fi
echo "HEAD is $(git rev-parse HEAD)"

if [ "$ASSUME_YES" -ne 1 ] && [ "$DRY_RUN" -ne 1 ]; then
  printf "Push branch %s, then MOVE tag %s to HEAD? [y/N] " "$BRANCH" "$TAG"
  read -r reply
  case "$reply" in
    [yY][eE][sS]|[yY]) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

# 3. Push branch.
run git push origin "$BRANCH"

# 4. Repoint tag: recreate the annotated tag on HEAD and force-push it in place.
# Preserve the previous annotation message when possible.
PREV_MSG=""
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  PREV_MSG="$(git tag -l --format='%(contents)' "$TAG" || true)"
fi
if [ -z "$PREV_MSG" ]; then
  PREV_MSG="$TAG"
fi

run git tag -f -a "$TAG" -m "$PREV_MSG"
run git push --force origin "refs/tags/$TAG"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run complete: nothing was committed, pushed or tagged."
else
  echo "Done: branch $BRANCH pushed, tag $TAG now -> $(git rev-parse "$TAG^{}")."
  echo "The release workflow will rebuild from the moved tag."
fi
