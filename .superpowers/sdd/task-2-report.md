# Task 2 report

Controller repro before dispatch: an actual mode-0600 file with a second hard
link was accepted, causing `assert.throws(() => readRequestedIds(path))` to fail
with `Missing expected exception`.

## TDD evidence

### RED, before production edit

```sh
node --test --test-name-pattern='requested identifiers require one stable private canonical identifier per line' scripts/memory-sweep/stray-drain.test.mjs
```

Result: exit 1, 0 passed and 1 failed. The new real-hard-link assertion failed
with `AssertionError [ERR_ASSERTION]: Missing expected exception`, demonstrating
that `readRequestedIds` accepted the mode-0600 file whose link count was two.

### GREEN, after production edit

```sh
node --test --test-name-pattern='requested identifiers require one stable private canonical identifier per line' scripts/memory-sweep/stray-drain.test.mjs
```

Result: exit 0, 1 passed and 0 failed.

```sh
node --test scripts/memory-sweep/stray-drain.test.mjs
```

Result: exit 0, 58 passed and 0 failed.

```sh
git diff --check -- scripts/memory-sweep/stray-drain.mjs scripts/memory-sweep/stray-drain.test.mjs
```

Result: exit 0 with no whitespace errors.

During the first post-edit run, a later existing in-test case failed because the
new hard-link fixture still existed and therefore changed the original file's
link count. Added `unlinkSync(hardLink)` immediately after the regression
assertion, then reran both green commands above. This cleanup does not change
the regression condition.

## Files changed

- `scripts/memory-sweep/stray-drain.mjs`: reject a requested identifier file
  unless its pre-open `nlink` is exactly `1n`.
- `scripts/memory-sweep/stray-drain.test.mjs`: create a real hard link with
  `linkSync`, prove `nlink` is two, call `readRequestedIds` directly, require
  its generic rejection, and remove the fixture.
- `.superpowers/sdd/task-2-report.md`: this evidence record.

## Self-review

- The new `before.nlink !== 1n` predicate fails closed for any missing or
  non-bigint link count and preserves the existing generic error path.
- Existing before/opened/after `stableFileStat` checks remain unchanged and
  continue to compare `nlink`, so an aliasing change during the read is still
  rejected.
- The Task 1 post-commit-hook diff was not modified.
