import test from 'node:test';
import assert from 'node:assert/strict';
import { DORMANT_AFTER_MS, ABANDONED_AFTER_MS } from './activity.mjs';
import { planWorktree } from './policy.mjs';

const nowMs = Date.parse('2026-08-08T20:00:00.000Z');
const signals = (ageMs) => [{ kind: 'heartbeat', at: nowMs - ageMs }];

test('active dirty work is observed and untouched', () => {
  const result = planWorktree({ nowMs, signals: signals(DORMANT_AFTER_MS - 1), dirty: true, branch: 'feature/current', owner: true });
  assert.deepEqual(result, {
    state: 'active',
    action: 'observe',
    reason: 'live activity is within the active window',
    idleMs: DORMANT_AFTER_MS - 1,
  });
});

test('dormant owned dirty work is checkpoint eligible', () => {
  const result = planWorktree({ nowMs, signals: signals(DORMANT_AFTER_MS), dirty: true, branch: 'feature/current', owner: true });
  assert.equal(result.action, 'checkpoint-owned');
});

test('dormant unowned dirty work is recorded without mutation', () => {
  const result = planWorktree({ nowMs, signals: signals(DORMANT_AFTER_MS), dirty: true, branch: 'feature/current', owner: false });
  assert.equal(result.action, 'record-candidate');
});

test('abandoned unowned feature work is adopted in solo-owner mode', () => {
  const result = planWorktree({
    nowMs,
    signals: signals(ABANDONED_AFTER_MS),
    dirty: true,
    owner: false,
    branch: 'feature/old',
    ownerMode: 'solo',
    configuredOwner: 'mitwilli-create',
    repositoryOwner: 'mitwilli-create',
  });
  assert.equal(result.action, 'adopt-and-checkpoint');
});

test('abandoned default work is adopted only with a branch-before-publish action', () => {
  const result = planWorktree({
    nowMs,
    signals: signals(ABANDONED_AFTER_MS),
    dirty: true,
    owner: false,
    branch: 'main',
    defaultBranch: true,
    ownerMode: 'solo',
    configuredOwner: 'mitwilli-create',
    repositoryOwner: 'mitwilli-create',
  });
  assert.equal(result.action, 'adopt-and-checkpoint');
  assert.match(result.reason, /feature branch/);
});

test('an active remote check holds abandoned-looking work', () => {
  const result = planWorktree({
    nowMs,
    signals: signals(ABANDONED_AFTER_MS),
    dirty: true,
    owner: false,
    branch: 'feature/old',
    ownerMode: 'solo',
    configuredOwner: 'mitwilli-create',
    repositoryOwner: 'mitwilli-create',
    ciActive: true,
  });
  assert.equal(result.action, 'record-held');
});

test('detached work is held even when it is clean and old', () => {
  const result = planWorktree({
    nowMs,
    signals: signals(ABANDONED_AFTER_MS),
    dirty: false,
    branch: '',
    owner: false,
  });
  assert.equal(result.action, 'record-held');
  assert.match(result.reason, /branch identity/);
});

test('clean unowned work is not reconciled automatically', () => {
  const result = planWorktree({
    nowMs,
    signals: signals(ABANDONED_AFTER_MS),
    dirty: false,
    branch: 'feature/old',
    owner: false,
  });
  assert.equal(result.action, 'record-candidate');
});
