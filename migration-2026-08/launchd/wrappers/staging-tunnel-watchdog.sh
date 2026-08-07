#!/bin/bash
# Idempotent watchdog for the cloudflared staging tunnel.
#
# Lives in ~/.cloudflared/ (NOT ~/Documents/) because macOS Tahoe TCC blocks
# /bin/bash invoked by launchd from accessing ~/Documents/. Cloudflared's
# stdout/stderr also go to ~/Library/Logs/career-ops/ for the same reason
# (the launchd-spawned bash opens the redirect FDs before exec).
#
# Sister memory: project_launchd_keepalive_tahoe_bug.

set -u

CLOUDFLARED=/opt/homebrew/bin/cloudflared
CONFIG="$HOME/.cloudflared/config-staging.yml"
LOG_DIR="$HOME/Library/Logs/career-ops"
OUT_LOG="$LOG_DIR/cloudflared-staging.out"
ERR_LOG="$LOG_DIR/cloudflared-staging.err"
WATCHDOG_LOG="$LOG_DIR/staging-tunnel-watchdog.log"

mkdir -p "$LOG_DIR"

ts() { date -u "+%Y-%m-%dT%H:%M:%SZ"; }

if pgrep -f "cloudflared.*config-staging.yml" > /dev/null 2>&1; then
  echo "$(ts) [watchdog] staging tunnel already running, no-op" >> "$WATCHDOG_LOG"
  exit 0
fi

echo "$(ts) [watchdog] staging tunnel not running, spawning via nohup" >> "$WATCHDOG_LOG"
# < /dev/null + AbandonProcessGroup in the plist together prevent launchd from
# SIGTERMing the cloudflared child when this script exits.
nohup "$CLOUDFLARED" tunnel --config "$CONFIG" run \
  >> "$OUT_LOG" 2>> "$ERR_LOG" < /dev/null &
SPAWN_PID=$!
disown
echo "$(ts) [watchdog] spawned pid $SPAWN_PID" >> "$WATCHDOG_LOG"
sleep 2
if kill -0 "$SPAWN_PID" 2>/dev/null; then
  echo "$(ts) [watchdog] pid $SPAWN_PID alive after 2s" >> "$WATCHDOG_LOG"
else
  echo "$(ts) [watchdog] pid $SPAWN_PID DIED within 2s — check $ERR_LOG" >> "$WATCHDOG_LOG"
fi
exit 0
