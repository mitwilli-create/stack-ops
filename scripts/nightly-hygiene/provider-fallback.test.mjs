import test from 'node:test';
import assert from 'node:assert/strict';
import { canReplayProviderFailure, providerAttempts, providerFallbackEligible } from './provider-fallback.mjs';

test('weekly limit and HTTP 429 failures advance to the subscription adapter', () => {
  assert.equal(providerFallbackEligible("You've hit your weekly limit, resets August 12"), true);
  assert.equal(providerFallbackEligible('api_error_status: 429'), true);
  assert.equal(providerFallbackEligible('provider unavailable'), true);
});

test('policy and uncertain edit failures do not replay through another provider', () => {
  assert.equal(providerFallbackEligible('policy denied by provider'), false);
  assert.equal(providerFallbackEligible('provider timed out after partial edits'), false);
  assert.equal(providerFallbackEligible('malformed response after edits'), false);
});

test('provider failover replays only when the failed primary changed nothing', () => {
  assert.equal(canReplayProviderFailure({ eligible: true, changedPaths: [] }), true);
  assert.equal(canReplayProviderFailure({ eligible: true, changedPaths: ['src/app.mjs'] }), false);
  assert.equal(canReplayProviderFailure({ eligible: false, changedPaths: [] }), false);
});

test('provider receipt parser keeps only bounded attempt metadata', () => {
  const stderr = '[provider-failover-agent] resolved=codex-cli:gpt-5.6-sol attempts=[{"provider":"claude-cli","model":"fable","status":"failed","errorCode":"subscription_weekly_limit"},{"provider":"codex-cli","model":"gpt-5.6-sol","status":"succeeded"}]';
  assert.deepEqual(providerAttempts(stderr), [
    { provider: 'claude-cli', model: 'fable', status: 'failed', errorCode: 'subscription_weekly_limit' },
    { provider: 'codex-cli', model: 'gpt-5.6-sol', status: 'succeeded', errorCode: null },
  ]);
});
