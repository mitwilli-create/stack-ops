# Task 2: reject hard-linked identifier selection files

Done = `readRequestedIds` rejects a mode-0600 regular file when its link count
is not exactly one, and the focused test proves the behavior red before the
production change and green after it.

Constraints:

- Extend the existing `requested identifiers require one stable private
  canonical identifier per line` test with a real filesystem hard link.
- Exercise `readRequestedIds` itself, not a synthetic helper.
- Enforce exactly one hard link while preserving the existing before/opened/
  after stability checks and generic error text.
- Make the smallest local change in `scripts/memory-sweep/stray-drain.mjs` and
  `scripts/memory-sweep/stray-drain.test.mjs` only.
- Run the named test red before the source edit, then green, then run the whole
  `stray-drain.test.mjs` file.
- Do not alter the already-approved post-commit change.
- Do not commit, push, reset, checkout, rebase, merge, stash, install dependencies,
  invoke hosted review, ask questions, or spawn agents.

