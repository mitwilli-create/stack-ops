import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildDrainerArgs,
  createRunArtifacts,
  finalizeCaptured,
  inspectPendingTransactions,
  parseProgress,
  reconcileRunEvidence,
  resumePendingFinalizations,
  rollbackPlacedRecords,
  scanExactRecords,
  selectReleasedClaimRows,
  validateMinedRows,
  validateStrayDrainConfig,
  verifyCapturedDispositions,
  verifyTransactionSpec,
} from './stray-drain.mjs';
import { discoverCandidates } from './stray-discovery.mjs';

const WRAPPER = fileURLToPath(new URL('./stray-drain.mjs', import.meta.url));
const RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const PROVIDER_PROOF = {
  requestedSlot: 'bulk_summarize',
  provider: 'cheap-cli',
  resolvedModel: null,
  accountType: 'configured-cli',
  failureReason: null,
  providerAttempts: [{
    engine: 'cheap',
    requestedSlot: 'bulk_summarize',
    provider: 'cheap-cli',
    resolvedModel: null,
    accountType: 'configured-cli',
    outcome: 'success',
    failureReason: null,
  }],
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stack-stray-test-'));
  const projects = join(root, 'projects');
  const project = join(projects, '-Users-example-project');
  mkdirSync(project, { recursive: true });
  const ledger = join(root, 'ledger.txt');
  writeFileSync(ledger, 'claimed-id\n', { mode: 0o600 });
  return { root, projects, project, ledger };
}

function routeProjectToVault(f, vault) {
  const target = join(vault, 'project-memory', 'documents');
  mkdirSync(target, { recursive: true });
  const memory = join(f.project, 'memory');
  if (!existsSync(memory)) symlinkSync(target, memory);
}

function transcript(path, ageMinutes = 120) {
  writeFileSync(path, '{"type":"user","message":{"content":"hello"}}\n', { mode: 0o600 });
  const when = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(path, when, when);
}

test('configuration bounds fail closed', () => {
  assert.throws(
    () => validateStrayDrainConfig({ maxPerRun: 0, concurrency: 16, quiescenceMinutes: 45 }),
    /maxPerRun/,
  );
  assert.throws(
    () => validateStrayDrainConfig({ maxPerRun: 10, concurrency: 999, quiescenceMinutes: 45 }),
    /concurrency/,
  );
  assert.throws(
    () => validateStrayDrainConfig({ maxPerRun: 10, concurrency: 2, quiescenceMinutes: -1 }),
    /quiescenceMinutes/,
  );
  assert.throws(
    () => validateStrayDrainConfig({ maxPerRun: 10, concurrency: 2, quiescenceMinutes: 44 }),
    /quiescenceMinutes/,
  );
  assert.throws(
    () => validateStrayDrainConfig({ maxPerRun: 401, concurrency: 2, quiescenceMinutes: 45 }),
    /maxPerRun/,
  );
  assert.throws(
    () => validateStrayDrainConfig({ maxPerRun: 10, concurrency: 65, quiescenceMinutes: 45 }),
    /concurrency/,
  );
  assert.throws(
    () => validateStrayDrainConfig({ maxPerRun: 10, concurrency: 2, subscriptionConcurrency: 5, quiescenceMinutes: 45 }),
    /subscriptionConcurrency/,
  );
  assert.throws(
    () => validateStrayDrainConfig({ maxPerRun: 10, concurrency: 2, quiescenceMinutes: 45, perProviderTimeoutMs: 240_001 }),
    /perProviderTimeoutMs/,
  );
  assert.throws(
    () => validateStrayDrainConfig({ maxPerRun: 10, concurrency: 2, quiescenceMinutes: 45, perTranscriptDeadlineMs: 900_001 }),
    /perTranscriptDeadlineMs/,
  );
  assert.throws(
    () => validateStrayDrainConfig({ maxPerRun: 10, concurrency: 2, quiescenceMinutes: 45, maxChunksPerTranscript: 49 }),
    /maxChunksPerTranscript/,
  );
  const defaults = validateStrayDrainConfig({ maxPerRun: 400, concurrency: 16, quiescenceMinutes: 45 });
  assert.equal(defaults.subscriptionConcurrency, 4);
  assert.equal(defaults.perProviderTimeoutMs, 240_000);
  assert.equal(defaults.perTranscriptDeadlineMs, 900_000);
  assert.equal(defaults.maxChunksPerTranscript, 48);
  assert.equal(defaults.maxSourceBytes, 16_000_000);
});

test('every configured safety bound is forwarded to the drainer', () => {
  const bounds = validateStrayDrainConfig({
    maxPerRun: 10,
    concurrency: 3,
    subscriptionConcurrency: 2,
    quiescenceMinutes: 45,
    perProviderTimeoutMs: 120_000,
    perTranscriptDeadlineMs: 600_000,
    globalDeadlineMs: 1_800_000,
    maxAttemptsPerProvider: 1,
    maxSourceBytes: 2_000_000,
    chunkChars: 6_000,
    maxChunksPerTranscript: 8,
  });
  assert.deepEqual(buildDrainerArgs({
    drainer: '/safe/drainer.mjs',
    listFile: '/safe/list',
    progress: '/safe/progress',
    dispositions: '/safe/dispositions',
    placementJournal: '/safe/placements',
    selectedCount: 7,
    bounds,
    dryRun: true,
  }), [
    '/safe/drainer.mjs',
    '--list', '/safe/list',
    '--limit', '7',
    '--concurrency', '3',
    '--subscription-concurrency', '2',
    '--out', '/safe/progress',
    '--dispositions', '/safe/dispositions',
    '--placement-journal', '/safe/placements',
    '--quiescence-minutes', '45',
    '--provider-timeout-ms', '120000',
    '--transcript-deadline-ms', '600000',
    '--max-attempts-per-provider', '1',
    '--max-source-bytes', '2000000',
    '--chunk-chars', '6000',
    '--max-chunks', '8',
    '--dry-run',
  ]);
});

test('concurrent run artifacts use distinct private directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'stack-stray-runs-'));
  const selected = [{ path: '/safe/one.jsonl' }];
  const first = createRunArtifacts(root, selected);
  const second = createRunArtifacts(root, selected);
  assert.notEqual(first.runDirectory, second.runDirectory);
  assert.equal(lstatSync(first.runDirectory).mode & 0o777, 0o700);
  assert.equal(lstatSync(first.listFile).mode & 0o777, 0o600);
  assert.equal(lstatSync(first.progress).mode & 0o777, 0o600);
  assert.equal(lstatSync(first.placementJournal).mode & 0o777, 0o600);
  assert.equal(lstatSync(first.transactionOwner).mode & 0o777, 0o600);
  assert.equal(readFileSync(first.placementJournal, 'utf8'), '');
  assert.equal(readFileSync(first.listFile, 'utf8'), '/safe/one.jsonl\n');
  assert.throws(() => createRunArtifacts(root, [{ path: '/safe/one.jsonl\n/smuggled' }]), /unsafe path/i);
  assert.throws(() => createRunArtifacts(root, [{ path: 'relative.jsonl' }]), /unsafe path/i);
});

test('exact records receive a fail-closed full-content credential scan before commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'stack-stray-scan-'));
  const scanner = join(root, 'scanner.mjs');
  const clean = join(root, 'clean.md');
  const blocked = join(root, 'blocked.md');
  writeFileSync(scanner, `
    import { readFileSync } from 'node:fs';
    const marker = ['sk', 'blocked-fixture'].join('-');
    process.exit(readFileSync(process.argv[2], 'utf8').includes(marker) ? 2 : 0);
  `, { mode: 0o700 });
  writeFileSync(clean, 'ordinary record\n', { mode: 0o600 });
  writeFileSync(blocked, ['sk', 'blocked-fixture'].join('-'), { mode: 0o600 });
  assert.doesNotThrow(() => scanExactRecords({ scanner, paths: [clean] }));
  assert.throws(
    () => scanExactRecords({ scanner, paths: [blocked] }),
    /credential scan failed.*exit_2/i,
  );
});

test('mined record provenance requires a private untracked non-symlink vault path', () => {
  const vault = mkdtempSync(join(tmpdir(), 'stack-stray-vault-'));
  const sessions = join(vault, 'project-memory', 'documents', 'sessions');
  mkdirSync(sessions, { recursive: true });
  const recordPath = join(sessions, 'record.md');
  writeFileSync(recordPath, 'safe record\n', { mode: 0o600 });
  const recordSha256 = createHash('sha256').update(readFileSync(recordPath)).digest('hex');
  const rows = [{
    transcriptId: 'one',
    sourcePath: '/safe/one.jsonl',
    status: 'mined',
    observedAt: '2026-08-09T22:00:00.000Z',
    recordPath,
    recordSha256,
  }];
  const untracked = (command, args) => {
    if (command !== 'git') return { code: 127, stdout: '' };
    if (args[0] === 'cat-file') return { code: 128, stdout: '' };
    if (args[0] === 'ls-files') return { code: 0, stdout: 'project-memory/documents/sessions/record.md\n' };
    return { code: 1, stdout: '' };
  };
  assert.deepEqual(validateMinedRows(rows, vault, untracked).paths, [
    'project-memory/documents/sessions/record.md',
  ]);
  assert.throws(
    () => validateMinedRows(rows, vault, () => ({ code: 0, stdout: '' })),
    /already exists in HEAD/i,
  );
  chmodSync(recordPath, 0o644);
  assert.throws(() => validateMinedRows(rows, vault, untracked), /permissions/i);
});

test('post-commit finalization proves one exact captured disposition per mined row', () => {
  const root = mkdtempSync(join(tmpdir(), 'stack-stray-finalize-'));
  const dispositions = join(root, 'dispositions.jsonl');
  const sourceSha256 = 'a'.repeat(64);
  const recordSha256 = 'b'.repeat(64);
  const commit = 'c'.repeat(40);
  const mined = [{
    transcriptId: 'one',
    sourcePath: '/safe/one.jsonl',
    status: 'mined',
    observedAt: '2026-08-09T22:00:00.000Z',
    runId: RUN_ID,
    sourceSha256,
    recordPath: '/safe/vault/project-memory/documents/sessions/one.md',
    recordSha256,
  }];
  writeFileSync(dispositions, `${JSON.stringify({
    ...mined[0],
    status: 'captured',
    commit,
    reachability: 'local-head',
  })}\n`, { mode: 0o600 });
  assert.doesNotThrow(() => finalizeCaptured({
    drainer: '/safe/drainer.mjs',
    progress: '/safe/progress.jsonl',
    dispositions,
    commit,
    expected: 1,
    timeoutMs: 1_000,
    execute: () => ({ code: 0, stdout: '{"finalized":1,"status":"captured"}\n' }),
  }));
  assert.doesNotThrow(() => verifyCapturedDispositions(dispositions, mined, commit));
  assert.throws(() => finalizeCaptured({
    drainer: '/safe/drainer.mjs',
    progress: '/safe/progress.jsonl',
    dispositions,
    commit,
    expected: 2,
    timeoutMs: 1_000,
    execute: () => ({ code: 0, stdout: '{"finalized":1,"status":"captured"}\n' }),
  }), /count mismatch/i);
});

test('startup resumes a committed transaction finalization exactly once', () => {
  const root = mkdtempSync(join(tmpdir(), 'stack-stray-resume-'));
  const vault = join(root, 'vault');
  mkdirSync(vault);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['commit', '--allow-empty', '-q', '-m', 'base'],
  ]) {
    const result = spawnSync('git', args, { cwd: vault, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const recordRelative = 'project-memory/documents/sessions/resumed.md';
  const recordPath = join(vault, recordRelative);
  const before = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  mkdirSync(join(vault, 'project-memory', 'documents', 'sessions'), { recursive: true });
  writeFileSync(recordPath, '# resumed\n', { mode: 0o600 });
  assert.equal(spawnSync('git', ['add', '--', recordRelative], { cwd: vault }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-q', '-m', 'vault: resume fixture'], { cwd: vault }).status, 0);
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  const recordSha256 = createHash('sha256').update(readFileSync(recordPath)).digest('hex');
  const source = join(root, 'source.jsonl');
  writeFileSync(source, '{"type":"user"}\n', { mode: 0o600 });
  const sourceSha256 = createHash('sha256').update(readFileSync(source)).digest('hex');
  const row = {
    transcriptId: 'resume-id',
    sourcePath: source,
    status: 'mined',
    observedAt: '2026-08-09T22:00:00.000Z',
    runId: RUN_ID,
    sourceSha256,
    recordPath,
    recordSha256,
    ...PROVIDER_PROOF,
  };
  const logDir = join(root, 'runs');
  const runDirectory = join(logDir, 'run-resume');
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const progress = join(runDirectory, 'progress.jsonl');
  const commitOid = join(runDirectory, 'commit-oid.txt');
  const rollbackSpec = join(runDirectory, 'rollback-spec.json');
  const dispositions = join(root, 'dispositions.jsonl');
  writeFileSync(progress, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  writeFileSync(rollbackSpec, `${JSON.stringify({
    schemaVersion: 1,
    beforeHead: before,
    quarantineRoot: join(runDirectory, 'rollback', 'records'),
    rows: [{
      transcriptId: row.transcriptId,
      sourcePath: row.sourcePath,
      sourceSha256: row.sourceSha256,
      recordPath: row.recordPath,
      recordRelative,
      recordSha256: row.recordSha256,
    }],
  })}\n`, { mode: 0o600 });
  writeFileSync(dispositions, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  const calls = join(root, 'finalizer-calls.txt');
  const drainer = join(root, 'drainer.mjs');
  writeFileSync(drainer, `
    import { appendFileSync, readFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    const get = (flag) => args[args.indexOf(flag) + 1];
    const rows = readFileSync(get('--finalize-progress'), 'utf8').trim().split('\\n').map(JSON.parse).filter((row) => row.status === 'mined');
    const commit = get('--commit');
    for (const row of rows) appendFileSync(get('--dispositions'), JSON.stringify({ ...row, status: 'captured', commit, reachability: 'local-head' }) + '\\n', { mode: 0o600 });
    appendFileSync(process.env.FINALIZER_CALLS, 'called\\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ finalized: rows.length, status: 'captured' }) + '\\n');
  `, { mode: 0o700 });
  const lib = join(root, 'wrap-lib.sh');
  writeFileSync(lib, `
    wrap_lock() { d="${root}/resume.lock"; mkdir "$d" || return 1; printf '%s' "$d|$$|token"; }
    wrap_unlock() { d="\${1%%|*}"; rmdir "$d"; }
  `, { mode: 0o600 });
  process.env.FINALIZER_CALLS = calls;
  const ledger = join(root, 'ledger.txt');
  writeFileSync(ledger, '', { mode: 0o600 });
  const first = resumePendingFinalizations({ logDir, vault, lib, drainer, dispositions, ledgerPath: ledger, timeoutMs: 10_000 });
  assert.equal(first.length, 1);
  assert.equal(first[0].commit, commit);
  assert.equal(readFileSync(commitOid, 'utf8').trim(), commit);
  assert.equal(readFileSync(calls, 'utf8'), 'called\n');
  const second = resumePendingFinalizations({ logDir, vault, lib, drainer, dispositions, ledgerPath: ledger, timeoutMs: 10_000 });
  assert.equal(second.length, 0);
  assert.equal(readFileSync(calls, 'utf8'), 'called\n');
  assert.equal(JSON.parse(readFileSync(join(runDirectory, 'transaction-resolution.json'), 'utf8')).status, 'captured');
  delete process.env.FINALIZER_CALLS;
});

test('startup fails closed on a malformed durable transaction resolution', () => {
  const root = mkdtempSync(join(tmpdir(), 'stack-stray-resolution-'));
  const runDirectory = join(root, 'runs', 'run-malformed-resolution');
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(runDirectory, 'transaction-resolution.json'), '{truncated', { mode: 0o600 });
  assert.throws(() => resumePendingFinalizations({
    logDir: join(root, 'runs'), vault: join(root, 'vault'), lib: join(root, 'lib'),
    drainer: join(root, 'drainer'), dispositions: join(root, 'dispositions'),
    ledgerPath: join(root, 'ledger'), timeoutMs: 1_000,
  }), /resolution.*malformed/i);
});

test('startup never trusts an unknown durable transaction resolution state', () => {
  const root = mkdtempSync(join(tmpdir(), 'stack-stray-resolution-state-'));
  const runDirectory = join(root, 'runs', 'run-invalid-resolution');
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(runDirectory, 'transaction-resolution.json'), `${JSON.stringify({
    schemaVersion: 1, status: 'assumed_done', commit: null, records: 0,
    resolvedAt: '2026-08-09T22:00:00.000Z',
  })}\n`, { mode: 0o600 });
  assert.throws(() => resumePendingFinalizations({
    logDir: join(root, 'runs'), vault: join(root, 'vault'), lib: join(root, 'lib'),
    drainer: join(root, 'drainer'), dispositions: join(root, 'dispositions'),
    ledgerPath: join(root, 'ledger'), timeoutMs: 1_000,
  }), /resolution state is invalid/i);
});

test('startup retires a dead-owner incomplete run that crashed before writing any journal event', () => {
  const root = mkdtempSync(join(tmpdir(), 'stack-stray-empty-journal-retirement-'));
  const logDir = join(root, 'runs');
  const runDirectory = join(logDir, 'run-empty-journal');
  const sourcePath = join(root, 'retry.jsonl');
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(sourcePath, '{"type":"user"}\n', { mode: 0o600 });
  writeFileSync(join(runDirectory, 'sources.txt'), `${sourcePath}\n`, { mode: 0o600 });
  writeFileSync(join(runDirectory, 'progress.jsonl'), '', { mode: 0o600 });
  writeFileSync(join(runDirectory, 'placement-journal.jsonl'), '', { mode: 0o600 });
  writeFileSync(join(runDirectory, 'transaction-owner.json'), `${JSON.stringify({
    schemaVersion: 1, createdAt: '2026-08-09T22:00:00.000Z', ownerPid: 2_147_483_647,
    vaultHead: 'a'.repeat(40), sources: [{ transcriptId: 'retry', sourcePath }],
  })}\n`, { mode: 0o600 });
  writeFileSync(join(runDirectory, 'incomplete-progress.json'), `${JSON.stringify({
    schemaVersion: 1, observedAt: '2026-08-09T22:00:00.000Z', childFailure: 'signal_SIGKILL',
    missing: [{ transcriptId: 'retry', sourcePath, status: 'missing_progress' }],
    issues: [], journalMissing: 0, journalUnproven: 0,
  })}\n`, { mode: 0o600 });

  const resumed = resumePendingFinalizations({
    logDir, vault: join(root, 'vault'), lib: join(root, 'lib'), drainer: join(root, 'drainer'),
    dispositions: join(root, 'dispositions'), ledgerPath: join(root, 'ledger'), timeoutMs: 1_000,
  });
  assert.deepEqual(resumed, []);
  assert.equal(JSON.parse(readFileSync(join(runDirectory, 'transaction-resolution.json'), 'utf8')).status, 'no_placements');
  assert.equal(existsSync(join(runDirectory, 'incomplete-progress-retirement.json')), true);
  assert.deepEqual(inspectPendingTransactions(logDir), []);
});

test('startup never adopts a transaction whose scheduler owner is still alive', () => {
  const root = mkdtempSync(join(tmpdir(), 'stack-stray-live-owner-'));
  const logDir = join(root, 'runs');
  const runDirectory = join(logDir, 'run-live-owner');
  const sourcePath = join(root, 'active.jsonl');
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(sourcePath, '{"type":"user"}\n', { mode: 0o600 });
  writeFileSync(join(runDirectory, 'sources.txt'), `${sourcePath}\n`, { mode: 0o600 });
  writeFileSync(join(runDirectory, 'progress.jsonl'), '', { mode: 0o600 });
  writeFileSync(join(runDirectory, 'placement-journal.jsonl'), '', { mode: 0o600 });
  writeFileSync(join(runDirectory, 'transaction-owner.json'), `${JSON.stringify({
    schemaVersion: 1, createdAt: new Date().toISOString(), ownerPid: process.pid,
    vaultHead: 'a'.repeat(40), sources: [{ transcriptId: 'active', sourcePath }],
  })}\n`, { mode: 0o600 });

  const resumed = resumePendingFinalizations({
    logDir, vault: join(root, 'vault'), lib: join(root, 'lib'), drainer: join(root, 'drainer'),
    dispositions: join(root, 'dispositions'), ledgerPath: join(root, 'ledger'), timeoutMs: 1_000,
  });
  assert.deepEqual(resumed, [{ runDirectory, commit: null, status: 'owner_active', finalized: 0 }]);
  assert.equal(existsSync(join(runDirectory, 'transaction-resolution.json')), false);
  assert.equal(inspectPendingTransactions(logDir).length, 1);
});

test('startup recovers a first-run claim intent before a disposition ledger exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'stack-stray-claim-intent-'));
  const logDir = join(root, 'runs');
  const runDirectory = join(logDir, 'run-claim-intent');
  const sourcePath = join(root, 'first-run.jsonl');
  const dispositions = join(root, 'dispositions.jsonl');
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(sourcePath, '{"type":"user"}\n', { mode: 0o600 });
  writeFileSync(join(runDirectory, 'sources.txt'), `${sourcePath}\n`, { mode: 0o600 });
  writeFileSync(join(runDirectory, 'progress.jsonl'), '', { mode: 0o600 });
  const claimIntent = {
    event: 'claim_intent', transcriptId: 'first-run', sourcePath,
    observedAt: '2026-08-09T22:00:00.000Z', runId: RUN_ID, ownerPid: 999999,
  };
  writeFileSync(join(runDirectory, 'placement-journal.jsonl'), [
    JSON.stringify(claimIntent),
    JSON.stringify({ ...claimIntent, event: 'claim_acquired' }),
    '',
  ].join('\n'), { mode: 0o600 });
  const drainer = join(root, 'drainer.mjs');
  writeFileSync(drainer, `
    import { writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    const get = (flag) => args[args.indexOf(flag) + 1];
    const row = { transcriptId: 'first-run', sourcePath: '${sourcePath}', status: 'claim_error',
      observedAt: '2026-08-09T22:00:00.000Z', runId: '${RUN_ID}',
      detailCode: 'recovered-dead-owner-before-placement' };
    writeFileSync(get('--dispositions'), JSON.stringify(row) + '\\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ recovered: 0, released: 1, active: 0, missing: 0, unproven: 0, status: 'reconciled' }) + '\\n');
  `, { mode: 0o700 });
  const lib = join(root, 'wrap-lib.sh');
  writeFileSync(lib, `
    wrap_lock() { d="${root}/claim-intent.lock"; mkdir "$d" || return 1; printf '%s' "$d|$$|token"; }
    wrap_unlock() { d="\${1%%|*}"; rmdir "$d"; }
  `, { mode: 0o600 });
  const resumed = resumePendingFinalizations({
    logDir, vault: join(root, 'vault'), lib, drainer, dispositions,
    ledgerPath: join(root, 'ledger'), timeoutMs: 10_000,
  });
  assert.deepEqual(resumed, []);
  assert.equal(JSON.parse(readFileSync(join(runDirectory, 'transaction-resolution.json'), 'utf8')).status, 'no_placements');
  assert.equal(JSON.parse(readFileSync(dispositions, 'utf8')).detailCode, 'recovered-dead-owner-before-placement');
});

test('startup retries a quarantined rollback and records a durable resolution', () => {
  const root = mkdtempSync(join(tmpdir(), 'stack-stray-resume-rollback-'));
  const vault = join(root, 'vault');
  mkdirSync(vault);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['commit', '--allow-empty', '-q', '-m', 'base'],
  ]) assert.equal(spawnSync('git', args, { cwd: vault }).status, 0);
  const runDirectory = join(root, 'runs', 'run-rollback');
  const recoveryDirectory = join(runDirectory, 'rollback');
  const recoveredPath = join(recoveryDirectory, 'records', 'project-memory', 'documents', 'sessions', 'rolled.md');
  mkdirSync(join(recoveryDirectory, 'records', 'project-memory', 'documents', 'sessions'), { recursive: true, mode: 0o700 });
  writeFileSync(recoveredPath, '# rolled back\n', { mode: 0o600 });
  const recordSha256 = createHash('sha256').update(readFileSync(recoveredPath)).digest('hex');
  const sourcePath = join(root, 'source.jsonl');
  writeFileSync(sourcePath, '{"safe":true}\n', { mode: 0o600 });
  const row = {
    transcriptId: 'rollback-id', sourcePath, status: 'mined',
    observedAt: '2026-08-09T22:00:00.000Z', runId: RUN_ID,
    sourceSha256: createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),
    recordPath: join(vault, 'project-memory', 'documents', 'sessions', 'rolled.md'),
    recordSha256, ...PROVIDER_PROOF,
  };
  const progress = join(runDirectory, 'transaction-progress.jsonl');
  const rollbackSpec = join(runDirectory, 'rollback-spec.json');
  const manifest = join(recoveryDirectory, 'recovery-manifest.jsonl');
  const dispositions = join(root, 'dispositions.jsonl');
  const ledger = join(root, 'ledger.txt');
  writeFileSync(progress, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  writeFileSync(rollbackSpec, `${JSON.stringify({
    schemaVersion: 1,
    beforeHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim(),
    quarantineRoot: join(recoveryDirectory, 'records'),
    rows: [{
      transcriptId: row.transcriptId, sourcePath: row.sourcePath, sourceSha256: row.sourceSha256,
      recordPath: row.recordPath, recordRelative: 'project-memory/documents/sessions/rolled.md',
      recordSha256,
    }],
  })}\n`, { mode: 0o600 });
  writeFileSync(join(runDirectory, 'placement-journal.jsonl'), `${JSON.stringify({ event: 'placed', ...row })}\n`, { mode: 0o600 });
  writeFileSync(join(runDirectory, 'incomplete-progress.json'), `${JSON.stringify({
    schemaVersion: 1, observedAt: '2026-08-09T22:00:00.000Z', childFailure: 'exit_72',
    missing: [{ transcriptId: 'retry', sourcePath: join(root, 'retry.jsonl'), status: 'missing_progress' }],
    issues: [], journalMissing: 0, journalUnproven: 0,
  })}\n`, { mode: 0o600 });
  writeFileSync(dispositions, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  writeFileSync(ledger, `${row.transcriptId}\n`, { mode: 0o600 });
  const calls = join(root, 'rollback-calls.txt');
  const drainer = join(root, 'drainer.mjs');
  writeFileSync(drainer, `
    import { appendFileSync, createReadStream, readFileSync, writeFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    const args = process.argv.slice(2);
    const get = (flag) => args[args.indexOf(flag) + 1];
    const rows = readFileSync(get('--rollback-progress'), 'utf8').trim().split('\\n').map(JSON.parse);
    const manifestPath = get('--recovery-manifest');
    const hash = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
    writeFileSync(process.env.WRAP_LEDGER, '', { mode: 0o600 });
    for (const row of rows) appendFileSync(get('--dispositions'), JSON.stringify({
      ...row, status: 'claim_error', detailCode: 'rolled-back-to-recovery',
      recoveryManifest: manifestPath, recoveryManifestSha256: hash,
    }) + '\\n', { mode: 0o600 });
    appendFileSync(process.env.ROLLBACK_CALLS, 'called\\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ rolledBack: rows.length, status: 'claim_error' }) + '\\n');
  `, { mode: 0o700 });
  const lib = join(root, 'wrap-lib.sh');
  writeFileSync(lib, `
    wrap_lock() { d="${root}/rollback.lock"; mkdir "$d" || return 1; printf '%s' "$d|$$|token"; }
    wrap_unlock() { d="\${1%%|*}"; rmdir "$d"; }
  `, { mode: 0o600 });
  process.env.ROLLBACK_CALLS = calls;
  process.env.WRAP_LEDGER = ledger;
  const first = resumePendingFinalizations({
    logDir: join(root, 'runs'), vault, lib, drainer, dispositions, ledgerPath: ledger, timeoutMs: 10_000,
  });
  assert.equal(first[0].status, 'rolled_back');
  assert.equal(readFileSync(ledger, 'utf8'), '');
  assert.equal(readFileSync(calls, 'utf8'), 'called\n');
  assert.equal(JSON.parse(readFileSync(join(runDirectory, 'transaction-resolution.json'), 'utf8')).status, 'rolled_back');
  assert.equal(existsSync(join(runDirectory, 'incomplete-progress-retirement.json')), true);
  assert.deepEqual(inspectPendingTransactions(join(root, 'runs')), []);
  const second = resumePendingFinalizations({
    logDir: join(root, 'runs'), vault, lib, drainer, dispositions, ledgerPath: ledger, timeoutMs: 10_000,
  });
  assert.equal(second.length, 0);
  assert.equal(readFileSync(calls, 'utf8'), 'called\n');
  delete process.env.ROLLBACK_CALLS;
  delete process.env.WRAP_LEDGER;
});

test('startup reconstructs and commits a placed journal row missing from child progress', () => {
  const root = mkdtempSync(join(tmpdir(), 'stack-stray-journal-resume-'));
  const vault = join(root, 'vault');
  mkdirSync(vault);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['commit', '--allow-empty', '-q', '-m', 'base'],
  ]) assert.equal(spawnSync('git', args, { cwd: vault }).status, 0);
  const beforeHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  const transcriptId = '123e4567-e89b-42d3-a456-426614174001';
  const sourcePath = join(root, `${transcriptId}.jsonl`);
  writeFileSync(sourcePath, '{"safe":true}\n', { mode: 0o600 });
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(sourcePath, old, old);
  const recordRelative = 'project-memory/documents/sessions/journal-resume.md';
  const recordPath = join(vault, recordRelative);
  mkdirSync(join(vault, 'project-memory', 'documents', 'sessions'), { recursive: true });
  writeFileSync(recordPath, '# recovered placement\n', { mode: 0o600 });
  const sourceSha256 = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
  const recordSha256 = createHash('sha256').update(readFileSync(recordPath)).digest('hex');
  const mined = {
    transcriptId, sourcePath, status: 'mined', observedAt: '2026-08-09T22:00:00.000Z',
    runId: RUN_ID, project: 'documents', chars: 14, chunks: 1,
    sourceSha256, recordPath, recordSha256, ...PROVIDER_PROOF,
  };
  const runDirectory = join(root, 'runs', 'run-journal-crash');
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(runDirectory, 'sources.txt'), `${sourcePath}\n`, { mode: 0o600 });
  writeFileSync(join(runDirectory, 'progress.jsonl'), '', { mode: 0o600 });
  writeFileSync(join(runDirectory, 'transaction-owner.json'), `${JSON.stringify({
    schemaVersion: 1, createdAt: '2026-08-09T22:00:00.000Z', ownerPid: 999999,
    vaultHead: beforeHead, sources: [{ transcriptId, sourcePath }],
  })}\n`, { mode: 0o600 });
  writeFileSync(join(runDirectory, 'placement-journal.jsonl'), [
    JSON.stringify({
      event: 'intent', transcriptId, sourcePath, observedAt: mined.observedAt, runId: mined.runId,
      project: mined.project, chars: mined.chars, chunks: mined.chunks, sourceSha256,
      desiredRecordPath: recordPath, recordSha256, requestedSlot: mined.requestedSlot,
      provider: mined.provider, resolvedModel: mined.resolvedModel, accountType: mined.accountType,
      failureReason: mined.failureReason, providerAttempts: mined.providerAttempts,
    }),
    '',
  ].join('\n'), { mode: 0o600 });
  const dispositions = join(root, 'dispositions.jsonl');
  const ledger = join(root, 'ledger.txt');
  writeFileSync(dispositions, '', { mode: 0o600 });
  writeFileSync(ledger, `${transcriptId}\n`, { mode: 0o600 });
  const drainer = join(root, 'drainer.mjs');
  writeFileSync(drainer, `
    import { appendFileSync, readFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    const get = (flag) => args[args.indexOf(flag) + 1];
    const rows = (path) => readFileSync(path, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
    if (args.includes('--recover-placement-journal')) {
      const journalPath = get('--recover-placement-journal');
      const events = rows(journalPath);
      const placed = events.filter((row) => row.event === 'placed').map(({ event, ...row }) => row);
      for (const intent of events.filter((row) => row.event === 'intent')) {
        if (!placed.some((row) => row.runId === intent.runId && row.transcriptId === intent.transcriptId)) {
          const { event, desiredRecordPath, ...proof } = intent;
          const recovered = { ...proof, status: 'mined', recordPath: desiredRecordPath };
          appendFileSync(journalPath, JSON.stringify({ event: 'placed', ...recovered }) + '\\n', { mode: 0o600 });
          placed.push(recovered);
        }
      }
      for (const row of placed) appendFileSync(get('--dispositions'), JSON.stringify(row) + '\\n', { mode: 0o600 });
      process.stdout.write(JSON.stringify({ recovered: placed.length, released: 0, active: 0, missing: 0, unproven: 0, status: 'reconciled' }) + '\\n');
    } else if (args.includes('--verify-progress')) {
      process.stdout.write(JSON.stringify({ verified: rows(get('--verify-progress')).length, status: 'mined' }) + '\\n');
    } else if (args.includes('--finalize-progress')) {
      const commit = get('--commit');
      const minedRows = rows(get('--finalize-progress'));
      const prior = rows(get('--dispositions'));
      for (const row of minedRows) {
        if (!prior.some((item) => item.status === 'captured' && item.transcriptId === row.transcriptId && item.commit === commit)) {
          appendFileSync(get('--dispositions'), JSON.stringify({ ...row, status: 'captured', commit, reachability: 'local-head' }) + '\\n', { mode: 0o600 });
        }
      }
      process.stdout.write(JSON.stringify({ finalized: minedRows.length, status: 'captured' }) + '\\n');
    } else process.exit(7);
  `, { mode: 0o700 });
  const lib = join(root, 'wrap-lib.sh');
  writeFileSync(lib, `
    wrap_lock() { d="${root}/journal-resume.lock"; mkdir "$d" || return 1; printf '%s' "$d|$$|token"; }
    wrap_unlock() { d="\${1%%|*}"; rmdir "$d"; }
  `, { mode: 0o600 });
  const scanner = join(root, 'scanner.mjs');
  writeFileSync(scanner, 'process.exit(0);\n', { mode: 0o700 });
  const resumed = resumePendingFinalizations({
    logDir: join(root, 'runs'), vault, lib, drainer, dispositions, ledgerPath: ledger,
    timeoutMs: 20_000, scanner, quiescenceMinutes: 45,
  });
  assert.equal(resumed[0].status, 'captured');
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  assert.notEqual(commit, beforeHead);
  assert.equal(
    spawnSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', commit], { cwd: vault, encoding: 'utf8' }).stdout.trim(),
    recordRelative,
  );
  assert.equal(JSON.parse(readFileSync(join(runDirectory, 'transaction-resolution.json'), 'utf8')).status, 'captured');
});

test('rollback quarantines the exact uncommitted record before claim release', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'stack-stray-rollback-vault-'));
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['commit', '--allow-empty', '-q', '-m', 'base'],
  ]) {
    const result = spawnSync('git', args, { cwd: vault, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const recordRelative = 'project-memory/documents/sessions/record.md';
  const recordPath = join(vault, recordRelative);
  mkdirSync(join(vault, 'project-memory', 'documents', 'sessions'), { recursive: true });
  writeFileSync(recordPath, 'recover me\n', { mode: 0o600 });
  const recordSha256 = createHash('sha256').update(readFileSync(recordPath)).digest('hex');
  const recoveryRoot = mkdtempSync(join(tmpdir(), 'stack-stray-rollback-recovery-'));
  const spec = join(recoveryRoot, 'spec.json');
  const quarantineRoot = join(recoveryRoot, 'records');
  const manifest = join(recoveryRoot, 'manifest.jsonl');
  writeFileSync(spec, `${JSON.stringify({
    quarantineRoot,
    rows: [{ transcriptId: 'one', recordPath, recordRelative, recordSha256 }],
  })}\n`, { mode: 0o600 });
  await rollbackPlacedRecords(spec, manifest, vault);
  const recovered = join(quarantineRoot, recordRelative);
  assert.equal(existsSync(recordPath), false);
  assert.equal(readFileSync(recovered, 'utf8'), 'recover me\n');
  assert.equal(lstatSync(recovered).mode & 0o777, 0o600);
  const proof = JSON.parse(readFileSync(manifest, 'utf8'));
  assert.equal(proof.transcriptId, 'one');
  assert.equal(proof.recordPath, recordPath);
  assert.equal(proof.recoveredPath, recovered);
  assert.equal(proof.recordSha256, recordSha256);
  await rollbackPlacedRecords(spec, manifest, vault);
  assert.equal(readFileSync(manifest, 'utf8').trim().split('\n').length, 1);
  assert.equal(readFileSync(recovered, 'utf8'), 'recover me\n');
});

test('rollback resumes after a crash that moved a record before publishing its manifest', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'stack-stray-rollback-resume-vault-'));
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['commit', '--allow-empty', '-q', '-m', 'base'],
  ]) assert.equal(spawnSync('git', args, { cwd: vault }).status, 0);
  const recordRelative = 'project-memory/documents/sessions/restart.md';
  const recordPath = join(vault, recordRelative);
  const recoveryRoot = mkdtempSync(join(tmpdir(), 'stack-stray-rollback-resume-'));
  const quarantineRoot = join(recoveryRoot, 'records');
  const recoveredPath = join(quarantineRoot, recordRelative);
  mkdirSync(join(vault, 'project-memory', 'documents', 'sessions'), { recursive: true });
  mkdirSync(join(quarantineRoot, 'project-memory', 'documents', 'sessions'), { recursive: true });
  writeFileSync(recoveredPath, 'already moved\n', { mode: 0o600 });
  const recordSha256 = createHash('sha256').update(readFileSync(recoveredPath)).digest('hex');
  const spec = join(recoveryRoot, 'spec.json');
  const manifest = join(recoveryRoot, 'manifest.jsonl');
  writeFileSync(spec, `${JSON.stringify({
    quarantineRoot,
    rows: [{ transcriptId: 'restart', recordPath, recordRelative, recordSha256 }],
  })}\n`, { mode: 0o600 });
  await rollbackPlacedRecords(spec, manifest, vault);
  const proof = JSON.parse(readFileSync(manifest, 'utf8'));
  assert.equal(proof.recoveredPath, recoveredPath);
  assert.equal(proof.recordSha256, recordSha256);
});

test('rollback preserves and rejects a conflicting durable recovery manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stack-stray-rollback-conflict-'));
  const vault = join(root, 'vault');
  mkdirSync(vault);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['commit', '--allow-empty', '-q', '-m', 'base'],
  ]) assert.equal(spawnSync('git', args, { cwd: vault }).status, 0);
  const recordRelative = 'project-memory/documents/sessions/conflict.md';
  const recordPath = join(vault, recordRelative);
  const quarantineRoot = join(root, 'rollback', 'records');
  const recoveredPath = join(quarantineRoot, recordRelative);
  const body = '# retained recovery\n';
  mkdirSync(join(quarantineRoot, 'project-memory', 'documents', 'sessions'), { recursive: true, mode: 0o700 });
  writeFileSync(recoveredPath, body, { mode: 0o600 });
  const spec = join(root, 'rollback-spec.json');
  writeFileSync(spec, `${JSON.stringify({
    schemaVersion: 1,
    beforeHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim(),
    quarantineRoot,
    rows: [{
      transcriptId: 'conflict', sourcePath: join(root, 'source.jsonl'), sourceSha256: 'a'.repeat(64),
      recordPath, recordRelative, recordSha256: createHash('sha256').update(body).digest('hex'),
    }],
  })}\n`, { mode: 0o600 });
  const manifest = join(root, 'recovery-manifest.jsonl');
  const conflicting = '{"preserved":"evidence"}\n';
  writeFileSync(manifest, conflicting, { mode: 0o600 });
  await assert.rejects(
    () => rollbackPlacedRecords(spec, manifest, vault),
    /manifest.*conflicts|conflicts.*manifest/i,
  );
  assert.equal(readFileSync(manifest, 'utf8'), conflicting);
  assert.equal(readFileSync(recoveredPath, 'utf8'), body);
});

test('transaction rechecks source stability and open ownership immediately before commit', () => {
  const vault = mkdtempSync(join(tmpdir(), 'stack-stray-transaction-vault-'));
  const source = join(vault, 'source.jsonl');
  const recordRelative = 'project-memory/documents/sessions/record.md';
  const record = join(vault, recordRelative);
  mkdirSync(join(vault, 'project-memory', 'documents', 'sessions'), { recursive: true });
  writeFileSync(source, '{"safe":true}\n', { mode: 0o600 });
  writeFileSync(record, '# safe\n', { mode: 0o600 });
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(source, old, old);
  const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const spec = join(vault, 'spec.json');
  writeFileSync(spec, `${JSON.stringify({ rows: [{
    transcriptId: 'one',
    sourcePath: source,
    sourceSha256: hash(source),
    recordPath: record,
    recordRelative,
    recordSha256: hash(record),
  }] })}\n`, { mode: 0o600 });
  const scanner = join(vault, 'scanner.mjs');
  writeFileSync(scanner, 'process.exit(0);\n', { mode: 0o700 });
  const execute = (command, args) => {
    if (command === '/usr/sbin/lsof') return { code: 1, stdout: '' };
    if (command === 'git' && args[0] === 'cat-file') return { code: 128, stdout: '' };
    if (command === 'git' && args[0] === 'ls-files') return { code: 0, stdout: `${recordRelative}\n` };
    if (command === process.execPath) return { code: 0, stdout: '' };
    return { code: 127, stdout: '' };
  };
  assert.doesNotThrow(() => verifyTransactionSpec(spec, vault, scanner, 45, execute));
  writeFileSync(source, '{"safe":false}\n', { mode: 0o600 });
  utimesSync(source, old, old);
  assert.throws(() => verifyTransactionSpec(spec, vault, scanner, 45, execute), /source hash changed/i);
  writeFileSync(source, '{"safe":true}\n', { mode: 0o600 });
  utimesSync(source, old, old);
  const openExecute = (command, args) => command === '/usr/sbin/lsof'
    ? { code: 0, stdout: '123\n' }
    : execute(command, args);
  assert.throws(() => verifyTransactionSpec(spec, vault, scanner, 45, openExecute), /source is open/i);
});

test('commit failure rolls back under the vault lock and preserves unrelated staging', () => {
  const f = fixture();
  const source = join(f.project, 'eligible-id.jsonl');
  transcript(source);
  transcript(join(f.project, 'failed-id.jsonl'), 121);
  writeFileSync(f.ledger, '', { mode: 0o600 });

  const vault = join(f.root, 'vault');
  mkdirSync(vault);
  routeProjectToVault(f, vault);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['commit', '--allow-empty', '-q', '-m', 'base'],
  ]) {
    const result = spawnSync('git', args, { cwd: vault, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  writeFileSync(join(vault, 'unrelated.txt'), 'preserve staged state\n');
  assert.equal(spawnSync('git', ['add', '--', 'unrelated.txt'], { cwd: vault }).status, 0);
  const hook = join(vault, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });

  const logDir = join(f.root, 'logs', 'memory-sweep');
  const config = join(f.root, 'config.json');
  writeFileSync(config, JSON.stringify({
    vaultRoot: vault,
    logDir,
    strayDrain: {
      maxPerRun: 2,
      concurrency: 1,
      subscriptionConcurrency: 1,
      quiescenceMinutes: 45,
      perProviderTimeoutMs: 5_000,
      perTranscriptDeadlineMs: 10_000,
      globalDeadlineMs: 20_000,
      maxAttemptsPerProvider: 1,
      maxSourceBytes: 1_000_000,
      chunkChars: 4_000,
      maxChunksPerTranscript: 4,
    },
  }));
  const wrapLib = join(f.root, 'wrap-lib.sh');
  const lockMarker = join(f.root, 'vault.lock');
  writeFileSync(wrapLib, `
    wrap_lock() { d="$FAKE_LOCK_MARKER"; mkdir "$d" || return 1; printf '%s' "$d|$$|token"; }
    wrap_unlock() { d="\${1%%|*}"; rmdir "$d"; }
  `, { mode: 0o600 });
  const scanner = join(f.root, 'scanner.mjs');
  writeFileSync(scanner, 'process.exit(0);\n', { mode: 0o700 });
  const dispositions = join(f.root, 'dispositions.jsonl');
  const drainer = join(f.root, 'drainer.mjs');
  writeFileSync(drainer, `
    import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import { basename, join } from 'node:path';
    const args = process.argv.slice(2);
    const get = (flag) => args[args.indexOf(flag) + 1];
    const hash = (body) => createHash('sha256').update(body).digest('hex');
    if (args.includes('--recover-placement-journal')) {
      if (!existsSync(process.env.FAKE_LOCK_MARKER)) process.exit(9);
      const events = readFileSync(get('--recover-placement-journal'), 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
      const placed = events.filter((item) => item.event === 'placed').map(({ event, ...row }) => row);
      const prior = readFileSync(get('--dispositions'), 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
      for (const row of placed) {
        if (!prior.some((item) => item.status === 'mined' && item.transcriptId === row.transcriptId && item.recordSha256 === row.recordSha256)) {
          appendFileSync(get('--dispositions'), JSON.stringify(row) + '\\n', { mode: 0o600 });
        }
      }
      process.stdout.write(JSON.stringify({ recovered: placed.length, released: 0, active: 0, missing: 0, unproven: 0, status: 'reconciled' }) + '\\n');
    } else if (args.includes('--verify-progress')) {
      if (!existsSync(process.env.FAKE_LOCK_MARKER)) process.exit(9);
      const rows = readFileSync(get('--verify-progress'), 'utf8').trim().split('\\n').map(JSON.parse).filter((row) => row.status === 'mined');
      const dispositions = readFileSync(get('--dispositions'), 'utf8').trim().split('\\n').map(JSON.parse);
      for (const row of rows) {
        const proof = dispositions.find((item) => item.status === 'mined' && item.transcriptId === row.transcriptId && item.recordSha256 === row.recordSha256);
        if (!proof) process.exit(4);
      }
      process.stdout.write(JSON.stringify({ verified: rows.length, status: 'mined' }) + '\\n');
    } else if (args.includes('--finalize-progress')) {
      const rows = readFileSync(get('--finalize-progress'), 'utf8').trim().split('\\n').map(JSON.parse).filter((row) => row.status === 'mined');
      const commit = get('--commit');
      for (const row of rows) appendFileSync(get('--dispositions'), JSON.stringify({ ...row, status: 'captured', commit, reachability: 'local-head' }) + '\\n', { mode: 0o600 });
      process.stdout.write(JSON.stringify({ finalized: rows.length, status: 'captured' }) + '\\n');
    } else if (args.includes('--rollback-progress')) {
      if (!existsSync(process.env.FAKE_LOCK_MARKER)) process.exit(9);
      const rows = readFileSync(get('--rollback-progress'), 'utf8').trim().split('\\n').map(JSON.parse).filter((row) => row.status === 'mined');
      const manifest = readFileSync(get('--recovery-manifest'), 'utf8').trim().split('\\n').map(JSON.parse);
      if (rows.length !== manifest.length) process.exit(3);
      for (const row of rows) {
        const proof = manifest.find((item) => item.transcriptId === row.transcriptId);
        if (!proof || proof.recordPath !== row.recordPath || proof.recordSha256 !== row.recordSha256 || !existsSync(proof.recoveredPath)) process.exit(4);
      }
      writeFileSync(process.env.WRAP_LEDGER, '', { mode: 0o600 });
      const manifestBody = readFileSync(get('--recovery-manifest'));
      const prior = readFileSync(get('--dispositions'), 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
      for (const row of rows) {
        const exists = prior.some((item) => item.transcriptId === row.transcriptId && item.status === 'claim_error' && item.detailCode === 'rolled-back-to-recovery' && item.recoveryManifestSha256 === hash(manifestBody));
        if (!exists) appendFileSync(get('--dispositions'), JSON.stringify({ ...row, status: 'claim_error', detailCode: 'rolled-back-to-recovery', recoveryManifest: get('--recovery-manifest'), recoveryManifestSha256: hash(manifestBody) }) + '\\n', { mode: 0o600 });
      }
      process.stdout.write(JSON.stringify({ rolledBack: rows.length, status: 'claim_error' }) + '\\n');
    } else {
      const sourcePaths = readFileSync(get('--list'), 'utf8').trim().split('\\n');
      const sourcePath = sourcePaths.find((item) => item.endsWith('/eligible-id.jsonl'));
      const failedPath = sourcePaths.find((item) => item.endsWith('/failed-id.jsonl'));
      const id = basename(sourcePath, '.jsonl');
      const sourceBody = readFileSync(sourcePath);
      const sessions = join(process.env.FAKE_VAULT, 'project-memory', 'documents', 'sessions');
      mkdirSync(sessions, { recursive: true, mode: 0o700 });
      const recordPath = join(sessions, 'captured.md');
      const recordBody = Buffer.from('# captured\\n');
      writeFileSync(recordPath, recordBody, { mode: 0o600 });
      chmodSync(recordPath, 0o600);
      appendFileSync(process.env.WRAP_LEDGER, id + '\\n', { mode: 0o600 });
      const row = { transcriptId: id, sourcePath, status: 'mined', observedAt: '2026-08-09T22:00:00.000Z', runId: '${RUN_ID}', project: 'documents', chars: sourceBody.length, chunks: 1, sourceSha256: hash(sourceBody), recordPath, recordSha256: hash(recordBody), requestedSlot: 'bulk_summarize', provider: 'cheap-cli', resolvedModel: null, accountType: 'configured-cli', failureReason: null, providerAttempts: [{ engine: 'cheap', requestedSlot: 'bulk_summarize', provider: 'cheap-cli', resolvedModel: null, accountType: 'configured-cli', outcome: 'success', failureReason: null }] };
      appendFileSync(get('--placement-journal'), JSON.stringify({ event: 'intent', transcriptId: id, sourcePath, observedAt: row.observedAt, runId: row.runId, project: 'documents', chars: sourceBody.length, chunks: 1, sourceSha256: row.sourceSha256, desiredRecordPath: recordPath, recordSha256: row.recordSha256, requestedSlot: row.requestedSlot, provider: row.provider, resolvedModel: row.resolvedModel, accountType: row.accountType, failureReason: row.failureReason, providerAttempts: row.providerAttempts }) + '\\n', { mode: 0o600 });
      appendFileSync(get('--placement-journal'), JSON.stringify({ event: 'placed', ...row }) + '\\n', { mode: 0o600 });
      writeFileSync(get('--out'), JSON.stringify(row) + '\\n', { mode: 0o600 });
      appendFileSync(get('--dispositions'), JSON.stringify(row) + '\\n', { mode: 0o600 });
      appendFileSync(get('--dispositions'), JSON.stringify({ transcriptId: 'failed-id', sourcePath: failedPath, status: 'provider_failed', observedAt: '2026-08-09T22:00:00.000Z', runId: '${RUN_ID}', detailCode: 'provider-exit' }) + '\\n', { mode: 0o600 });
      process.stdout.write(JSON.stringify({ selected: 2, failed: 1 }) + '\\n');
      process.exitCode = 1;
    }
  `, { mode: 0o700 });

  const env = {
    ...process.env,
    STACK_STRAY_CONFIG: config,
    WRAP_PROJECTS_ROOT: f.projects,
    WRAP_LEDGER: f.ledger,
    WRAP_DISPOSITIONS: dispositions,
    WRAP_DRAINER: drainer,
    WRAP_LIB: wrapLib,
    WRAP_SCANNER: scanner,
    FAKE_VAULT: vault,
    FAKE_LOCK_MARKER: lockMarker,
  };
  const result = spawnSync(process.execPath, [WRAPPER], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exact-path vault commit failed: exit_72/i);
  assert.equal(existsSync(join(vault, 'project-memory', 'documents', 'sessions', 'captured.md')), false);
  assert.equal(spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: vault, encoding: 'utf8' }).stdout.trim(), 'unrelated.txt');
  assert.equal(readFileSync(f.ledger, 'utf8'), '');
  assert.equal(existsSync(lockMarker), false);
  const runRoot = join(f.root, 'logs', 'stray-drain');
  const runDirectory = readdirSync(runRoot).find((name) => name.startsWith('run-'));
  const manifest = join(runRoot, runDirectory, 'rollback', 'recovery-manifest.jsonl');
  assert.equal(lstatSync(manifest).mode & 0o777, 0o600);
  const proof = JSON.parse(readFileSync(manifest, 'utf8'));
  assert.equal(proof.transcriptId, 'eligible-id');
  assert.equal(existsSync(proof.recoveredPath), true);
  assert.match(readFileSync(dispositions, 'utf8'), /"status":"claim_error"/);

  writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const success = spawnSync(process.execPath, [WRAPPER], { env, encoding: 'utf8' });
  assert.equal(success.status, 1);
  assert.match(success.stderr, /run incomplete: 1 missing disposition/i);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.equal(
    spawnSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', head], { cwd: vault, encoding: 'utf8' }).stdout.trim(),
    'project-memory/documents/sessions/captured.md',
  );
  assert.equal(spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: vault, encoding: 'utf8' }).stdout.trim(), 'unrelated.txt');
  assert.match(readFileSync(dispositions, 'utf8'), /"status":"captured"/);
  const incompleteReceipts = readdirSync(runRoot)
    .filter((name) => name.startsWith('run-'))
    .map((name) => join(runRoot, name, 'incomplete-progress.json'))
    .filter(existsSync);
  assert.equal(incompleteReceipts.length, 2);
  assert.equal(JSON.parse(readFileSync(incompleteReceipts.at(-1), 'utf8')).missing[0].transcriptId, 'failed-id');
  const retirementReceipts = readdirSync(runRoot)
    .filter((name) => name.startsWith('run-'))
    .map((name) => join(runRoot, name, 'incomplete-progress-retirement.json'))
    .filter(existsSync);
  assert.equal(retirementReceipts.length, 2);
  assert.deepEqual(inspectPendingTransactions(runRoot), []);
});

test('discovery excludes claimed, self, recent, symlink, and nested tool records', () => {
  const f = fixture();
  const vault = join(f.root, 'vault');
  routeProjectToVault(f, vault);
  transcript(join(f.project, 'eligible-id.jsonl'));
  transcript(join(f.project, 'claimed-id.jsonl'));
  transcript(join(f.project, 'self-id.jsonl'));
  transcript(join(f.project, 'recent-id.jsonl'), 5);
  symlinkSync(join(f.project, 'eligible-id.jsonl'), join(f.project, 'linked-id.jsonl'));
  mkdirSync(join(f.project, 'subagents'), { recursive: true });
  transcript(join(f.project, 'subagents', 'nested-id.jsonl'));

  const found = discoverCandidates({
    projectsRoot: f.projects,
    ledgerPath: f.ledger,
    vaultRoot: vault,
    selfIds: new Set(['self-id']),
    quiescenceMinutes: 45,
    nowMs: Date.now(),
  });

  assert.deepEqual(found.map((row) => row.id), ['eligible-id']);
});

test('an unreadable ledger is a hard discovery failure', () => {
  const f = fixture();
  const vault = join(f.root, 'vault');
  routeProjectToVault(f, vault);
  transcript(join(f.project, 'eligible-id.jsonl'));
  assert.throws(
    () => discoverCandidates({
      projectsRoot: f.projects,
      ledgerPath: f.root,
      vaultRoot: vault,
      selfIds: new Set(),
      quiescenceMinutes: 45,
      nowMs: Date.now(),
    }),
    /ledger/i,
  );
});

test('progress parser accepts only the canonical metadata schema and outcomes', () => {
  const expected = [{ id: 'one', path: '/safe/one.jsonl' }];
  const valid = JSON.stringify({
    transcriptId: 'one',
    sourcePath: '/safe/one.jsonl',
    status: 'live_owned',
    observedAt: '2026-08-09T22:00:00.000Z',
    runId: RUN_ID,
  });
  assert.equal(parseProgress(valid + '\n', expected).length, 1);
  assert.equal(parseProgress(JSON.stringify({
    ...JSON.parse(valid),
    status: 'provider_failed',
    providerAttempts: [{
      engine: 'cheap',
      requestedSlot: 'bulk_summarize',
      provider: 'cheap-cli',
      resolvedModel: null,
      accountType: 'configured-cli',
      outcome: 'failed',
      failureReason: 'timeout',
    }],
  }) + '\n', expected).length, 1);
  assert.equal(parseProgress(JSON.stringify({
    ...JSON.parse(valid),
    status: 'proven_duplicate',
    sourceSha256: 'a'.repeat(64),
    recordPath: '/safe/vault/project-memory/documents/sessions/already.md',
    recordSha256: 'b'.repeat(64),
  }) + '\n', expected).length, 1);
  assert.throws(() => parseProgress('{bad}\n', expected), /malformed/i);
  assert.throws(() => parseProgress(valid + '\n' + valid + '\n', expected), /duplicate/i);
  assert.throws(
    () => parseProgress(JSON.stringify({ ...JSON.parse(valid), prompt: 'private' }) + '\n', expected),
    /schema|forbidden/i,
  );
  assert.throws(
    () => parseProgress(JSON.stringify({ ...JSON.parse(valid), status: 'deferred-live' }) + '\n', expected),
    /status/i,
  );
  assert.throws(
    () => parseProgress(JSON.stringify({ ...JSON.parse(valid), observedAt: 'not-a-time' }) + '\n', expected),
    /observedAt/i,
  );
  assert.throws(
    () => parseProgress(JSON.stringify({ ...JSON.parse(valid), note: 'could contain private text' }) + '\n', expected),
    /schema/i,
  );
  assert.throws(
    () => parseProgress(JSON.stringify({
      ...JSON.parse(valid),
      status: 'provider_failed',
      providerAttempts: [{ engine: 'cheap', prompt: 'not metadata' }],
    }) + '\n', expected),
    /providerAttempts|forbidden/i,
  );
  assert.throws(
    () => parseProgress(JSON.stringify({ ...JSON.parse(valid), status: 'mined' }) + '\n', expected),
    /source and record proof/i,
  );
  assert.throws(
    () => parseProgress(JSON.stringify({ ...JSON.parse(valid), recordPath: 'project-memory/x/sessions/y.md' }) + '\n', expected),
    /schema|record proof/i,
  );
  assert.throws(() => parseProgress('', expected), /count/i);
});

test('partial child progress preserves every complete row and reports missing selections', () => {
  const expected = [
    { id: 'placed', path: '/safe/placed.jsonl' },
    { id: 'retry', path: '/safe/retry.jsonl' },
    { id: 'missing', path: '/safe/missing.jsonl' },
  ];
  const mined = {
    transcriptId: 'placed', sourcePath: expected[0].path, status: 'mined',
    observedAt: '2026-08-09T22:00:00.000Z', runId: RUN_ID,
    sourceSha256: 'a'.repeat(64),
    recordPath: '/safe/vault/project-memory/documents/sessions/placed.md',
    recordSha256: 'b'.repeat(64), ...PROVIDER_PROOF,
  };
  const retry = {
    transcriptId: 'retry', sourcePath: expected[1].path, status: 'provider_failed',
    observedAt: '2026-08-09T22:00:00.000Z', runId: RUN_ID,
    detailCode: 'provider-timeout',
  };
  const result = reconcileRunEvidence({
    progressRaw: `${JSON.stringify(mined)}\n${JSON.stringify(retry)}\n{truncated`,
    journalRaw: `${JSON.stringify({ event: 'placed', ...mined })}\n`,
    expected,
  });
  assert.deepEqual(result.rows.map((row) => [row.transcriptId, row.status]), [
    ['placed', 'mined'],
    ['retry', 'provider_failed'],
  ]);
  assert.deepEqual(result.missing.map((row) => row.transcriptId), ['missing']);
  assert.equal(result.issues.some((issue) => issue.kind === 'malformed_progress'), true);
});

test('conflicting progress and placed journal proofs are never commit eligible', () => {
  const expected = [{ id: 'placed', path: '/safe/placed.jsonl' }];
  const progress = {
    transcriptId: 'placed', sourcePath: expected[0].path, status: 'mined',
    observedAt: '2026-08-09T22:00:00.000Z', runId: RUN_ID,
    sourceSha256: 'a'.repeat(64),
    recordPath: '/safe/vault/project-memory/documents/sessions/progress.md',
    recordSha256: 'b'.repeat(64), ...PROVIDER_PROOF,
  };
  const placed = {
    ...progress,
    recordPath: '/safe/vault/project-memory/documents/sessions/journal.md',
    recordSha256: 'c'.repeat(64),
  };
  const result = reconcileRunEvidence({
    progressRaw: `${JSON.stringify(progress)}\n`,
    journalRaw: `${JSON.stringify({ event: 'placed', ...placed })}\n`,
    expected,
  });
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.blockedTranscriptIds, ['placed']);
  assert.equal(result.missing[0].detailCode, 'evidence_conflict');
  assert.equal(result.issues.some((issue) => issue.kind === 'journal_progress_conflict'), true);
});

test('multiple conflicting placement intents block even a matching placed row', () => {
  const expected = [{ id: 'placed', path: '/safe/placed.jsonl' }];
  const intent = {
    event: 'intent', transcriptId: 'placed', sourcePath: expected[0].path,
    observedAt: '2026-08-09T22:00:00.000Z', runId: RUN_ID,
    project: 'documents', chars: 42, chunks: 1, sourceSha256: 'a'.repeat(64),
    desiredRecordPath: '/safe/vault/project-memory/documents/sessions/placed.md',
    recordSha256: 'b'.repeat(64), ...PROVIDER_PROOF,
  };
  const { event: _event, desiredRecordPath: recordPath, ...proof } = intent;
  const placed = { ...proof, status: 'mined', recordPath };
  const conflicting = {
    ...intent,
    desiredRecordPath: '/safe/vault/project-memory/documents/sessions/other.md',
    recordSha256: 'c'.repeat(64),
  };
  const result = reconcileRunEvidence({
    progressRaw: '',
    journalRaw: `${JSON.stringify(intent)}\n${JSON.stringify(conflicting)}\n${JSON.stringify({ event: 'placed', ...placed })}\n`,
    expected,
  });
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.blockedTranscriptIds, ['placed']);
  assert.equal(result.issues.some((issue) => issue.kind === 'conflicting_journal_intent'), true);
});

test('placement intent remains explicit when a kill occurs before placed proof', () => {
  const expected = [{ id: 'placed', path: '/safe/placed.jsonl' }];
  const intent = {
    event: 'intent', transcriptId: 'placed', sourcePath: expected[0].path,
    observedAt: '2026-08-09T22:00:00.000Z', runId: RUN_ID,
    project: 'documents', chars: 42, chunks: 1,
    sourceSha256: 'a'.repeat(64),
    desiredRecordPath: '/safe/vault/project-memory/documents/sessions/placed.md',
    recordSha256: 'b'.repeat(64),
    ...PROVIDER_PROOF,
  };
  const result = reconcileRunEvidence({ progressRaw: '', journalRaw: `${JSON.stringify(intent)}\n`, expected });
  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.intents, [intent]);
  assert.equal(result.missing[0].detailCode, 'placement_intent_unresolved');
});

test('dead-owner claim recovery proof completes a claim-intent-only selection', () => {
  const f = fixture();
  const sourcePath = join(f.project, 'released.jsonl');
  const dispositions = join(f.root, 'dispositions.jsonl');
  const claimIntent = {
    event: 'claim_intent', transcriptId: 'released', sourcePath,
    observedAt: '2026-08-09T22:00:00.000Z', runId: RUN_ID, ownerPid: 999999,
  };
  const released = {
    transcriptId: 'released', sourcePath, status: 'claim_error',
    observedAt: claimIntent.observedAt, runId: RUN_ID,
    detailCode: 'recovered-dead-owner-before-placement',
  };
  writeFileSync(dispositions, `${JSON.stringify(released)}\n`, { mode: 0o600 });
  const supplementalRows = selectReleasedClaimRows(dispositions, [claimIntent]);
  const result = reconcileRunEvidence({
    progressRaw: '',
    journalRaw: `${JSON.stringify(claimIntent)}\n${JSON.stringify({ ...claimIntent, event: 'claim_acquired' })}\n`,
    expected: [{ id: 'released', path: sourcePath }],
    supplementalRows,
  });
  assert.deepEqual(result.rows, [released]);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.issues, []);
});

test('claim intent without acquisition proof remains unproven and non-releasable', () => {
  const sourcePath = '/safe/unproven.jsonl';
  const claimIntent = {
    event: 'claim_intent', transcriptId: 'unproven', sourcePath,
    observedAt: '2026-08-09T22:00:00.000Z', runId: RUN_ID, ownerPid: 999999,
  };
  const result = reconcileRunEvidence({
    progressRaw: '',
    journalRaw: `${JSON.stringify(claimIntent)}\n`,
    expected: [{ id: 'unproven', path: sourcePath }],
  });
  assert.deepEqual(result.rows, []);
  assert.equal(result.missing[0].detailCode, 'claim_intent_unproven');
  assert.deepEqual(result.claimAcquired, []);
});

function wrapperEnvironment(f, fakeBody) {
  const vault = join(f.root, 'vault');
  const logDir = join(f.root, 'logs', 'memory-sweep');
  mkdirSync(vault, { recursive: true });
  routeProjectToVault(f, vault);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['commit', '--allow-empty', '-q', '-m', 'base'],
  ]) assert.equal(spawnSync('git', args, { cwd: vault }).status, 0);
  const config = join(f.root, 'config.json');
  writeFileSync(config, JSON.stringify({
    vaultRoot: vault,
    logDir,
    strayDrain: {
      maxPerRun: 10,
      concurrency: 2,
      subscriptionConcurrency: 1,
      quiescenceMinutes: 45,
      perProviderTimeoutMs: 5_000,
      perTranscriptDeadlineMs: 10_000,
      globalDeadlineMs: 20_000,
      maxAttemptsPerProvider: 1,
      maxSourceBytes: 1_000_000,
      chunkChars: 4_000,
      maxChunksPerTranscript: 4,
    },
  }));
  const fake = join(f.root, 'fake-drainer.mjs');
  writeFileSync(fake, fakeBody, { mode: 0o700 });
  return {
    ...process.env,
    STACK_STRAY_CONFIG: config,
    WRAP_PROJECTS_ROOT: f.projects,
    WRAP_LEDGER: f.ledger,
    WRAP_DISPOSITIONS: join(f.root, 'dispositions.jsonl'),
    WRAP_DRAINER: fake,
    WRAP_LIB: fileURLToPath(new URL('../../../skills/wrap/lib/wrap-lib.sh', import.meta.url)),
  };
}

test('dry run is a strictly read-only census and never invokes recovery or the drainer', () => {
  const f = fixture();
  transcript(join(f.project, 'eligible-id.jsonl'));
  const env = wrapperEnvironment(f, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.FORBIDDEN_DRainer_MARKER, 'invoked');
    process.exit(9);
  `);
  const marker = join(f.root, 'drainer-invoked');
  env.FORBIDDEN_DRainer_MARKER = marker;
  const before = readFileSync(f.ledger, 'utf8');
  const result = spawnSync(process.execPath, [WRAPPER, '--dry-run'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.ledger, 'utf8'), before);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(f.root, 'logs', 'stray-drain')), false);
  assert.match(result.stdout, /dry run census.*eligible 1.*selected 1.*pending 0/i);
});

test('a nonzero drainer blocks parsing and Git mutation', () => {
  const f = fixture();
  transcript(join(f.project, 'eligible-id.jsonl'));
  const env = wrapperEnvironment(f, 'process.exit(7);');
  const result = spawnSync(process.execPath, [WRAPPER], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /run incomplete: 1 missing disposition/i);
});

test('main never stages or commits a row with conflicting progress and journal proof', () => {
  const f = fixture();
  const sourcePath = join(f.project, 'eligible-id.jsonl');
  transcript(sourcePath);
  writeFileSync(f.ledger, '', { mode: 0o600 });
  const env = wrapperEnvironment(f, `
    import { createHash } from 'node:crypto';
    import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { basename, join } from 'node:path';
    const args = process.argv.slice(2);
    const get = (flag) => args[args.indexOf(flag) + 1];
    const hash = (body) => createHash('sha256').update(body).digest('hex');
    if (args.includes('--recover-placement-journal')) {
      writeFileSync(get('--dispositions'), '', { flag: 'a', mode: 0o600 });
      process.stdout.write(JSON.stringify({ recovered: 0, released: 0, active: 0, missing: 0, unproven: 0, status: 'reconciled' }) + '\\n');
    } else {
      const sourcePath = readFileSync(get('--list'), 'utf8').trim();
      const sourceBody = readFileSync(sourcePath);
      const id = basename(sourcePath, '.jsonl');
      const sessions = join(process.env.FAKE_VAULT, 'project-memory', 'documents', 'sessions');
      mkdirSync(sessions, { recursive: true, mode: 0o700 });
      const progressPath = join(sessions, 'progress.md');
      const journalPath = join(sessions, 'journal.md');
      writeFileSync(progressPath, '# progress\\n', { mode: 0o600 });
      writeFileSync(journalPath, '# journal\\n', { mode: 0o600 });
      const base = { transcriptId: id, sourcePath, status: 'mined',
        observedAt: '2026-08-09T22:00:00.000Z', runId: '${RUN_ID}',
        sourceSha256: hash(sourceBody), requestedSlot: 'bulk_summarize', provider: 'cheap-cli',
        resolvedModel: null, accountType: 'configured-cli', failureReason: null,
        providerAttempts: [{ engine: 'cheap', requestedSlot: 'bulk_summarize', provider: 'cheap-cli',
          resolvedModel: null, accountType: 'configured-cli', outcome: 'success', failureReason: null }] };
      const progress = { ...base, recordPath: progressPath, recordSha256: hash(readFileSync(progressPath)) };
      const placed = { ...base, recordPath: journalPath, recordSha256: hash(readFileSync(journalPath)) };
      writeFileSync(get('--out'), JSON.stringify(progress) + '\\n', { mode: 0o600 });
      appendFileSync(get('--placement-journal'), JSON.stringify({ event: 'placed', ...placed }) + '\\n', { mode: 0o600 });
    }
  `);
  const wrapLib = join(f.root, 'conflict-wrap-lib.sh');
  writeFileSync(wrapLib, `
    wrap_lock() { d="${f.root}/conflict.lock"; mkdir "$d" || return 1; printf '%s' "$d|$$|token"; }
    wrap_unlock() { d="\${1%%|*}"; rmdir "$d"; }
  `, { mode: 0o600 });
  env.WRAP_LIB = wrapLib;
  env.FAKE_VAULT = JSON.parse(readFileSync(env.STACK_STRAY_CONFIG, 'utf8')).vaultRoot;
  env.WRAP_DISPOSITIONS = join(f.root, 'dispositions.jsonl');
  const vault = env.FAKE_VAULT;
  const before = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  const result = spawnSync(process.execPath, [WRAPPER], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /conflicting evidence|malformed or conflicting evidence/i);
  assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim(), before);
  assert.equal(spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: vault, encoding: 'utf8' }).stdout.trim(), '');
  const runRoot = join(f.root, 'logs', 'stray-drain');
  const runDirectory = readdirSync(runRoot).find((name) => name.startsWith('run-'));
  assert.equal(existsSync(join(runRoot, runDirectory, 'transaction-resolution.json')), false);
});
