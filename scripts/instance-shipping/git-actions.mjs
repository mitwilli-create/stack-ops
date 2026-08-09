import { spawnSync } from 'node:child_process';
import { screen } from '../nightly-hygiene/guards.mjs';

function runGit(repoDir, args) {
  const result = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function requireGit(repoDir, args) {
  const result = runGit(repoDir, args);
  if (!result.ok) {
    const detail = (result.stderr || result.stdout || 'git command failed').trim();
    throw new Error(`git ${args.join(' ')}: ${detail}`);
  }
  return result.stdout.trim();
}

export function parseStatusPaths(output) {
  const paths = [];
  const records = output.split('\0').filter(Boolean);
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.length < 3) continue;
    const code = record.slice(0, 2);
    paths.push(record.slice(3));
    if ((code.includes('R') || code.includes('C')) && i + 1 < records.length) {
      paths.push(records[++i]);
    }
  }
  return [...new Set(paths)];
}

export function listChangedPaths(repoDir, runner = runGit) {
  const result = runner(repoDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!result.ok) throw new Error(`cannot inspect worktree: ${result.stderr.trim()}`);
  return parseStatusPaths(result.stdout);
}

export function listStagedPaths(repoDir, runner = runGit) {
  const result = runner(repoDir, ['diff', '--cached', '--name-only', '-z']);
  if (!result.ok) throw new Error(`cannot inspect index: ${result.stderr.trim()}`);
  return result.stdout.split('\0').filter(Boolean);
}

export function currentBranch(repoDir, runner = runGit) {
  return requireGitWithRunner(repoDir, ['branch', '--show-current'], runner);
}

function requireGitWithRunner(repoDir, args, runner) {
  const result = runner(repoDir, args);
  if (!result.ok) throw new Error(`git ${args.join(' ')}: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

export function defaultBranch(repoDir, runner = runGit) {
  const remoteHead = runner(repoDir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead.ok && remoteHead.stdout.trim()) return remoteHead.stdout.trim().replace(/^origin\//, '');
  const branch = currentBranch(repoDir, runner);
  if (branch === 'main' || branch === 'master') return branch;
  return 'main';
}

export function checkpointWorktree({ repoDir, message, runner = runGit }) {
  const stagedBefore = listStagedPaths(repoDir, runner);
  if (stagedBefore.length > 0) {
    return {
      committed: false,
      held: true,
      reason: 'index already contains staged paths from another action',
      paths: [],
    };
  }

  const changed = listChangedPaths(repoDir, runner);
  if (changed.length === 0) {
    return { committed: false, held: false, reason: 'worktree is clean', paths: [] };
  }
  const screened = screen(repoDir, changed);
  if (screened.allowed.length === 0) {
    return {
      committed: false,
      held: true,
      reason: 'all changed paths were blocked by the commit guard',
      paths: changed,
      blocked: screened.blocked,
    };
  }

  const added = runner(repoDir, ['add', '--', ...screened.allowed]);
  if (!added.ok) {
    return { committed: false, held: true, reason: `git add failed: ${added.stderr.trim()}`, paths: screened.allowed };
  }
  const stagedAfter = listStagedPaths(repoDir, runner);
  const unexpected = stagedAfter.filter((path) => !screened.allowed.includes(path));
  if (unexpected.length > 0) {
    return {
      committed: false,
      held: true,
      reason: 'another staged path appeared during checkpoint preparation',
      paths: screened.allowed,
      unexpected,
    };
  }

  const commit = runner(repoDir, ['commit', '-m', message]);
  if (!commit.ok) {
    return { committed: false, held: true, reason: `git commit failed: ${commit.stderr.trim()}`, paths: screened.allowed };
  }
  const sha = requireGitWithRunner(repoDir, ['rev-parse', 'HEAD'], runner);
  return {
    committed: true,
    held: false,
    reason: 'checkpoint committed',
    paths: screened.allowed,
    blocked: screened.blocked,
    sha,
  };
}

export function createFeatureBranch({ repoDir, branch, runner = runGit }) {
  if (!/^agent\/[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error(`refusing non-agent branch name: ${branch}`);
  }
  const result = runner(repoDir, ['switch', '--create', branch]);
  if (!result.ok) throw new Error(`cannot create feature branch: ${result.stderr.trim()}`);
  return branch;
}

export function pushFeatureBranch({ repoDir, branch, remote = 'origin', runner = runGit }) {
  if (!branch || branch === 'main' || branch === 'master') {
    throw new Error('refusing to push a default branch from the coordinator');
  }
  const result = runner(repoDir, ['push', remote, `HEAD:refs/heads/${branch}`]);
  if (!result.ok) throw new Error(`git push failed: ${(result.stderr || result.stdout).trim()}`);
  return { pushed: true, branch, remote };
}

/**
 * Reconcile a clean, owned feature branch against its remote counterpart.
 * Rebasing onto the remote branch keeps the eventual push fast-forward-only.
 * A conflict is aborted immediately so the coordinator never leaves an
 * in-progress rebase in another instance's worktree.
 */
export function reconcileCleanBranch({
  repoDir,
  branch,
  defaultBranchName,
  remote = 'origin',
  runner = runGit,
}) {
  if (!branch || branch === 'HEAD') throw new Error('branch identity is unresolved');
  if (branch === defaultBranchName || branch === 'main' || branch === 'master') {
    throw new Error('refusing to reconcile a default branch');
  }
  if (listStagedPaths(repoDir, runner).length > 0) {
    return { reconciled: false, held: true, reason: 'index contains staged paths' };
  }
  if (listChangedPaths(repoDir, runner).length > 0) {
    return { reconciled: false, held: true, reason: 'worktree is dirty' };
  }

  const remoteBranch = runner(repoDir, ['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
  if (!remoteBranch.ok) {
    return { reconciled: false, held: true, reason: `cannot inspect remote branch: ${remoteBranch.stderr.trim()}` };
  }
  if (!remoteBranch.stdout.trim()) {
    return { reconciled: false, held: false, reason: 'remote branch does not exist; no rebase needed' };
  }

  const fetched = runner(repoDir, ['fetch', '--prune', remote, branch]);
  if (!fetched.ok) {
    return { reconciled: false, held: true, reason: `fetch failed: ${(fetched.stderr || fetched.stdout).trim()}` };
  }
  const rebased = runner(repoDir, ['rebase', `${remote}/${branch}`]);
  if (!rebased.ok) {
    const aborted = runner(repoDir, ['rebase', '--abort']);
    return {
      reconciled: false,
      held: true,
      conflict: true,
      aborted: aborted.ok,
      reason: `rebase conflict; abort ${aborted.ok ? 'completed' : 'failed'}`,
    };
  }
  return { reconciled: true, held: false, fetched: true, reason: 'clean branch rebased onto remote branch' };
}

export function draftPullRequestArgs({ repo, base, head }) {
  if (!repo || !base || !head) throw new Error('repo, base, and head are required for a draft pull request');
  return ['pr', 'create', '--repo', repo, '--base', base, '--head', head, '--draft', '--fill'];
}

export { runGit };
