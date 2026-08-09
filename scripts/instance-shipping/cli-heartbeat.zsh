#!/bin/zsh
# Provider-neutral heartbeat bridge for Claude Code, Codex, Antigravity, and
# Grok. It is intentionally best-effort: a heartbeat failure must not block the
# agent session, while the interval observer remains the source of truth.

set -u
setopt NO_NOMATCH

STACK_OPS_DIR="${STACK_OPS_DIR:-${HOME}/Documents/stack-ops}"
STACK_OPS_CONFIG="${STACK_OPS_CONFIG:-${STACK_OPS_DIR}/scripts/instance-shipping/config.json}"
WORKTREE="${STACK_OPS_WORKTREE:-${PWD}}"
INSTANCE_ID="${STACK_OPS_INSTANCE_ID:-cli-${USER:-unknown}-$$}"
NODE_BIN="${STACK_OPS_NODE:-${commands[node]:-}}"

if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  exit 0
fi
if [[ ! -f "${STACK_OPS_DIR}/scripts/instance-shipping/instance-shipping.mjs" || ! -f "${STACK_OPS_CONFIG}" ]]; then
  exit 0
fi

"${NODE_BIN}" "${STACK_OPS_DIR}/scripts/instance-shipping/instance-shipping.mjs" \
  --heartbeat \
  --worktree "${WORKTREE}" \
  --instance "${INSTANCE_ID}" \
  --config "${STACK_OPS_CONFIG}" \
  >/dev/null 2>&1 || true
