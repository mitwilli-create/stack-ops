#!/bin/bash
# cloudflared-nohup.sh
#
# Boot-time + 5-min-tick wrapper that `nohup`s the PROD cloudflared tunnel
# out-of-band from launchd. Workaround for the macOS Tahoe (15.x) launchd
# KeepAlive=true regression — the canonical com.mitchell.career-ops.cloudflared
# plist immediately exits with code 78 (EX_CONFIG) on every spawn attempt.
# Pattern documented in ~/.claude/knowledge/brain/bug-class-catalog.md § F.
#
# Sister script to cloudflared-staging-nohup.sh — same pattern, different config.
#
# Pairs with com.mitchell.career-ops.cloudflared-nohup-wrapper.plist
# (RunAtLoad=true, KeepAlive=false, StartInterval=300). The wrapper plist fires
# this script at boot/login + every 5 minutes; this script `nohup`s cloudflared
# into a detached session, then exits 0. The 5-minute cadence is the recovery
# window if the tunnel ever dies.
#
# Idempotent: if a prod cloudflared process is already running (matches the
# --config flag for ~/.cloudflared/config.yml), this script no-ops and exits 0.
#
# Remove this wrapper when Apple patches the launchd bug.

set -u

CONFIG="${HOME}/.cloudflared/config.yml"
# Log dir MUST live outside ~/Documents/ — macOS Tahoe TCC blocks /bin/bash
# spawned by launchd from opening file handles under Documents (exit 78).
# Fixed 2026-05-22 (Phase 6.5-CAD-1) — see .claude/audit/plist-fix-2026-05-22/.
LOG_DIR="/Users/mitchellwilliams/Library/Logs/career-ops"
LOG_OUT="${LOG_DIR}/cloudflared-nohup.out"
LOG_ERR="${LOG_DIR}/cloudflared-nohup.err"

mkdir -p "$LOG_DIR"

# Idempotency check: is the prod tunnel (config.yml, NOT config-staging.yml) already running?
if /usr/bin/pgrep -f "cloudflared tunnel --config ${CONFIG}" >/dev/null 2>&1; then
  echo "$(date -Iseconds) cloudflared prod already running, no-op" >> "$LOG_OUT"
  exit 0
fi

# Spawn detached via nohup.
nohup /opt/homebrew/bin/cloudflared tunnel --config "$CONFIG" run \
  >> "$LOG_OUT" 2>> "$LOG_ERR" </dev/null &

disown 2>/dev/null || true
echo "$(date -Iseconds) cloudflared prod spawned via nohup (PID $!)" >> "$LOG_OUT"
exit 0
