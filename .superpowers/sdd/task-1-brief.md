# Task 1: preserve the configured post-commit hook

Done = the existing legacy-hook integration test asserts that an executable
`post-commit` hook under configured `core.hooksPath` runs during a successful
legacy adoption commit, and the focused test is observed failing before any
production-code change.

Constraints:

- First phase is diagnosis only. Edit only
  `scripts/memory-sweep/stray-drain.test.mjs`.
- Extend the existing configured-hooks integration test instead of duplicating
  its full fixture.
- Make the post-commit hook write a unique marker through an environment variable
  and assert that marker exists after the coordinator succeeds.
- Run only that named test and record the exact red output.
- Do not edit production code until the controller explicitly starts phase two.
- Do not commit, push, reset, checkout, rebase, merge, stash, install dependencies,
  invoke hosted review, ask questions, or spawn agents.

