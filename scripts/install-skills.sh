#!/usr/bin/env bash
# install-skills.sh, install the Run-1-ruled skill additions (decision F), the
# collision-safe way. Idempotent: safe to re-run.
#
# SEQUENCING (important): run the skill-spam PRUNE first (D5 rec C1, disable the
# irrelevant marketplace categories) BEFORE adding these, or you deepen the exact
# tool-selection-degrading problem the Run-1 research warned about. Adding 12
# always-loaded skills to an already-120+ set is net-negative without the prune.
#
# What it does:
#   1. Clones mattpocock/skills + obra/superpowers to a stable source dir (once).
#   2. Symlinks ONLY the ledger-chosen skills into ~/.claude/skills, namespaced
#      (mp- / sp-) so nothing collides with Mitchell's existing skills.
#   3. Leaves pattern-borrows (edits to his own skills) to a separate manual pass.
#
# Never deletes or overwrites an existing skill. Prints what it links.
set -euo pipefail

SRC="${SKILL_SRC_DIR:-$HOME/Documents/skill-libraries}"
DEST="$HOME/.claude/skills"
mkdir -p "$SRC" "$DEST"

clone_or_update() {
  local repo="$1" dir="$2"
  if [ -d "$SRC/$dir/.git" ]; then
    echo "[skills] updating $dir"; git -C "$SRC/$dir" pull --ff-only --quiet || true
  else
    echo "[skills] cloning $repo"; git clone --depth 1 --quiet "https://github.com/$repo" "$SRC/$dir"
  fi
}

link_skill() {
  # link_skill <source-skill-path> <dest-name>
  local from="$1" name="$2"
  if [ ! -d "$from" ]; then echo "[skills] SKIP (missing): $from" >&2; return; fi
  if [ -e "$DEST/$name" ] && [ ! -L "$DEST/$name" ]; then
    echo "[skills] SKIP (real dir exists, won't clobber): $name" >&2; return
  fi
  ln -sfn "$from" "$DEST/$name"
  echo "[skills] linked $name -> $from"
}

clone_or_update "mattpocock/skills" "mattpocock-skills"
clone_or_update "obra/superpowers" "superpowers"

# mattpocock (uncapped primitive layer). Namespaced mp- to avoid collisions
# (his existing `code-review` stays; mattpocock's installs as mp-code-review).
MP="$SRC/mattpocock-skills/skills"
for s in domain-modeling grill-with-docs to-spec to-tickets implement \
         diagnosing-bugs writing-great-skills wayfinder codebase-design triage code-review; do
  # mattpocock groups skills under category subdirs; find the skill dir wherever it lives.
  path="$(find "$MP" -maxdepth 3 -type d -name "$s" 2>/dev/null | head -1)"
  [ -n "$path" ] && link_skill "$path" "mp-$s"
done

# obra/superpowers, EXACTLY two (the capped imports). Namespaced sp-.
SP="$SRC/superpowers/skills"
for s in subagent-driven-development test-driven-development; do
  path="$(find "$SP" -maxdepth 3 -type d -name "$s" 2>/dev/null | head -1)"
  [ -n "$path" ] && link_skill "$path" "sp-$s"
done

echo
echo "[skills] done. Pattern-borrows still to apply by hand (see private/skills-ledger.md):"
echo "  - low-cog-interview  <- grilling's 'look it up, don't ask' rule"
echo "  - session-handoff    <- handoff's redaction step + 'suggested skills' section"
echo "  - git-shipping-safety<- verification-before-completion's red-flag-words table"
echo "[skills] then run mattpocock's setup once: (per its README) configure issue tracker + labels."
