#!/bin/zsh
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Stack Ops Ask
# @raycast.mode fullOutput
# @raycast.packageName Stack Ops
# @raycast.argument1 { "type": "text", "placeholder": "Ask Stack Ops..." }

setopt NO_NOMATCH
SCRIPT_DIR="${0:A:h}"
STACK_OPS_ROOT="${SCRIPT_DIR:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

# Raycast launches scripts outside an interactive shell. Load the user's
# existing environment so the local provider adapters can see key names that
# are already managed by the machine's secret setup. No values live here.
if [[ -f "${HOME}/.zshenv" ]]; then
  source "${HOME}/.zshenv" 2>/dev/null
fi

cd "${STACK_OPS_ROOT}" || exit 1
exec node src/router/ask.mjs --text "$1"
