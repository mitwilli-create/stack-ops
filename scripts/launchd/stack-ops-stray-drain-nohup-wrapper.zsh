#!/bin/zsh
# Runtime source is installed under ~/.local/stack-ops because macOS Tahoe
# launchd jobs use a detached nohup child for reliable scheduled execution.

set -u
setopt NO_NOMATCH

REPO="__STACK_OPS_REPO__"
LOG_DIR="__STACK_OPS_LOG_DIR__"
LOG_OUT="${LOG_DIR}/launchd.out"
LOG_ERR="${LOG_DIR}/launchd.err"

mkdir -p "${LOG_DIR}"

if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  source "${HOME}/.nvm/nvm.sh" --no-use 2>/dev/null
fi

NODE_BIN="${commands[node]:-}"
if [[ -z "${NODE_BIN}" ]]; then
  for candidate in "${HOME}"/.nvm/versions/node/*/bin/node; do
    [[ -x "${candidate}" ]] && NODE_BIN="${candidate}"
  done
fi
if [[ -z "${NODE_BIN}" ]]; then
  print -u2 "Stack Ops stray-drain wrapper could not find Node.js." >>"${LOG_ERR}"
  exit 1
fi

cd "${REPO}" || exit 1
typeset -a CLEAN_ENV
CLEAN_ENV=(
  "HOME=${HOME}"
  "USER=${USER:-}"
  "LOGNAME=${LOGNAME:-}"
  "PATH=${PATH}"
  "TMPDIR=${TMPDIR:-/tmp}"
  "LANG=${LANG:-}"
  "LC_ALL=${LC_ALL:-}"
  "LC_CTYPE=${LC_CTYPE:-}"
)
CHEAP_KEY_NAME="OPENROUTER_API_KEY"
CHEAP_KEY_VALUE="${(P)CHEAP_KEY_NAME:-}"
[[ -n "${CHEAP_KEY_VALUE}" ]] && CLEAN_ENV+=("${CHEAP_KEY_NAME}=${CHEAP_KEY_VALUE}")
nohup /usr/bin/env -i "${CLEAN_ENV[@]}" "${NODE_BIN}" scripts/memory-sweep/stray-drain.mjs \
  >>"${LOG_OUT}" 2>>"${LOG_ERR}" </dev/null &!
disown 2>/dev/null || true
exit 0
