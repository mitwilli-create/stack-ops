# Memory sweep

Reasoning-based maintenance of the memory vault, four times a day at 04:00, 10:00,
16:00 and 22:00 PT. Keeps `MEMORY.md` under budget, merges duplicate fact files,
and digests old session records, so memory stays useful instead of just growing.

Read one file to see what happened:
`~/Library/Logs/stack-ops/memory-sweep/latest-report.md`

## The trust property

**The model never writes to the vault.** It is given the current state and returns
a plan made of typed operations. This script validates each one and does the file
work itself. An operation the validator cannot accept does not happen.

| Operation | What it does |
|---|---|
| `merge_facts` | Consolidates duplicates into one canonical file. The originals become tombstones pointing at it, so every existing `[[link]]` still resolves. Never deletes. |
| `supersede` | Marks one fact replaced by another, keeping both files. |
| `rewrite_index` | Rewrites `MEMORY.md` or `SESSIONS.md`. Rejected unless every pointer resolves and the result is under target. |
| `compact_sessions` | Digests a project's session records for one month, then removes the originals from the worktree. |

## What makes it safe to run unattended

- **Eligibility.** A file is touched only if it is TRACKED and CLEAN in git.
  Untracked files are not recoverable if a merge is wrong. Dirty files belong to
  one of the 10 to 30 concurrent sessions writing this vault. Both are skipped and
  named in the report.
- **Git is the undo.** Every project commits separately as
  `memory-sweep(<project>)`. The runner refuses to start if the vault is not a git
  repo, because history is the only undo mechanism.
- **Session compaction deletes only what git holds.** Verified per record at
  validation time, not assumed.
- **Secret scan** on every candidate body before it reaches disk, fail closed if
  the scanner cannot run.
- **Post-verify.** After applying, `MEMORY.md` pointers must all resolve or the
  whole project is reverted.
- **Billing preflight, fail closed.** Refuses to run unless the subscription path
  verifies. Never falls back to metered API spend.

## TCC, the thing that blocked this for a month

TCC grants are **per binary**. Under launchd, `/bin/zsh` is DENIED read and list on
`~/Documents`; `node` at its absolute path is GRANTED, and `git` and `claude`
spawned from it inherit the grant. Probed and verified 2026-08-06.

This disproves the premise in `~/.local/llm-memory-wrappers/weekly.sh` that launchd
"cannot read ~/Documents at all", which is why vault maintenance was never
scheduled. The plist invokes `node` directly. **Do not wrap it in a shell**, that
reintroduces the denial.

## Cost

Pilot measured $0.38 to $0.53 per project. Sweeping all 15 four times a day would
be roughly $27/day, so a project whose memory has not moved since its last sweep is
skipped and costs nothing, with a forced pass after 168h so nothing hides behind
"unchanged" forever. Typical runs touch 1 to 3 projects. `sweepCostCapUsd` bounds
the worst case, and the report prints the run's spend.

## Operating it

```sh
# See what the last run did
cat ~/Library/Logs/stack-ops/memory-sweep/latest-report.md

# Plan across all projects, apply nothing
node ~/Documents/stack-ops/scripts/memory-sweep/memory-sweep.mjs --dry-run

# One project, or one layer
node ~/Documents/stack-ops/scripts/memory-sweep/memory-sweep.mjs --projects=stack-ops
node ~/Documents/stack-ops/scripts/memory-sweep/memory-sweep.mjs --layers=indices

# Turn it off
launchctl bootout gui/$(id -u)/com.mitchell.stack-ops.memory-sweep
```

## Undoing a sweep

```sh
git -C ~/Documents/llm-memory log --oneline --grep="memory-sweep" -20
git -C ~/Documents/llm-memory revert <sha>
```

Each project is its own commit, so one bad merge reverts without disturbing the rest.

## Known limits

- **Untracked fact files are never swept.** As of 2026-08-06 there were 10,
  including `claude-subscription-before-api-key.md` and
  `openai-subscription-before-api.md`, which are exactly the duplicate-rule
  proliferation this tool exists to fix. Commit them to bring them into scope.
- The sweep does not touch `identity-and-profile/` or `operating-docs/`. Those are
  hand-maintained and were out of scope for the first version.
