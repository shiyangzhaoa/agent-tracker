#!/bin/sh
set +e

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
DIST_ENTRY="$REPO_ROOT/dist/index.js"
SRC_ENTRY="$REPO_ROOT/index.ts"

cd "$REPO_ROOT" || exit 0

if [ -f "$DIST_ENTRY" ]; then
  bun "$DIST_ENTRY" collect cursor hook
elif [ -f "$SRC_ENTRY" ]; then
  bun run "$SRC_ENTRY" collect cursor hook
elif command -v agent-tracker >/dev/null 2>&1; then
  agent-tracker collect cursor hook
fi

exit 0
