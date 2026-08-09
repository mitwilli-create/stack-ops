#!/bin/zsh
# Optional wrapper for clients without lifecycle hooks. Usage:
#   cli-session-wrapper.zsh codex exec ...
#   cli-session-wrapper.zsh agy --print ...
#   cli-session-wrapper.zsh grok --single ...

set -u
setopt NO_NOMATCH

if [[ $# -lt 1 ]]; then
  print -u2 'usage: cli-session-wrapper.zsh <cli> [args...]'
  exit 2
fi

CLI="$1"
shift
BRIDGE="${STACK_OPS_DIR:-${HOME}/Documents/stack-ops}/scripts/instance-shipping/cli-heartbeat.zsh"
"${BRIDGE}"

"${CLI}" "$@" &
CHILD_PID=$!
while kill -0 "${CHILD_PID}" 2>/dev/null; do
  sleep 30
  "${BRIDGE}"
done
wait "${CHILD_PID}"
exit $?
