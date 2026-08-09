# Plan: instance shipping automation

Done = the coordinator tests pass and a dry-run against the live Documents
tree produces receipts without mutating an active worktree.

## 1. Add the activity and ownership model

- Add pure functions for activity signal normalization, exact threshold
  classification, lease ownership, and adoption eligibility.
- Add tests at 44:59, 45:00, 5:59:59, 6:00:00, active process, active check,
  and stale process cases.

## 2. Add the deterministic Git action layer

- Add explicit-path status snapshots, path guards, checkpoint commits, feature
  branch creation, fast-forward push, and draft pull request command builders.
- Keep the current tree intact on every failed action.
- Add tests for active dirty protection, dormant owned checkpointing, abandoned
  solo-owner adoption, default-branch branching, conflict receipts, secret
  rejection, and no force-push.

## 3. Add the in-session coordinator

- Add an idempotent observer with a run lock, bounded per-worktree actions,
  atomic leases, and append-only receipts.
- Add `--dry-run`, `--once`, `--repo`, and `--status` modes.
- Ensure a failed provider or GitHub command produces a reasoned receipt and
  does not get reported as a successful no-op.

## 4. Add provider failover integration

- Define the command contract consumed by the existing provider failover agent.
- Configure the nightly and in-session runners to use the same subscription-
  first adapter.
- Test the August 8 weekly-limit response and verify the next candidate is
  attempted with bounded failure metadata.

## 5. Add deploy manifests and launchd integration

- Add manifest validation, verification, deploy, and live-check execution.
- Add a short-interval launchd template and install/check commands without
  changing launchd state during repository development.
- Add a dry-run that discovers the configured worktrees but cannot mutate them.

## 6. Integrate every local client

- Add the shared heartbeat bridge and optional session wrapper.
- Add the Claude Code hook through the existing settings merge installer.
- Verify Codex, Antigravity, and Grok coverage through process observation and
  wrapper smoke tests because their current local help surfaces expose no hook.

## 7. Verify and hand off

- Run the focused coordinator tests, the full `npm test`, and the prose gate.
- Run a dry-run against the live tree and inspect the receipt artifact.
- Report the remaining external installation step separately because the
  current stack-ops checkout and the live launchd files are shared state.
