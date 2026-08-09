import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLease, heartbeatLease, readLease } from './leases.mjs';

test('a live lease cannot be replaced by another instance', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'instance-lease-'));
  try {
    const first = acquireLease({
      stateDir,
      worktreePath: '/tmp/worktree-a',
      ownerId: 'first',
      repository: 'repo',
      branch: 'feature/a',
      nowMs: 1000,
      ttlMs: 60000,
    });
    assert.equal(first.acquired, true);
    const second = acquireLease({
      stateDir,
      worktreePath: '/tmp/worktree-a',
      ownerId: 'second',
      repository: 'repo',
      branch: 'feature/a',
      nowMs: 2000,
      ttlMs: 60000,
    });
    assert.equal(second.acquired, false);
    assert.equal(readLease(stateDir, '/tmp/worktree-a').ownerId, 'first');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the current owner can refresh an expired lease', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'instance-lease-'));
  try {
    acquireLease({
      stateDir,
      worktreePath: '/tmp/worktree-a',
      ownerId: 'first',
      repository: 'repo',
      branch: 'feature/a',
      nowMs: 1000,
      ttlMs: 10,
    });
    const refreshed = heartbeatLease({
      stateDir,
      worktreePath: '/tmp/worktree-a',
      ownerId: 'first',
      nowMs: 2000,
      ttlMs: 60000,
    });
    assert.equal(refreshed.refreshed, true);
    assert.equal(readLease(stateDir, '/tmp/worktree-a').expiresAt, 62000);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
