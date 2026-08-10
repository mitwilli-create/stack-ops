#!/bin/zsh
set -u
setopt NO_NOMATCH
umask 077

SCRIPT_DIR="${0:A:h}"
REPO="${SCRIPT_DIR:h}"
LABEL="com.mitchell.stack-ops.stray-drain"
RUNTIME_DIR="${HOME}/.local/stack-ops"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST="${PLIST_DIR}/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/stack-ops/stray-drain"
HELPER="${REPO}/scripts/launchd/stray-drain-install-files.mjs"

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
  print -u2 "Stack Ops stray-drain installer could not find Node.js."
  exit 1
fi

TRANSACTION="$("${NODE_BIN}" "${HELPER}" prepare \
  --repo "${REPO}" \
  --runtime-dir "${RUNTIME_DIR}" \
  --plist-dir "${PLIST_DIR}" \
  --log-dir "${LOG_DIR}")" || exit 1

rollback_files() {
  "${NODE_BIN}" "${HELPER}" rollback "${TRANSACTION}"
}

if ! plutil -lint "${PLIST}" >/dev/null; then
  rollback_files || print -u2 "Stack Ops stray-drain property list rollback failed."
  exit 1
fi

WAS_LOADED=0
if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
  WAS_LOADED=1
  if ! launchctl bootout "gui/$(id -u)/${LABEL}"; then
    rollback_files || print -u2 "Stack Ops stray-drain file rollback failed after bootout failure."
    exit 1
  fi
fi

if ! launchctl bootstrap "gui/$(id -u)" "${PLIST}"; then
  print -u2 "Stack Ops stray-drain launch agent could not be bootstrapped: ${LABEL}"
  if ! rollback_files; then
    print -u2 "Stack Ops stray-drain prior installation could not be restored."
    exit 1
  fi
  if (( WAS_LOADED )) && ! launchctl bootstrap "gui/$(id -u)" "${PLIST}"; then
    print -u2 "Stack Ops stray-drain prior launch agent could not be re-bootstrapped: ${LABEL}"
  fi
  exit 1
fi

if ! "${NODE_BIN}" "${HELPER}" finalize "${TRANSACTION}"; then
  print -u2 "Stack Ops stray-drain installed, but prior-file recovery cleanup did not complete."
  exit 1
fi
print "Stack Ops stray-drain launch agent installed: ${LABEL}"
