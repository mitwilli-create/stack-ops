import test from 'node:test';
import assert from 'node:assert/strict';
import { branchPatternMatches, manifestAllowsBranch, validateDeployManifest } from './manifest.mjs';

const valid = {
  verify: ['npm test'],
  deploy: ['./scripts/deploy.sh'],
  liveCheck: ['curl -fsS https://example.invalid/health'],
  branches: ['agent/*', 'codex/*'],
  autoDeploy: true,
};

test('deployment manifest validates only when all gates are explicit', () => {
  assert.equal(validateDeployManifest(valid).valid, true);
  assert.equal(validateDeployManifest({ ...valid, autoDeploy: false }).valid, false);
  assert.equal(validateDeployManifest({ ...valid, liveCheck: [] }).valid, false);
});

test('branch patterns match only configured agent branches', () => {
  assert.equal(branchPatternMatches('codex/*', 'codex/fix'), true);
  assert.equal(branchPatternMatches('codex/*', 'claude/fix'), false);
  assert.equal(manifestAllowsBranch(valid, 'agent/fix').allowed, true);
  assert.equal(manifestAllowsBranch(valid, 'main').allowed, false);
});
