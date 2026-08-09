import test from 'node:test';
import assert from 'node:assert/strict';
import { HEARTBEAT_COMMAND, integrationPlan, mergeClaudeSettings } from './install-cli-integrations.mjs';

test('Claude settings merge preserves existing hooks and is idempotent', () => {
  const current = {
    hooks: {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'existing-hook' }] }],
    },
  };
  const first = mergeClaudeSettings(current);
  assert.equal(first.changed, true);
  assert.equal(first.settings.hooks.PostToolUse.length, 2);
  assert.equal(first.settings.hooks.PostToolUse[0].hooks[0].command, 'existing-hook');
  const second = mergeClaudeSettings(first.settings);
  assert.equal(second.changed, false);
  assert.equal(second.settings.hooks.PostToolUse.length, 2);
  assert.equal(first.settings.hooks.PostToolUse[1].hooks[0].command, HEARTBEAT_COMMAND);
});

test('integration plan can point the live hook at an installed control-plane path', () => {
  const plan = integrationPlan({ home: '/Users/example', stackOpsDir: '/opt/stack-ops' });
  assert.equal(plan.claude.command, '/opt/stack-ops/scripts/instance-shipping/cli-heartbeat.zsh');
});

test('the integration plan makes unsupported hook surfaces explicit', () => {
  const plan = integrationPlan({ home: '/tmp/example', stackOpsDir: '/tmp/example/Documents/stack-ops' });
  assert.equal(plan.claude.supported, true);
  assert.equal(plan.codex.supported, false);
  assert.equal(plan.antigravity.supported, false);
  assert.equal(plan.grok.supported, false);
  assert.match(plan.claude.command, /cli-heartbeat\.zsh$/);
});
