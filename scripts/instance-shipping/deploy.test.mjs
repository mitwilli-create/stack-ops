import test from 'node:test';
import assert from 'node:assert/strict';
import { runDeployment } from './deploy.mjs';

const manifest = {
  verify: ['npm test'],
  deploy: ['./scripts/deploy.sh'],
  liveCheck: ['curl -fsS https://example.invalid/health'],
  branches: ['agent/*'],
  autoDeploy: true,
};

test('deployment runs verification, deploy, and live check in order', () => {
  const commands = [];
  const result = runDeployment({
    repoDir: '/tmp/repo',
    branch: 'agent/checkpoint',
    manifest,
    runner: (command) => {
      commands.push(command);
      return { ok: true, timedOut: false };
    },
  });
  assert.equal(result.status, 'green');
  assert.deepEqual(commands, manifest.verify.concat(manifest.deploy, manifest.liveCheck));
});

test('a failed verification stops before deploy', () => {
  const commands = [];
  const result = runDeployment({
    repoDir: '/tmp/repo',
    branch: 'agent/checkpoint',
    manifest,
    runner: (command) => {
      commands.push(command);
      return { ok: false, timedOut: false };
    },
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(commands, ['npm test']);
});

test('a branch outside the manifest is held without running a command', () => {
  let called = false;
  const result = runDeployment({
    repoDir: '/tmp/repo',
    branch: 'main',
    manifest,
    runner: () => { called = true; return { ok: true }; },
  });
  assert.equal(result.status, 'held');
  assert.equal(called, false);
});
