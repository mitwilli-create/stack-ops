import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  appendPrivateLog,
  createRunArtifacts,
  resumePendingFinalizations,
} from './stray-drain.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stray-drain-security-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('new runs reject an existing log directory that is not exactly mode 0700', () => {
  const f = fixture();
  try {
    const logDir = join(f.root, 'logs');
    mkdirSync(logDir, { mode: 0o755 });
    chmodSync(logDir, 0o755);
    assert.throws(() => createRunArtifacts(logDir, []), /log directory.*0700|private directory.*0700/i);
    assert.equal((lstatSync(logDir).mode & 0o777), 0o755);
    assert.deepEqual(readdirSync(logDir), []);
  } finally {
    f.cleanup();
  }
});

test('startup recovery rejects an unsafe resumed run directory before reading receipts', () => {
  const f = fixture();
  try {
    const logDir = join(f.root, 'logs');
    const runDirectory = join(logDir, 'run-existing');
    mkdirSync(runDirectory, { recursive: true, mode: 0o755 });
    chmodSync(logDir, 0o700);
    chmodSync(runDirectory, 0o755);
    assert.throws(() => resumePendingFinalizations({
      logDir,
      vault: join(f.root, 'vault'),
      lib: join(f.root, 'wrap-lib.sh'),
      drainer: join(f.root, 'drainer.mjs'),
      dispositions: join(f.root, 'dispositions.jsonl'),
      ledgerPath: join(f.root, 'ledger.txt'),
      timeoutMs: 1_000,
    }), /run directory.*0700|private directory.*0700/i);
  } finally {
    f.cleanup();
  }
});

test('private log append creates exact state and never follows a symlink', () => {
  const f = fixture();
  try {
    const logDir = join(f.root, 'logs');
    mkdirSync(logDir, { mode: 0o700 });
    const log = join(logDir, 'stray-drain.log');
    appendPrivateLog(log, 'first line');
    assert.equal((lstatSync(log).mode & 0o777), 0o600);
    assert.match(readFileSync(log, 'utf8'), /first line/);

    const sentinel = join(logDir, 'sentinel.txt');
    writeFileSync(sentinel, 'sentinel\n', { mode: 0o600 });
    rmSync(log);
    symlinkSync(sentinel, log);
    assert.throws(() => appendPrivateLog(log, 'must not land'), /symlink|private regular/i);
    assert.equal(readFileSync(sentinel, 'utf8'), 'sentinel\n');
  } finally {
    f.cleanup();
  }
});

test('new run artifacts are exact private state under a restrictive umask', () => {
  const f = fixture();
  let priorUmask;
  try {
    const logDir = join(f.root, 'logs');
    mkdirSync(logDir, { mode: 0o700 });
    priorUmask = process.umask(0o777);
    const artifacts = createRunArtifacts(logDir, []);
    assert.equal((lstatSync(artifacts.runDirectory).mode & 0o777), 0o700);
    for (const path of [artifacts.listFile, artifacts.progress, artifacts.placementJournal, artifacts.transactionOwner]) {
      assert.equal(existsSync(path), true);
      assert.equal((lstatSync(path).mode & 0o777), 0o600);
    }
  } finally {
    if (priorUmask !== undefined) process.umask(priorUmask);
    f.cleanup();
  }
});
