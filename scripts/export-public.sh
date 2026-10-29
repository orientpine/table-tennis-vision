#!/usr/bin/env bash
# Builds the public tree from a commit of the private repo and leak-checks it.
#   scripts/export-public.sh <rev> <empty dest dir>
# Takes the committed files of <rev> (git archive, so nothing uncommitted or gitignored), drops
# the private-only paths below, puts README.public.md in place of README.md, then runs
# scripts/scan-public.sh on the result. Exits non-zero if the scan finds anything.
set -euo pipefail

REV="${1:?usage: export-public.sh <rev> <dest>}"
DEST="${2:?usage: export-public.sh <rev> <dest>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$DEST"
[[ -z "$(ls -A "$DEST")" ]] || { echo "dest not empty: $DEST" >&2; exit 2; }
git -C "$ROOT" archive "$REV" | tar -x -C "$DEST"

PRIVATE_ONLY=(
  'REPORT*.md' 'BRIEF*.md' .omo reference evidence data public-url.txt
  qa/demo.html qa/demo-state.js qa/ui-demo.js qa/make-home-clips.sh qa/fixtures
  public/bench/frame.jpg
)
( cd "$DEST" && for p in "${PRIVATE_ONLY[@]}"; do rm -rf -- $p; done )
mv "$DEST/README.public.md" "$DEST/README.md"

echo "exported $(git -C "$ROOT" rev-parse --short=12 "$REV") -> $DEST ($(find "$DEST" -type f | wc -l) files)"
bash "$ROOT/scripts/scan-public.sh" "$DEST"
