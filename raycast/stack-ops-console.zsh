#!/bin/zsh
# @raycast.schemaVersion 1
# @raycast.title Stack Ops Console
# @raycast.mode silent
# @raycast.packageName Stack Ops
# @raycast.icon 🧭
#
# Start the local agent console if needed, then open its chat interface.

set -u
setopt NO_NOMATCH
SCRIPT_DIR="${0:A:h}"
ROOT="${SCRIPT_DIR:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"
URL="http://127.0.0.1:${STACK_OPS_CONSOLE_PORT:-3939}"
LOG_DIR="${HOME}/Library/Logs/Stack Ops"
LOG_FILE="${LOG_DIR}/console.log"

if [[ -f "${HOME}/.zshenv" ]]; then
  source "${HOME}/.zshenv" 2>/dev/null
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
  print -u2 "Stack Ops Console could not find Node.js. Check the Node installation used by your terminal."
  exit 1
fi

if ! curl -fsS "${URL}/api/status" >/dev/null 2>&1; then
  INSTALLER="${ROOT}/scripts/install-console-launchd.zsh"
  if [[ -f "${INSTALLER}" ]]; then
    zsh "${INSTALLER}" >/dev/null 2>&1 || true
  fi

  if ! curl -fsS "${URL}/api/status" >/dev/null 2>&1; then
    if ! mkdir -p "${LOG_DIR}"; then
      print -u2 "Stack Ops Console could not create its log directory: ${LOG_DIR}"
      exit 1
    fi
    (cd "${ROOT}" && nohup "${NODE_BIN}" src/agent/server.mjs >>"${LOG_FILE}" 2>&1 </dev/null &!)
    for _ in {1..20}; do
      curl -fsS "${URL}/api/status" >/dev/null 2>&1 && break
      sleep 0.15
    done
  fi
fi

if ! curl -fsS "${URL}/api/status" >/dev/null 2>&1; then
  print -u2 "Stack Ops Console failed to start at ${URL}"
  if [[ -f "${LOG_FILE}" ]]; then
    tail -20 "${LOG_FILE}" >&2
  fi
  exit 1
fi

open "${URL}"
