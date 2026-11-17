#!/usr/bin/env bash
set -euo pipefail
NODE="$CLAUDE_PROJECT_DIR/AGENTS.md"
[ -f "$NODE" ] || exit 0
jq -n --rawfile content "$NODE" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $content}}'
