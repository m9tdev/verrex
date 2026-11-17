#!/usr/bin/env bash
# PostToolUse hook: after a file Read/Edit/Write, find the nearest AGENTS.md
# (intent node) above the touched file and inject it into context, once per
# node per session. Generic — adding a new AGENTS.md anywhere needs no
# registration. Claude Code never auto-loads AGENTS.md; this hook closes that
# gap mechanically for nested nodes.
set -euo pipefail

INPUT=$(cat)
FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
[ -z "$FILE" ] && exit 0

# The intent nodes themselves don't need re-injection when read directly.
case "$FILE" in
  */AGENTS.md) exit 0 ;;
esac

ROOT=$(printf '%s' "$INPUT" | jq -r '.cwd // empty')
[ -z "$ROOT" ] && ROOT="$PWD"
SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // "nosession"')

DIR=$(dirname "$FILE")
case "$DIR" in
  "$ROOT" | "$ROOT"/*) ;;
  *) exit 0 ;; # file outside the project
esac

NODE=""
while [ "$DIR" != "$ROOT" ] && [ "$DIR" != "/" ]; do
  if [ -f "$DIR/AGENTS.md" ]; then
    NODE="$DIR/AGENTS.md"
    break
  fi
  DIR=$(dirname "$DIR")
done
# No nested node → covered by the root node, injected at session start by
# inject-root-node.sh.
[ -z "$NODE" ] && exit 0

HASH=$(printf '%s' "$NODE" | cksum | cut -d' ' -f1)
MARK="${TMPDIR:-/tmp}/claude-intent-${SESSION}-${HASH}"
[ -e "$MARK" ] && exit 0
touch "$MARK"

jq -n --rawfile content "$NODE" --arg node "$NODE" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: ("Intent node covering the file you just touched (" + $node + ") — its invariants and anti-patterns apply to this area:\n\n" + $content)}}'
