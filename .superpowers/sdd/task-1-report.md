# Task 1 report

Assumption: the existing `legacy commit-msg hook runs before an exact durable commit` fixture is the configured-hooks integration test to extend, because it configures `core.hooksPath` and exercises a successful legacy adoption commit.

Focused command:

```sh
node --test --test-name-pattern='legacy commit-msg hook runs before an exact durable commit' scripts/memory-sweep/stray-drain.test.mjs
```

Red output summary: 1 test run, 0 passed, 1 failed. The new assertion at `scripts/memory-sweep/stray-drain.test.mjs:2639` expected the post-commit marker file to exist after successful legacy adoption, but received `false !== true`.

GREEN evidence:

```sh
node --test --test-name-pattern='legacy commit-msg hook runs before an exact durable commit' scripts/memory-sweep/stray-drain.test.mjs
```

Result: 1 test run, 1 passed, 0 failed (exit 0).

```sh
node --test scripts/memory-sweep/stray-drain.test.mjs
```

Result: 58 tests run, 58 passed, 0 failed (exit 0).

Files changed:

- `scripts/memory-sweep/stray-drain.mjs`
- `scripts/memory-sweep/stray-drain.test.mjs`
- `.superpowers/sdd/task-1-report.md`

Self-review: the hook command uses Git's configured hook resolution via `git hook run --ignore-missing post-commit`, has no positional hook arguments, appears immediately after `update-ref HEAD`, and ends with `|| true`. Therefore a missing or failing notification hook cannot roll back or turn the already-installed commit into a coordinator failure. The existing configured-hooks integration fixture proves the successful-hook path.
