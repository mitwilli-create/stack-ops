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

## Scheduled transcript drain

`stray-drain.mjs` discovers quiet, unclaimed top-level Claude JavaScript Object
Notation Lines (JSONL) transcripts from
metadata only. It excludes the current session, files modified inside the configured
45-minute quiet interval, symlinks, nested subagent records, and project roots without
a direct memory symlink into the canonical vault. The Claude-config drainer then
claims each identifier before reading content, scans the complete input before a
provider call, writes through the append-only hardlink placement primitive, and emits
one metadata-only disposition.

The cheap route always runs with `CHEAP_NO_ESCALATE=1`. Exhausted cheap models cannot
silently invoke a metered frontier model. Privacy, policy, input, and authorization
failures stop. Eligible operational failures may advance only through the approved
subscription route recorded by the drainer.

The scheduler validates every progress row, scans each complete record again, and
stages only private untracked paths returned by that run. The vault commit holds the
shared wrap lock and uses `git commit --only` with the exact path list. A failed commit
quarantines the exact records and releases their claims before the same lock is
released. A successful commit becomes complete only after the drainer records and the
scheduler verifies one exact `captured` disposition per committed record.

Before child processing, the scheduler creates a private transaction owner receipt and
an empty placement journal. The drainer records claim intent before claiming, exact
claim-acquisition proof after claiming, placement intent before placing, and exact
placement proof after placing. Startup recovery runs under the vault lock and uses that
journal to release only a proven dead acquired claim, recover an exact intent-only or
placed-only record, finish captured disposition writes, or resume a recoverable
rollback. A claim intent without acquisition proof remains an explicit `unproven`
blocker and is never released automatically. Conflicting progress, intent, placement,
path, or hash proof is never eligible for materialization or commit. If one selected
transcript remains missing or retryable, every complete typed row is still reconciled
and any conflict-free placed records are committed safely, but the run remains
explicitly incomplete. A durable retirement marker links that incomplete receipt to its
verified rollback or finalization before the startup and pending-transaction censuses
consider the transaction resolved.

```sh
# Install or refresh the macOS Tahoe nohup-wrapper LaunchAgent.
~/Documents/stack-ops/scripts/install-stray-drain-launchd.zsh

# Metadata census only. No claim, model, vault, or Git write.
node ~/Documents/stack-ops/scripts/memory-sweep/stray-drain.mjs --dry-run

# Bounded production run using the configured maximum.
node ~/Documents/stack-ops/scripts/memory-sweep/stray-drain.mjs
```

The scheduler runs at 01:30 and 13:30 Pacific time. The installer renders a private
runtime wrapper under `~/.local/stack-ops`, validates the property list, and reloads
the LaunchAgent. The wrapper detaches the bounded coordinator through `nohup`, which
prevents long launchd jobs from flapping on macOS Tahoe. The coordinator receives a
clean environment containing only basic process variables and the cheap-lane
credential; unrelated GUI-domain credentials are not inherited.

Raw transcripts are never deleted. Retryable outcomes retain the raw source and release
their claim. Terminal no-record outcomes require a durable metadata-only disposition.
The current run log is under `~/Library/Logs/stack-ops/stray-drain/`.

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
