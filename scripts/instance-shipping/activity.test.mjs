import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABANDONED_AFTER_MS,
  DORMANT_AFTER_MS,
  adoptionDecision,
  classifyActivity,
} from './activity.mjs';

const nowMs = Date.parse('2026-08-08T20:00:00.000Z');
const signalAt = (ageMs, extra = {}) => ({
  kind: 'file-write',
  at: nowMs - ageMs,
  ...extra,
});

test('activity remains active just before 45 minutes', () => {
  assert.equal(classifyActivity({ nowMs, signals: [signalAt(DORMANT_AFTER_MS - 1)] }).state, 'active');
});

test('activity becomes dormant at exactly 45 minutes', () => {
  const result = classifyActivity({ nowMs, signals: [signalAt(DORMANT_AFTER_MS)] });
  assert.equal(result.state, 'dormant');
  assert.equal(result.idleMs, DORMANT_AFTER_MS);
});

test('activity remains dormant until exactly six hours', () => {
  assert.equal(classifyActivity({ nowMs, signals: [signalAt(ABANDONED_AFTER_MS - 1)] }).state, 'dormant');
});

test('activity becomes abandoned at exactly six hours', () => {
  const result = classifyActivity({ nowMs, signals: [signalAt(ABANDONED_AFTER_MS)] });
  assert.equal(result.state, 'abandoned');
  assert.equal(result.idleMs, ABANDONED_AFTER_MS);
});

test('stale processes do not count as live activity', () => {
  const result = classifyActivity({
    nowMs,
    signals: [signalAt(ABANDONED_AFTER_MS, { kind: 'process', live: false })],
  });
  assert.equal(result.state, 'unknown');
});

test('the newest live signal wins across signal types', () => {
  const result = classifyActivity({
    nowMs,
    signals: [
      signalAt(ABANDONED_AFTER_MS, { kind: 'file-write' }),
      signalAt(DORMANT_AFTER_MS - 1, { kind: 'heartbeat' }),
    ],
  });
  assert.equal(result.state, 'active');
  assert.equal(result.latestAt, nowMs - DORMANT_AFTER_MS + 1);
});

test('unknown work is not adoptable', () => {
  const result = adoptionDecision({
    activityState: 'unknown',
    branch: 'feature/old',
    ownerMode: 'solo',
    configuredOwner: 'mitwilli-create',
    repositoryOwner: 'mitwilli-create',
  });
  assert.equal(result.allowed, false);
});

test('a solo repository owner may adopt abandoned dirty feature work', () => {
  const result = adoptionDecision({
    activityState: 'abandoned',
    branch: 'feature/old',
    ownerMode: 'solo',
    configuredOwner: 'mitwilli-create',
    repositoryOwner: 'mitwilli-create',
  });
  assert.equal(result.allowed, true);
});

test('a solo repository owner may branch abandoned default work before publication', () => {
  const result = adoptionDecision({
    activityState: 'abandoned',
    branch: 'main',
    defaultBranch: true,
    ownerMode: 'solo',
    configuredOwner: 'mitwilli-create',
    repositoryOwner: 'mitwilli-create',
  });
  assert.equal(result.allowed, true);
  assert.match(result.reason, /feature branch/);
});

test('live processes, continuous integration, and deployment block adoption', () => {
  for (const key of ['processActive', 'ciActive', 'deployActive', 'conflict', 'protectedBranch']) {
    const result = adoptionDecision({
      activityState: 'abandoned',
      branch: 'feature/old',
      ownerMode: 'solo',
      configuredOwner: 'mitwilli-create',
      repositoryOwner: 'mitwilli-create',
      [key]: true,
    });
    assert.equal(result.allowed, false, key);
  }
});

test('unknown process liveness blocks adoption rather than guessing', () => {
  const result = adoptionDecision({
    activityState: 'abandoned',
    branch: 'feature/old',
    ownerMode: 'solo',
    configuredOwner: 'mitwilli-create',
    repositoryOwner: 'mitwilli-create',
    processCheckKnown: false,
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /liveness/);
});
