#!/usr/bin/env node

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HEARTBEAT_COMMAND = '$HOME/Documents/stack-ops/scripts/instance-shipping/cli-heartbeat.zsh';

export function mergeClaudeSettings(settings, command = HEARTBEAT_COMMAND) {
  const next = structuredClone(settings || {});
  next.hooks ||= {};
  next.hooks.PostToolUse ||= [];
  const alreadyPresent = next.hooks.PostToolUse.some((entry) =>
    entry?.hooks?.some((hook) => hook?.type === 'command' && hook.command === command));
  if (!alreadyPresent) {
    next.hooks.PostToolUse.push({
      matcher: 'Write|Edit|MultiEdit',
      hooks: [{
        type: 'command',
        command,
        timeout: 5,
        statusMessage: 'Recording instance activity',
      }],
    });
  }
  return { changed: !alreadyPresent, settings: next };
}

export function integrationPlan({ home = homedir(), stackOpsDir = join(home, 'Documents', 'stack-ops') } = {}) {
  return {
    claude: {
      supported: true,
      settingsPath: join(home, '.claude', 'settings.json'),
      command: `${stackOpsDir}/scripts/instance-shipping/cli-heartbeat.zsh`,
    },
    codex: { supported: false, reason: 'current Codex CLI exposes no lifecycle hook; observer and wrapper cover it' },
    antigravity: { supported: false, reason: 'current Antigravity CLI exposes no lifecycle hook; observer and wrapper cover it' },
    grok: { supported: false, reason: 'current Grok CLI exposes no lifecycle hook; observer and wrapper cover it' },
  };
}

function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function main() {
  const args = new Set(process.argv.slice(2));
  const plan = integrationPlan({
    stackOpsDir: process.env.STACK_OPS_DIR || undefined,
  });
  const settingsPath = plan.claude.settingsPath;
  if (!existsSync(settingsPath)) throw new Error(`Claude settings not found: ${settingsPath}`);
  const current = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const merged = mergeClaudeSettings(current, plan.claude.command);
  const result = {
    status: args.has('--apply') ? 'partial' : 'not run',
    claude: { settingsPath, changed: merged.changed, command: plan.claude.command },
    codex: plan.codex,
    antigravity: plan.antigravity,
    grok: plan.grok,
  };
  if (args.has('--apply') && merged.changed) {
    writeJsonAtomic(settingsPath, merged.settings);
    result.status = 'green';
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}
