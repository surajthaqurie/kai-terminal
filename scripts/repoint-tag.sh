#!/usr/bin/env bash
# Push the current branch, then move (repoint) a release tag to the new HEAD
# and force-push it so the `release.yml` workflow (on: push tags v*.*.*) rebuilds.
#
# Usage:
#   bash scripts/repoint-tag.sh <tag> [--commit-msg "msg"] [--yes]
#
# Examples:
#   bash scripts/repoint-tag.sh v0.1.3 --commit-msg "fix(clippy): ..." --yes
#   npm run release:repoint -- v0.1.3 --commit-msg "fix(clippy): ..." --yes
#
# Steps:
#   1. Commit dirty working tree (if any) using --commit-msg (default message).
#   2. Push current branch to origin.
#   3. Delete local + remote <tag>, recreate annotated tag on HEAD, push with --force.
#
# WARNING: repointing a published tag rewrites release history. Only use for
# fixing a broken (unpublished / failed-gate) release tag. Requires a clean
# fetch of remote tags first.
set -euo pipefail

TAG="${1:-}"
COMMIT_MSG="chore: repoint ${TAG}"
ASSUME_YES=0

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
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$TAG" ]; then
  echo "Usage: bash scripts/repoint-tag.sh <tag> [--commit-msg \"msg\"] [--yes]" >&2
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [ -z "$BRANCH" ]; then
  echo "Detached HEAD; checkout a branch first." >&2
  exit 1
fi

echo "Branch: $BRANCH"
echo "Tag:    $TAG"

# 1. Commit dirty tree if needed.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree dirty — committing..."
  git add -A
  git commit -m "$COMMIT_MSG"
else
  echo "Working tree clean — nothing to commit."
fi

# 2. Sync tags, show where the tag points now.
git fetch origin --tags --prune
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG currently -> $(git rev-parse "$TAG")" "(target: $(git rev-parse "$TAG^{}"))"
else
  echo "Local tag $TAG does not exist yet."
fi
echo "HEAD is $(git rev-parse HEAD)"

if [ "$ASSUME_YES" -ne 1 ]; then
  printf "Push branch %s, then MOVE tag %s to HEAD? [y/N] " "$BRANCH" "$TAG"
  read -r reply
  case "$reply" in
    [yY][eE][sS]|[yY]) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

# 3. Push branch.
git push origin "$BRANCH"

# 4. Repoint tag: delete remote + local, recreate annotated tag on HEAD.
# Preserve the previous annotation message when possible.
PREV_MSG=""
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  PREV_MSG="$(git tag -l --format='%(contents)' "$TAG" || true)"
fi
if [ -z "$PREV_MSG" ]; then
  PREV_MSG="$TAG"
fi

git push origin ":refs/tags/$TAG" || echo "(remote tag $TAG did not exist or already deleted)"
git tag -d "$TAG" || true
git tag -a "$TAG" -m "$PREV_MSG"
git push origin "$TAG" --force

echo "Done: branch $BRANCH pushed, tag $TAG now -> $(git rev-parse "$TAG^{}")."
echo "The release workflow will rebuild from the moved tag."
