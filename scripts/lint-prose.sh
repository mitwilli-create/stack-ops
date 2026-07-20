#!/usr/bin/env bash
# Prose + character gate for stack-ops.
#
# Two INDEPENDENT mechanisms that must both agree. This is deliberate.
# On 2026-07-20 Vale reported 3 em dashes in a file that actually had 11
# (its Markdown parser drops matches inside soft-wrapped blocks containing
# inline code spans; fixed with scope: raw, but the lesson stands). The only
# reason that was caught is that a dumb grep disagreed with it. A single
# checker you cannot audit is the failure mode, not the gate.
#
# Vale covers md/mdc/txt only, so the grep is also the ONLY enforcement on
# code comments, YAML, and shell scripts.
#
# Usage: scripts/lint-prose.sh
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2
status=0

# EmDash.yml legitimately contains the banned characters: they are its tokens.
EXCLUDE_RE='^styles/VoiceOS/EmDash\.yml$'

echo "==> 1/3  Vale (prose: md, mdc, txt)"
if command -v vale >/dev/null 2>&1; then
  vale --glob='!node_modules/**' . || status=1
else
  echo "    vale not installed. Run: brew install vale" >&2
  status=1
fi

echo "==> 2/3  byte-level dash grep (ALL tracked file types)"
hits=0
while IFS= read -r f; do
  case "$f" in private/*) continue ;; esac
  [[ "$f" =~ $EXCLUDE_RE ]] && continue
  [ -f "$f" ] || continue
  if LC_ALL=C grep -Hn $'\xe2\x80\x94\|\xe2\x80\x93' "$f"; then
    hits=$((hits + 1))
  fi
done < <(git ls-files)
if [ "$hits" -gt 0 ]; then
  echo "    $hits file(s) contain em/en dashes. Banned in outward materials." >&2
  echo "    House style: restructure, never glyph-swap. A spaced ' - ' is still a tell." >&2
  status=1
else
  echo "    clean"
fi

echo "==> 3/3  AntiSlop rule in sync with the Voice OS banned list"
node scripts/gen-antislop.mjs --check || status=1

if [ "$status" -eq 0 ]; then
  echo "PASS: prose gate clean."
else
  echo "FAIL: prose gate. Fix the above, or commit with --no-verify if you mean it." >&2
fi
exit "$status"
