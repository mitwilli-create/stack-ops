#!/bin/zsh
# Runtime source is installed under ~/.local/stack-ops because macOS Tahoe
# launchd jobs use a detached nohup child for reliable scheduled execution.

set -u
setopt NO_NOMATCH
setopt PIPE_FAIL
umask 077

REPO="__STACK_OPS_REPO__"
BOOTSTRAP="__STACK_OPS_RUNTIME_BOOTSTRAP__"
LOG_DIR="__STACK_OPS_LOG_DIR__"
LOG_OUT="${LOG_DIR}/launchd.out"
LOG_ERR="${LOG_DIR}/launchd.err"

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
  print -u2 "Stack Ops stray-drain wrapper could not find Node.js."
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
print -rn -- "${CHEAP_KEY_VALUE}" | nohup /usr/bin/env -i "${CLEAN_ENV[@]}" \
  "${NODE_BIN}" "${BOOTSTRAP}" \
  --credential-fd 0 \
  --node "${NODE_BIN}" \
  --repo "${REPO}" \
  --script "${REPO}/scripts/memory-sweep/stray-drain.mjs" \
  --log-out "${LOG_OUT}" \
  --log-err "${LOG_ERR}"
exit $?
