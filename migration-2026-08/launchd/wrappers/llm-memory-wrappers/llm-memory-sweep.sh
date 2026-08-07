#!/bin/bash
# llm-memory-sweep: prune the agent-artifact paths that Anthropic's own sweep does NOT reach.
#
# Claude Code already deletes transcripts, plans, tasks, shell-snapshots, backups, debug logs and
# file-history older than `cleanupPeriodDays` in ~/.claude/settings.json (set to 14 on 2026-07-20).
# It does NOT touch ~/.claude/projects/*/memory/ (good, that is the vault) and it does NOT touch
# anything written by Mitchell's own scripts. This covers the remainder.
#
# Usage:  llm-memory-sweep.sh [--dry-run] [--days N]
# Default: --days 14, matching cleanupPeriodDays. Always dry-run first if you are unsure.
set -euo pipefail

DAYS=14
DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --days) shift; DAYS="${1:-14}" ;;
    --days=*) DAYS="${a#*=}" ;;
  esac
done

LOG="$HOME/.local/llm-memory-wrappers/sweep.log"
say() { printf '%s\n' "$*"; printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

say "=== llm-memory-sweep start (days=$DAYS, dry-run=$DRY) ==="

# Paths Anthropic's cleanupPeriodDays does not cover. Each is disposable by ruling:
# adjudicated finals live in ~/Documents/stack-ops/private/decisions/, raw runs do not.
TARGETS=(
  "$HOME/.claude/agents/runs"      # raw council/agent run json+log+prompt files
  "$HOME/.claude/telemetry"        # failed telemetry upload payloads, never retried
  "$HOME/.claude/cache"            # changelog + small caches, regenerated on demand
)

total=0
for t in "${TARGETS[@]}"; do
  [ -d "$t" ] || { say "  skip (absent): $t"; continue; }
  n=$(find "$t" -type f -mtime +"$DAYS" 2>/dev/null | wc -l | tr -d ' ')
  sz=$(find "$t" -type f -mtime +"$DAYS" -print0 2>/dev/null | xargs -0 du -ck 2>/dev/null | tail -1 | cut -f1)
  sz=${sz:-0}
  if [ "$n" -eq 0 ]; then
    say "  clean: $t (nothing older than ${DAYS}d)"
    continue
  fi
  if [ "$DRY" -eq 1 ]; then
    say "  WOULD DELETE $n file(s), ${sz}KB from $t"
    find "$t" -type f -mtime +"$DAYS" 2>/dev/null | head -5 | sed 's/^/      /' | tee -a "$LOG"
  else
    find "$t" -type f -mtime +"$DAYS" -delete 2>/dev/null || true
    say "  deleted $n file(s), ${sz}KB from $t"
  fi
  total=$((total+n))
done

say "=== llm-memory-sweep done: $total file(s) $([ "$DRY" -eq 1 ] && echo 'would be ' )pruned ==="

# NOTE: the vault autocommit lives in the Documents copy of this script only.
# launchd cannot reach ~/Documents (TCC), so it is a no-op here by design.
