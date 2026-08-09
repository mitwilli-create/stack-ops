import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('./instance-shipping.mjs', import.meta.url);

test('heartbeat writes an explicit live signal and dry-run emits a receipt-shaped result', () => {
  const root = mkdtempSync(join(tmpdir(), 'instance-shipping-'));
  const stateDir = join(root, 'state');
  const receiptPath = join(root, 'receipts.jsonl');
  const configPath = join(root, 'config.json');
  try {
    writeFileSync(configPath, JSON.stringify({
      rootDir: root,
      stateDir,
      receiptPath,
      ownerMode: 'solo',
      repositoryOwner: 'mitwilli-create',
      leaseTtlMs: 900000,
      heartbeatTtlMs: 120000,
    }));
    const heartbeat = spawnSync(process.execPath, [script.pathname, '--heartbeat', '--worktree', root, '--config', configPath], { encoding: 'utf8' });
    assert.equal(heartbeat.status, 0, heartbeat.stderr);
    assert.match(heartbeat.stdout, /"action":"heartbeat"/);
    const dryRun = spawnSync(process.execPath, [script.pathname, '--dry-run', '--worktree', root, '--config', configPath], { encoding: 'utf8' });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /"status":"failed"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
