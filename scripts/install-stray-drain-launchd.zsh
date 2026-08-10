#!/bin/zsh
set -u
setopt NO_NOMATCH

SCRIPT_DIR="${0:A:h}"
REPO="${SCRIPT_DIR:h}"
LABEL="com.mitchell.stack-ops.stray-drain"
RUNTIME_DIR="${HOME}/.local/stack-ops"
RUNTIME_WRAPPER="${RUNTIME_DIR}/stray-drain-nohup-wrapper.zsh"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST="${PLIST_DIR}/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/stack-ops/stray-drain"

mkdir -p "${RUNTIME_DIR}" "${PLIST_DIR}" "${LOG_DIR}"
sed "s|__STACK_OPS_REPO__|${REPO}|g; s|__STACK_OPS_LOG_DIR__|${LOG_DIR}|g" \
  "${REPO}/scripts/launchd/stack-ops-stray-drain-nohup-wrapper.zsh" > "${RUNTIME_WRAPPER}"
chmod 700 "${RUNTIME_WRAPPER}"
sed "s|__STACK_OPS_RUNTIME_WRAPPER__|${RUNTIME_WRAPPER}|g; s|__STACK_OPS_HOME__|${HOME}|g; s|__STACK_OPS_LOG_DIR__|${LOG_DIR}|g" \
  "${REPO}/scripts/launchd/com.mitchell.stack-ops.stray-drain.plist" > "${PLIST}"
plutil -lint "${PLIST}" >/dev/null || exit 1
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
if ! launchctl bootstrap "gui/$(id -u)" "${PLIST}"; then
  print -u2 "Stack Ops stray-drain launch agent could not be bootstrapped: ${LABEL}"
  exit 1
fi
print "Stack Ops stray-drain launch agent installed: ${LABEL}"
