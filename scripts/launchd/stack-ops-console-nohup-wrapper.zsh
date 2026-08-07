#!/bin/zsh
# Runtime source is installed under ~/.local/stack-ops because macOS Tahoe
# can block launchd from executing scripts stored under ~/Documents.

set -u
setopt NO_NOMATCH

PORT=3939
REPO="__STACK_OPS_REPO__"
LOG_DIR="__STACK_OPS_LOG_DIR__"
LOG_OUT="${LOG_DIR}/console.out"
LOG_ERR="${LOG_DIR}/console.err"

mkdir -p "${LOG_DIR}"

if /usr/sbin/lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  exit 0
fi

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
  print -u2 "Stack Ops launchd wrapper could not find Node.js." >>"${LOG_ERR}"
  exit 1
fi

cd "${REPO}" || exit 1
nohup "${NODE_BIN}" src/agent/server.mjs >>"${LOG_OUT}" 2>>"${LOG_ERR}" </dev/null &!
disown 2>/dev/null || true
exit 0
