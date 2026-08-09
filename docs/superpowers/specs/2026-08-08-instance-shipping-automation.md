# Instance shipping automation

Status: design approved for implementation
Date: 2026-08-08

## Outcome

While an agent instance is working, a local coordinator observes every configured
repository and worktree. It checkpoints, verifies, publishes, reconciles, and
deploys work at bounded points without requiring Mitchell to remember Git
hygiene. It never overwrites a live instance, force-pushes, deletes work, or
pushes a default branch directly.

The coordinator is a control plane. It does not move files into archive or
quarantine folders. Recovery comes from ordinary Git commits, reflogs, remote
branches, and append-only receipts.

## Activity state

The thresholds are canonical and replace earlier repository-activity thresholds:

| State | Condition | Automatic behavior |
| --- | --- | --- |
| `active` | Live activity observed within the last 45 minutes | Observe only. Do not edit, commit, rebase, push, or deploy that worktree. |
| `dormant` | No live activity for at least 45 minutes and less than 6 hours | Inspect. Checkpoint only if the worktree has a current coordinator lease or explicit owner. Do not adopt an unknown branch yet. |
| `abandoned` | No live activity for at least 6 hours | A configured solo repository owner may adopt an unowned feature branch after the no-process and no-CI checks pass. |

Live activity is evidence, not a file timestamp alone. The observer records the
latest timestamp from these signals:

1. A coordinator lease or agent heartbeat that has not expired.
2. A running agent, test, build, deploy, or Git process whose working directory
   is the worktree and which has produced recent output or a heartbeat.
3. A file write, index change, or commit attributable to the current worktree.
4. An open interactive session registered for the worktree.
5. Active continuous integration or deployment for the branch.
6. An explicit operator heartbeat.

The receipt records each signal and its source timestamp. A stale process with
no output is not sufficient to keep work active indefinitely. A process that is
still running blocks adoption until it exits or is proven stale by a separate
process-liveness rule.

## Ownership and dirty work

Ownership is a lease over a worktree and branch, not an assumption from the
folder name. Leases are written atomically under the coordinator state
directory and contain instance id, process id, repository, worktree, branch,
last heartbeat, and expiry.

The decision table is:

| Worktree condition | Action |
| --- | --- |
| Active, dirty, any owner | Observe and report only. |
| Dormant, dirty, coordinator-owned | Guard the changed paths, create a checkpoint commit, verify it, and push the feature branch. |
| Dormant, dirty, unowned | Record a candidate. Do not edit it. |
| Abandoned, dirty, unowned feature branch in a configured solo-owned repository | Claim a lease, re-read the tree, guard the changed paths, checkpoint, verify, and publish. |
| Abandoned, dirty default branch | Create an agent-owned feature branch while preserving the dirty tree, then checkpoint and publish that feature branch. |
| Any branch with a live process, active continuous integration, active deployment, unresolved conflict, or protected-branch restriction | Do not adopt or reconcile. Write a receipt with the exact reason and preserve the branch. |

This answers the dirty-tree question directly: yes, the owner of a configured
solo repository may work on a dirty, unowned feature branch after six hours of
verified inactivity. The owner check permits adoption; the six-hour absence of
live activity prevents stepping on a concurrent instance. A dirty tree is not
itself a blocker. A live owner is.

## Publication and reconciliation

Publication is a small state machine:

```text
observe -> classify -> acquire lease -> guard paths -> checkpoint
  -> verify -> push feature branch -> open or update draft pull request
  -> deploy when manifest policy allows -> live check -> receipt
```

Rules:

- A default branch is never published by the coordinator. If it contains
  publishable work, create an agent-owned feature branch first.
- An owned feature branch may be pushed automatically after verification.
- A draft pull request may be opened or updated automatically for an owned
  feature branch. The explicit repository and remote are recorded before the
  command runs.
- Protected default branches continue through their existing pull request and
  merge-queue path. The coordinator may prepare the pull request but does not
  bypass branch protection.
- Rebase is allowed only after the work is checkpointed and the lease is held.
  A rebase conflict produces a receipt and leaves both the checkpoint commit
  and branch intact. It does not create a second copy of the tree.
- Push uses the ordinary fast-forward path. Force-push is never an automatic
  action.

## Deployment

Each deployable repository opts in with a small local manifest at
`.stack-ops/deploy.json`:

```json
{
  "verify": ["npm test"],
  "deploy": ["./scripts/deploy.sh"],
  "liveCheck": ["curl -fsS https://example.invalid/health"],
  "branches": ["agent/*", "codex/*", "claude/*"],
  "autoDeploy": true
}
```

The real manifest must use repository-owned commands and URLs. The example is
schema only and is never executable. A deploy requires a verified checkpoint,
an owned agent branch, a green verification result, a matching branch policy,
and a successful live check. A failed live check records the deployment and
stops subsequent automated publication for that branch until the next verified
checkpoint.

## Provider failure handling

The coordinator calls the existing subscription-first provider failover
adapter through a configured command boundary. A weekly limit, quota,
credential, timeout, circuit, unavailable-provider, or malformed-response
failure advances to the next eligible subscription candidate. Policy, privacy,
input, authorization, and uncertain mid-edit failures stop the current action.
Metered application programming interface keys are never introduced as a
silent fallback.

Every attempt receipt exposes requested slot, resolved model, provider, account
type, and a bounded failure code. The nightly runner and the in-session runner
use the same adapter so the August 8 Claude weekly-limit failure becomes a
fallback event rather than a false-looking no-op.

## Runtime and artifacts

The control plane has two triggers:

- A short-interval launchd observer for worktree discovery, lease expiry,
  checkpoint eligibility, and deployment.
- Agent session and tool-use heartbeats for immediate activity updates during an
  instance.

All four local clients use the same bridge: Claude Code receives a write-tool
hook, while Codex, Antigravity, and Grok use process working-directory
observation plus the optional session wrapper because their current command
surfaces expose no lifecycle hook. The publication policy does not vary by
provider.

The observer is idempotent. A second observer exits without mutation when the
run lock is held. State and receipts live outside repositories:

```text
~/Library/Application Support/stack-ops/instance-shipping/state/
~/Library/Logs/stack-ops/instance-shipping/receipts.jsonl
```

The repository receives only an opt-in deployment manifest. No archive copy,
stash folder, quarantine folder, or broad backup tree is created.

## Non-goals and permanent boundaries

- Do not auto-commit denied personal-data paths or secret-like content.
- Do not force-push, delete branches, reset a dirty tree, or overwrite another
  active worktree.
- Do not run metered review or quality tools automatically. Quality gates are
  local and deterministic unless Mitchell explicitly enables a hosted run.
- Do not infer ownership from recency, branch naming, or repository ownership
  without the six-hour adoption and no-live-process checks.

## Verification signals

The implementation is complete when tests demonstrate:

- exact 45-minute and 6-hour boundary classification;
- active dirty work is untouched;
- dormant owned dirty work checkpoints and pushes;
- abandoned unowned feature work can be adopted by a configured repository
  owner;
- abandoned default-branch work branches before publication;
- active process, continuous integration, deployment, conflict, protected
  branch, denied path, and secret-like content each stop the relevant mutation;
- provider weekly-limit failure advances to the next subscription candidate;
- deployment runs only after verification and live-check success;
- receipts identify every attempted mutation and its outcome.

## Research basis

- [Git worktree documentation](https://git-scm.com/docs/git-worktree.html)
- [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches)
- [GitHub merge queue](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue)
- [GitHub Actions concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [Claude Code command-line usage](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
