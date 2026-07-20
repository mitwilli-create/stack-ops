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

echo "==> 1/4  Vale (prose: md, mdc, txt)"
if command -v vale >/dev/null 2>&1; then
  vale --glob='!node_modules/**' . || status=1
else
  echo "    vale not installed. Run: brew install vale" >&2
  status=1
fi

echo "==> 2/4  byte-level dash grep (ALL tracked file types)"
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

echo "==> 3/4  AntiSlop rule in sync with the Voice OS banned list"
node scripts/gen-antislop.mjs --check || status=1

# ---------------------------------------------------------------------------
# 4. Self-test: does the gate actually FAIL on bad input?
#
# Steps 1-3 all pass on a clean tree whether or not the rule enforces anything.
# That is not hypothetical. AntiSlop.yml shipped at level: warning through
# 2026-07-20, Vale exits 0 when only warnings fire, and this script printed
# every violation and then reported PASS. Two separate sessions "verified" the
# fix against a clean tree and were wrong both times. A clean pass proves
# nothing about a matcher; only a known-bad input does.
#
# The probe is DERIVED from the committed rule, never hardcoded, so that
# editing the banned list can never turn this check into a silent no-op.
# It asserts two distinct things:
#   a) a banned word produces a nonzero exit  (catches level: warning)
#   b) a typographic apostrophe still matches (catches unflexed apostrophes,
#      since Vale's existence matcher does not normalize U+2019 to U+0027)
# ---------------------------------------------------------------------------
echo "==> 4/4  self-test: gate must fail on known-bad input"
RULE='styles/VoiceOS/AntiSlop.yml'
PROBE='antislop-selftest.probe.md'
trap 'rm -f "$PROBE"' EXIT

if ! command -v vale >/dev/null 2>&1; then
  echo "    skipped: vale not installed (already failed in step 1)" >&2
elif [ ! -f "$RULE" ]; then
  echo "    $RULE missing. Run: node scripts/gen-antislop.mjs" >&2
  status=1
else
  # First single-word token, with its morphology group stripped: 'robust'.
  bad_word=$(sed -n "s/^  - '\([a-z][a-z-]*\)(s|es|ed|ing|ly)?'$/\1/p" "$RULE" | head -1)
  # First apostrophe-flexed token, rendered with a typographic apostrophe.
  # The committed token reads: 'please don[''’]t hesitate to reach out'
  bad_quote=$(sed -n "s/^  - '\(.*\[''’\].*\)'$/\1/p" "$RULE" | head -1 | sed "s/\[''’\]/’/g")

  if [ -z "$bad_word" ] || [ -z "$bad_quote" ]; then
    echo "    cannot derive a probe from $RULE (word='$bad_word' quote='$bad_quote')." >&2
    echo "    The self-test would be a no-op, which is the bug it exists to catch." >&2
    status=1
  else
    printf 'This %s approach.\n\n%s.\n' "$bad_word" "$bad_quote" > "$PROBE"
    probe_out=$(vale --output=line "$PROBE" 2>&1)
    probe_rc=$?
    # --output=line prints file:line:col:Rule:Message with no severity field,
    # so count rule hits here and let the exit code carry severity: vale exits
    # 0 when only warnings fire, which is precisely the level: warning bug.
    n_hits=$(printf '%s\n' "$probe_out" | grep -c ':VoiceOS\.AntiSlop:' || true)

    if [ "$probe_rc" -eq 0 ]; then
      echo "    BROKEN: probe containing '$bad_word' and a typographic apostrophe" >&2
      echo "    passed with exit 0. The gate is enforcing nothing." >&2
      echo "    Check 'level:' in the template inside scripts/gen-antislop.mjs" >&2
      echo "    (not in the generated $RULE), then regenerate." >&2
      printf '%s\n' "$probe_out" >&2
      status=1
    elif [ "$n_hits" -lt 2 ]; then
      echo "    BROKEN: probe exited $probe_rc but flagged $n_hits hit(s), expected 2." >&2
      echo "    One of the two mechanisms is dead. Likely the apostrophe flex:" >&2
      echo "    Vale does not normalize U+2019, so tokens must carry a character class." >&2
      printf '%s\n' "$probe_out" >&2
      status=1
    else
      echo "    ok: '$bad_word' + typographic apostrophe -> exit $probe_rc, $n_hits hits"
    fi
  fi
fi
rm -f "$PROBE"
trap - EXIT

if [ "$status" -eq 0 ]; then
  echo "PASS: prose gate clean."
else
  echo "FAIL: prose gate. Fix the above, or commit with --no-verify if you mean it." >&2
fi
exit "$status"
