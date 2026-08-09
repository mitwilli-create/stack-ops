import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkpointWorktree,
  draftPullRequestArgs,
  parseStatusPaths,
  pushFeatureBranch,
  reconcileCleanBranch,
} from './git-actions.mjs';

test('status parser keeps ordinary, untracked, and rename paths', () => {
  const output = [
    ' M src/app.mjs',
    '?? notes.txt',
    'R  new-name.mjs',
    'old-name.mjs',
  ].join('\0') + '\0';
  assert.deepEqual(parseStatusPaths(output), ['src/app.mjs', 'notes.txt', 'new-name.mjs', 'old-name.mjs']);
});

test('draft pull request arguments name the repository explicitly', () => {
  assert.deepEqual(draftPullRequestArgs({ repo: 'owner/repo', base: 'main', head: 'agent/checkpoint' }), [
    'pr', 'create', '--repo', 'owner/repo', '--base', 'main', '--head', 'agent/checkpoint', '--draft', '--fill',
  ]);
});

test('feature publication never emits a force-push', () => {
  const calls = [];
  const result = pushFeatureBranch({
    repoDir: '/tmp/repo',
    branch: 'agent/checkpoint',
    runner: (_cwd, args) => {
      calls.push(args);
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.pushed, true);
  assert.deepEqual(calls, [['push', 'origin', 'HEAD:refs/heads/agent/checkpoint']]);
  assert.equal(calls.flat().includes('--force'), false);
});

test('default branch publication is rejected', () => {
  assert.throws(() => pushFeatureBranch({
    repoDir: '/tmp/repo',
    branch: 'main',
    runner: () => ({ ok: true, status: 0, stdout: '', stderr: '' }),
}), /default branch/);
});

test('clean owned feature work fetches and rebases onto its remote branch', () => {
  const calls = [];
  const result = reconcileCleanBranch({
    repoDir: '/tmp/repo',
    branch: 'agent/reconcile',
    defaultBranchName: 'main',
    runner: (_cwd, args) => {
      calls.push(args);
      if (args[0] === 'status') return { ok: true, stdout: '', stderr: '' };
      if (args[0] === 'diff') return { ok: true, stdout: '', stderr: '' };
      if (args[0] === 'ls-remote') return { ok: true, stdout: 'abc\trefs/heads/agent/reconcile\n', stderr: '' };
      return { ok: true, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.reconciled, true);
  assert.deepEqual(calls.slice(-2), [
    ['fetch', '--prune', 'origin', 'agent/reconcile'],
    ['rebase', 'origin/agent/reconcile'],
  ]);
});

test('rebase conflict aborts the in-progress rebase and preserves the branch', () => {
  const calls = [];
  const result = reconcileCleanBranch({
    repoDir: '/tmp/repo',
    branch: 'agent/conflict',
    defaultBranchName: 'main',
    runner: (_cwd, args) => {
      calls.push(args);
      if (args[0] === 'status' || args[0] === 'diff') return { ok: true, stdout: '', stderr: '' };
      if (args[0] === 'ls-remote') return { ok: true, stdout: 'abc\trefs/heads/agent/conflict\n', stderr: '' };
      if (args[0] === 'rebase') return { ok: false, stdout: '', stderr: 'CONFLICT (content)' };
      return { ok: true, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.reconciled, false);
  assert.equal(result.conflict, true);
  assert.deepEqual(calls.at(-1), ['rebase', '--abort']);
});

function git(repoDir, args) {
  const result = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('checkpoint commits allowed dirty paths and leaves denied paths dirty', () => {
  const repo = mkdtempSync(join(tmpdir(), 'instance-checkpoint-'));
  try {
    git(repo, ['init', '-b', 'feature/checkpoint']);
    git(repo, ['config', 'user.name', 'Instance Test']);
    git(repo, ['config', 'user.email', 'instance@example.invalid']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/app.mjs'), 'export const value = 1;\n');
    git(repo, ['add', '--', 'src/app.mjs']);
    git(repo, ['commit', '-m', 'initial']);
    writeFileSync(join(repo, 'src/app.mjs'), 'export const value = 2;\n');
    writeFileSync(join(repo, 'cv.md'), 'private draft\n');

    const result = checkpointWorktree({ repoDir: repo, message: 'chore: checkpoint test' });
    assert.equal(result.committed, true);
    assert.deepEqual(result.paths, ['src/app.mjs']);
    assert.equal(result.blocked.length, 1);
    assert.match(git(repo, ['status', '--porcelain']), /\?\? cv\.md/);
    assert.match(git(repo, ['log', '-1', '--pretty=%s']), /checkpoint test/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('checkpoint refuses a pre-staged index instead of absorbing it', () => {
  const repo = mkdtempSync(join(tmpdir(), 'instance-checkpoint-staged-'));
  try {
    git(repo, ['init', '-b', 'feature/checkpoint']);
    git(repo, ['config', 'user.name', 'Instance Test']);
    git(repo, ['config', 'user.email', 'instance@example.invalid']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(repo, 'app.mjs'), 'export const value = 1;\n');
    git(repo, ['add', '--', 'app.mjs']);
    git(repo, ['commit', '-m', 'initial']);
    writeFileSync(join(repo, 'app.mjs'), 'export const value = 2;\n');
    git(repo, ['add', '--', 'app.mjs']);
    const result = checkpointWorktree({ repoDir: repo, message: 'chore: checkpoint test' });
    assert.equal(result.committed, false);
    assert.equal(result.held, true);
    assert.match(result.reason, /staged paths/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
