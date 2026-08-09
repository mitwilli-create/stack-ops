# Nightly hygiene

Runs at 02:00 PT every night. Walks every git repo under `~/Documents`, reviews
and fixes what it safely can, then commits and pushes. You read one report in the
morning at `~/Library/Logs/stack-ops/nightly-hygiene/latest-report.md`.

## What it does per repo

1. **Branch prune.** `git fetch --prune`, then deletes local branches that are
   both fully merged into the default branch and whose upstream is gone. Never
   the current branch, never the default branch, never an unmerged branch.
2. **Review and fix.** A headless Claude pass running `/mp-code-review`,
   `/mp-diagnosing-bugs`, `/sp-subagent-driven-development` and the
   `/git-shipping-safety` gates.
3. **Verify.** `node --check` on every JavaScript file it touched, plus the
   repo's own `test` / `typecheck` / `lint` script if one exists.
4. **Screen.** Every file it wants to commit goes through `guards.mjs`: path
   denylist (`cv.md`, `applications.md`, `hm-intel/`, `apply-pack/`, `.env*`,
   keys, credentials) and a content scan for secret shapes.
5. **Commit and push** to the repo's current branch.

If the Claude subscription returns a weekly-limit, quota, credential, or
provider-availability failure before edits begin, the runner invokes the
configured subscription-first provider failover adapter with the same prompt
and repository. The receipt records each attempted provider and resolved model.
If the adapter is missing or fails, the repo is held with that reason. It is
never reported as a clean no-op.

Any failure after step 2 reverts that repo's job-made changes and moves on. One
bad repo never blocks the other fourteen.

## What it deliberately does not do

- **It does not commit your existing uncommitted work.** It commits only files it
  changed itself. Your ~500 dirty files stay dirty and are listed in the report.
  This is the personal-data leak path, so it is off by default. Flip
  `commitPreexistingDirty` in `config.json` if you want it.
- **It does not push feature branches to `main`.** It pushes each repo to its own
  current branch. Ten repos are on `main`/`master`, so for those it is a push to
  main. Four are on active feature branches and push there.
- **It skips four of the eight skills you named, by design:**

  | Skill | Why it is skipped |
  |---|---|
  | `/git-cleanup` | `disable-model-invocation: true`, and its own docs say it is not designed for headless automation (two user-confirmation gates). Step 1 above is its safe deterministic subset. |
  | `/autofix` | Disabled for hosted-review threads. Use local QA and local review skills; nothing runs unattended. |
  | `/mp-triage` | Needs a configured issue tracker (`/mp-setup-skills`). Not set up in these repos. |
  | `/mp-wayfinder` | Same, plus it exists to surface decisions for you to make. |

  Wiring up `/mp-setup-skills` in a repo would let triage and wayfinder join.

- **It never deletes a squash-merged branch.** `git branch -d` refuses those and
  `-D` is not safe unattended. The report lists them with a ready-to-paste `-D`
  command.

The in-session coordinator in `scripts/instance-shipping/` handles work that
becomes dormant while an instance is running. Nightly hygiene remains the
overnight sweep and does not adopt pre-existing dirty work by itself.

## Billing

Invoked through `/Users/mitchellwilliams/.claude/bin/claude`, the wrapper that
strips `ANTHROPIC_API_KEY` so the run draws the Max subscription and not the
metered API. The runner also blanks that variable in the child environment as a
second layer. **Do not change this to a bare `claude`.**

Open risk: the 2026-08-06 finding that Claude Code billed the API despite the
wrapper (`hasAvailableSubscription: false` plus an approved custom key). Until
that is closed, check the first week's spend rather than assuming it is free.

### Billing preflight, fail closed

Standing rule: subscription first, API spend only after an explicit ruling. The
run therefore refuses to start unless all three hold:

1. `claudeBin` exists.
2. That file actually contains `env -u ANTHROPIC_API_KEY`, so a bare `claude`
   swapped in by mistake is caught rather than billed.
3. A subscription credential is present in the keychain (existence check only,
   `security find-generic-password` without `-w`, so no secret is ever read).

If any fail, nothing runs and `latest-report.md` says why. There is no automatic
fallback to metered API spend: the whole point is that a job you are asleep for
cannot decide to start charging you.

## Operating it

```sh
# Install (one time)
mkdir -p ~/Library/Logs/stack-ops/nightly-hygiene
cp ~/Documents/stack-ops/scripts/launchd/com.mitchell.stack-ops.nightly-hygiene.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mitchell.stack-ops.nightly-hygiene.plist

# Read this morning's report
cat ~/Library/Logs/stack-ops/nightly-hygiene/latest-report.md

# Dry run right now: does everything, commits and pushes nothing, reverts all
node ~/Documents/stack-ops/scripts/nightly-hygiene/nightly-hygiene.mjs --dry-run

# One repo only
node ~/Documents/stack-ops/scripts/nightly-hygiene/nightly-hygiene.mjs --repos=voice-os

# Commit locally but do not push
node ~/Documents/stack-ops/scripts/nightly-hygiene/nightly-hygiene.mjs --no-push

# Turn it off for a night
launchctl bootout gui/$(id -u)/com.mitchell.stack-ops.nightly-hygiene

# Run the guard tests
node --test ~/Documents/stack-ops/scripts/nightly-hygiene/guards.test.mjs
```

## Undoing a night

Every commit is titled `chore: nightly hygiene pass YYYY-MM-DD` and its body
records the base commit it started from.

```sh
# See what last night did in a repo
git -C ~/Documents/<repo> log --oneline --grep="nightly hygiene"

# Undo the most recent one, keeping the changes as uncommitted files
git -C ~/Documents/<repo> reset --soft HEAD~1

# Undo it on the remote too (rewrites history, only for a commit nobody pulled)
git -C ~/Documents/<repo> push --force-with-lease
```

## Files

| Path | What |
|---|---|
| `nightly-hygiene.mjs` | The runner |
| `guards.mjs` | Secret and personal-data screen |
| `guards.test.mjs` | Planted-input tests for the screen |
| `prompt.md` | The per-repo instructions given to the headless pass |
| `config.json` | Repos, timeouts, model, toggles |
| `../launchd/com.mitchell.stack-ops.nightly-hygiene.plist` | The schedule |
| `~/Library/Logs/stack-ops/nightly-hygiene/` | Reports and per-run logs |
