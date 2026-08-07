#!/bin/bash
# Weekly maintenance for the LLM memory vault. Invoked by com.mitchell.llm-memory.weekly.
#
# SCOPE IS DELIBERATELY LIMITED TO ~/.claude. Verified 2026-07-20: launchd cannot read
# ~/Documents at all (TCC), so anything touching the vault itself must run from a shell
# that carries Mitchell's TCC grants. The mem0 index rebuild therefore runs from the
# vault's own git post-commit hook instead, which is better anyway: the index refreshes
# when memory actually changes rather than on a timer.
#
# No KeepAlive on the plist, so this is not exposed to the Tahoe launchd regression
# (brain/bug-class-catalog.md, Pattern F).
set -uo pipefail
LOG="$HOME/.local/llm-memory-wrappers/weekly.log"
exec >> "$LOG" 2>&1
echo "================ $(date '+%Y-%m-%d %H:%M:%S') weekly prune ================"
bash "$HOME/.local/llm-memory-wrappers/llm-memory-sweep.sh" --days 14
echo "  (mem0 index: rebuilt by the vault post-commit hook, not here. TCC blocks launchd from ~/Documents.)"
echo "================ done ================"
