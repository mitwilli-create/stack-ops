#!/bin/zsh
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Stack Ops Route
# @raycast.mode fullOutput
# @raycast.packageName Stack Ops
# @raycast.argument1 { "type": "text", "placeholder": "Inspect routing for..." }

setopt NO_NOMATCH
SCRIPT_DIR="${0:A:h}"
STACK_OPS_ROOT="${SCRIPT_DIR:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

if [[ -f "${HOME}/.zshenv" ]]; then
  source "${HOME}/.zshenv" 2>/dev/null
fi

cd "${STACK_OPS_ROOT}" || exit 1
exec node src/router/ask.mjs --dry-run --text "$1"
