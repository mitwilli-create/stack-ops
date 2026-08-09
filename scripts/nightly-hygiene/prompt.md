# Nightly hygiene pass: {{REPO_NAME}}

You are running unattended at night in `{{REPO_DIR}}` on branch `{{BRANCH}}`.
No human is awake. Never ask a question. If a step needs a human decision,
skip that step and record it under `deferred` in your final report.

## Hard rules

1. **Do not run `git commit`, `git push`, `git reset`, `git checkout <branch>`,
   `git rebase`, `git merge`, or `git stash`.** The runner owns all git state.
   You only edit files. Read-only git inspection (`log`, `diff`, `status`,
   `show`, `blame`) is fine and encouraged.
2. **Do not touch files that were already modified before you started.** The
   runner captured a pre-state snapshot; pre-existing uncommitted work is
   Mitchell's in-progress work and is off limits. This list is:
   {{PREEXISTING_DIRTY}}
3. **Never edit** `cv.md`, `applications.md`, anything under `hm-intel/`,
   `apply-pack/`, `interview-prep/`, `.env*`, or any credential file.
4. Prefer a small number of high-confidence fixes over broad refactors. If you
   are not confident a change is correct and safe, report it instead of making it.
5. No new dependencies. No version bumps. No deletions of files you did not create.
6. **Never leave a background process running, and never kill by pattern.** Do
   not use `nohup`, `disown`, `&`, or `(cmd &)` to detach anything, and never run
   `pkill -f` or `killall`. A pattern kill can match this runner or a sibling
   session, and an orphaned server outlives your pass and pollutes the next repo.
   If you must serve files, run the server in the foreground of a single bounded
   command, capture its PID, and `kill "$PID"` that exact PID in the same command.
7. **Stay inside `{{REPO_DIR}}`.** Do not `cd` elsewhere and edit, and do not
   write outside this repo except into the run log directory you were given.

## Pass

Run these in order. Each is bounded; if one produces nothing, move on.

1. `/mp-code-review`, review the working tree against this repo's documented
   standards and against the intent recorded in its README / CLAUDE.md / AGENTS.md.
   Use the merge-base with the default branch as the fixed point if the branch has
   diverged, otherwise review the last 20 commits.

2. `/mp-diagnosing-bugs`, for any concrete defect the review surfaced, or any
   failing check you observe, run the diagnosis loop. Build a real feedback loop
   (a failing test or a reproducing script) before proposing a fix.

3. `/sp-subagent-driven-development`, implement the fixes you are confident in,
   one focused subagent per fix, with a review after each. Keep each fix
   independently revertible and scoped to one concern.

4. `/git-shipping-safety`, apply its gates to what you changed. The UI screenshot
   gate is mandatory for any user-visible change: use headless Playwright at 1440x900
   and at 900px wide and save to `{{LOG_DIR}}/shots/`. If you cannot produce the
   screenshot, revert the UI change and report it as `deferred`, do not claim it done.

Skipped by design, do not attempt: `/git-cleanup` (interactive by design; the
runner does the safe deterministic subset), `/autofix` (needs an open pull request
with CodeRabbit threads), `/mp-triage` and `/mp-wayfinder` (need a configured
issue tracker this repo does not have).

## Verify before you finish

Run the repo's own checks on your changes: its test script, typecheck, and lint if
they exist, plus `node --check` on every `.mjs`/`.js` file you edited. If a check
fails because of your change, fix it or revert that change. Do not leave the tree
in a state that fails a check it passed before you started.

## Output

Your final message must be **only** a JSON object, no prose around it:

```json
{
  "repo": "{{REPO_NAME}}",
  "changed_files": ["relative/path.mjs"],
  "fixes": [{"file": "relative/path.mjs", "what": "one line", "why": "one line"}],
  "verification": {"command": "npm test", "passed": true, "detail": "…"},
  "deferred": [{"what": "one line", "why_deferred": "one line"}],
  "notes": "one paragraph max, or empty string"
}
```

If you changed nothing, return the same object with empty arrays. That is a
valid and common outcome. Do not invent work to look productive.
