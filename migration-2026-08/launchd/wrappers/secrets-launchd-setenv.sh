#!/bin/bash
# Login LaunchAgent shim (Decision C): publish config + vault vars to the
# launchd/GUI domain so Finder/Dock/launchd-launched apps see them.
# (Login shells already get them via ~/.zshenv.)
# Logs COUNTS only — never a secret value. Lives OUTSIDE ~/Documents (Tahoe TCC).
set -u
CONFIG="$HOME/.secrets/config.env"
VAULT="$HOME/.secrets/api-keys.env"
LOG="$HOME/Library/Logs/secrets-env.log"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# collect every defined name from both files (config first)
names=$(awk -F= '/^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=/{n=$1;sub(/^[[:space:]]*export[[:space:]]+/,"",n);gsub(/[[:space:]]/,"",n);print n}' "$CONFIG" "$VAULT" 2>/dev/null | awk '!seen[$0]++')

set -a
[ -f "$CONFIG" ] && . "$CONFIG"
[ -f "$VAULT" ]  && . "$VAULT"
set +a

# Names deliberately NOT published to the launchd/GUI domain (added 2026-07-19).
# ANTHROPIC_API_KEY: GUI apps inherit this domain, and Claude Code (desktop +
# CLI) switches to per-token API-key billing when it sees the key in the
# environment, overriding the subscription login ("gateway mode"). Consumers
# (career-ops et al.) load it from their own .env via dotenv — verified — so
# withholding it here breaks nothing. Remove a name from SKIP_GUI to restore.
SKIP_GUI=" ANTHROPIC_API_KEY "

count=0
skipped=0
for n in $names; do
  case "$SKIP_GUI" in *" $n "*) skipped=$((skipped+1)); continue ;; esac
  v="${!n-}"
  if [ -n "${v:-}" ]; then
    /bin/launchctl setenv "$n" "$v"
    count=$((count+1))
  fi
done
printf '%s secrets-env: published %d vars to launchd domain (%d withheld by policy)\n' "$TS" "$count" "$skipped" >> "$LOG" 2>/dev/null || true
exit 0
