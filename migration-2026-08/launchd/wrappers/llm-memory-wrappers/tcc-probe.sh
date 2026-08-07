#!/bin/bash
exec > ~/.local/llm-memory-wrappers/tcc-probe.log 2>&1
echo "--- can launchd read ~/Documents at all?"
ls ~/Documents/llm-memory >/dev/null 2>&1 && echo "  Documents: READABLE" || echo "  Documents: BLOCKED (TCC)"
echo "--- can it read ~/.claude?"
ls ~/.claude/projects >/dev/null 2>&1 && echo "  .claude: READABLE" || echo "  .claude: BLOCKED"
echo "--- can it read ~/.local?"
ls ~/.local >/dev/null 2>&1 && echo "  .local: READABLE" || echo "  .local: BLOCKED"
echo "--- node on PATH? PATH=$PATH"
command -v node || ls /opt/homebrew/bin/node /usr/local/bin/node ~/.nvm/versions/node/*/bin/node 2>/dev/null | head -3
