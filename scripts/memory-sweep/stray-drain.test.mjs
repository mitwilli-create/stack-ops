import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';

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
import * as coordinator from './stray-drain.mjs';

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

function snapshotTree(root) {
  const rows = [];
  const visit = (path, relativePath) => {
    const stat = fs.lstatSync(path, { bigint: true });
    const base = {
      path: relativePath || '.',
      mode: stat.mode.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    };
    if (stat.isSymbolicLink()) {
      rows.push({ ...base, type: 'symlink', target: fs.readlinkSync(path) });
      return;
    }
    if (stat.isDirectory()) {
      rows.push({ ...base, type: 'directory' });
      for (const name of fs.readdirSync(path).sort()) {
        visit(join(path, name), relativePath ? join(relativePath, name) : name);
      }
      return;
    }
    rows.push({
      ...base,
      type: 'file',
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    });
  };
  visit(root, '');
  return rows;
}

test('coordinator arguments accept only the explicit normal, targeted, and legacy grammars', () => {
  assert.equal(typeof coordinator.parseCoordinatorArgs, 'function');
  assert.deepEqual(coordinator.parseCoordinatorArgs([]), {
    mode: 'default', dryRun: false, limit: null, idsFile: null,
  });
  assert.deepEqual(coordinator.parseCoordinatorArgs(['--dry-run', '--limit', '7']), {
    mode: 'default', dryRun: true, limit: 7, idsFile: null,
  });
  assert.deepEqual(coordinator.parseCoordinatorArgs(['--ids-file', '/safe/requested ids', '--dry-run']), {
    mode: 'targeted', dryRun: true, limit: null, idsFile: '/safe/requested ids',
  });
  assert.deepEqual(coordinator.parseCoordinatorArgs(['--reconcile-legacy']), {
    mode: 'legacy', dryRun: false, limit: null, idsFile: null,
  });

  const rejected = [
    ['--unknown'],
    ['positional'],
    ['--dry-run', '--dry-run'],
    ['--limit'],
    ['--limit', '0'],
    ['--limit', '01'],
    ['--limit', '2', '--limit', '3'],
    ['--ids-file'],
    ['--ids-file', '/safe/a', '--ids-file', '/safe/b'],
    ['--ids-file', '/safe/a', '--limit', '1'],
    ['--dry-run=true'],
    ['--limit=2'],
    ['--ids-file=/safe/a'],
    ['--reconcile-legacy', '--dry-run'],
    ['--reconcile-legacy', '--ids-file', '/safe/a'],
    ['--ids-file', '/safe/private\nvalue'],
    ['--ids-file', '/safe/private\u0085value'],
    ['--ids-file', '/safe/private\u009bvalue'],
  ];
  for (const argv of rejected) {
    assert.throws(() => coordinator.parseCoordinatorArgs(argv), /invalid coordinator arguments/i);
  }
  assert.throws(
    () => coordinator.parseCoordinatorArgs(['--ids-file', '/safe/private\nvalue']),
    (error) => !error.message.includes('private') && !error.message.includes('value'),
  );
});

test('requested identifiers require one stable private canonical identifier per line', () => {
  assert.equal(typeof coordinator.readRequestedIds, 'function');
  const root = mkdtempSync(join(tmpdir(), 'stack-stray-requested-ids-'));
  const requested = join(root, 'requested.txt');
  const first = '123e4567-e89b-42d3-a456-426614174000';
  const second = '123e4567-e89b-42d3-a456-426614174001';
  writeFileSync(requested, `${first}\n${second}\n`, { mode: 0o600 });
  assert.deepEqual(coordinator.readRequestedIds(requested), [first, second]);

  for (const control of ['\u0085', '\u009b']) {
    let touchedFilesystem = false;
    assert.throws(
      () => coordinator.readRequestedIds(`${requested}${control}`, {
        fileOps: {
          lstatSync() {
            touchedFilesystem = true;
            throw new Error('unexpected filesystem access');
          },
        },
      }),
      /invalid requested identifiers file/i,
    );
    assert.equal(touchedFilesystem, false);
  }

  chmodSync(requested, 0o644);
  assert.throws(() => coordinator.readRequestedIds(requested), /invalid requested identifiers file/i);
  chmodSync(requested, 0o600);

  const specialMode = (stat) => ({
    ...stat,
    mode: stat.mode | 0o4000n,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  const specialModeFileOps = {
    lstatSync: (path, options) => specialMode(fs.lstatSync(path, options)),
    openSync: fs.openSync,
    fstatSync: (fd, options) => specialMode(fs.fstatSync(fd, options)),
    readFileSync: fs.readFileSync,
    closeSync: fs.closeSync,
  };
  assert.throws(
    () => coordinator.readRequestedIds(requested, { fileOps: specialModeFileOps }),
    /invalid requested identifiers file/i,
  );

  const link = join(root, 'requested-link.txt');
  symlinkSync(requested, link);
  assert.throws(() => coordinator.readRequestedIds(link), /invalid requested identifiers file/i);

  for (const body of [
    `${first}\n${second}`,
    `${first.toUpperCase()}\n`,
    `${first}\n${first}\n`,
    `${first}\n\n`,
    `${first}\u0000\n`,
  ]) {
    writeFileSync(requested, body, { mode: 0o600 });
    assert.throws(() => coordinator.readRequestedIds(requested), /invalid requested identifiers file/i);
  }

  writeFileSync(requested, `${first}\n`, { mode: 0o600 });
  assert.throws(
    () => coordinator.readRequestedIds(requested, { maxBytes: 8 }),
    /invalid requested identifiers file/i,
  );

  const maxBytes = 64;
  const growingBody = Buffer.alloc(maxBytes * 4, 0x61);
  let bytesConsumed = 0;
  const growingFileOps = {
    lstatSync: fs.lstatSync,
    openSync: fs.openSync,
    fstatSync: fs.fstatSync,
    closeSync: fs.closeSync,
    readFileSync() {
      bytesConsumed = growingBody.length;
      return growingBody;
    },
    readSync(_fd, buffer, offset, length) {
      const count = Math.min(length, growingBody.length - bytesConsumed);
      growingBody.copy(buffer, offset, bytesConsumed, bytesConsumed + count);
      bytesConsumed += count;
      return count;
    },
  };
  assert.throws(
    () => coordinator.readRequestedIds(requested, { maxBytes, fileOps: growingFileOps }),
    /invalid requested identifiers file/i,
  );
  assert.equal(bytesConsumed, maxBytes + 1);

  const replacement = join(root, 'replacement.txt');
  writeFileSync(requested, `${first}\n`, { mode: 0o600 });
  writeFileSync(replacement, `${second}\n`, { mode: 0o600 });
  let replaced = false;
  const replacingFileOps = {
    lstatSync: fs.lstatSync,
    openSync: fs.openSync,
    fstatSync: fs.fstatSync,
    closeSync: fs.closeSync,
    readSync(fd, buffer, offset, length, position) {
      const count = fs.readSync(fd, buffer, offset, length, position);
      if (!replaced) {
        fs.renameSync(replacement, requested);
        replaced = true;
      }
      return count;
    },
  };
  assert.throws(
    () => coordinator.readRequestedIds(requested, { fileOps: replacingFileOps }),
    /invalid requested identifiers file/i,
  );
  assert.throws(
    () => coordinator.readRequestedIds(requested, { maxBytes: 8 }),
    (error) => !error.message.includes(first) && !error.message.includes(second),
  );
});

test('requested selection preserves file order and refuses ineligible, ambiguous, or unsafe candidates', () => {
  assert.equal(typeof coordinator.selectRequestedCandidates, 'function');
  const root = fs.realpathSync(mkdtempSync(join(tmpdir(), 'stack-stray-requested-selection-')));
  const first = '123e4567-e89b-42d3-a456-426614174000';
  const second = '123e4567-e89b-42d3-a456-426614174001';
  const firstPath = join(root, `${first}.jsonl`);
  const secondPath = join(root, `${second}.jsonl`);
  transcript(firstPath);
  transcript(secondPath, 121);
  const candidate = (id, path) => {
    const stat = lstatSync(path);
    return { id, path, mtimeMs: stat.mtimeMs, size: stat.size };
  };
  for (const control of ['\u0085', '\u009b']) {
    const controlledRoot = fs.realpathSync(mkdtempSync(join(tmpdir(), `stack-stray-${control}-`)));
    const controlledPath = join(controlledRoot, `${first}.jsonl`);
    transcript(controlledPath);
    assert.throws(
      () => coordinator.selectRequestedCandidates([first], [candidate(first, controlledPath)]),
      /unsafe/i,
    );
  }
  const candidates = [candidate(first, firstPath), candidate(second, secondPath)];
  const selected = coordinator.selectRequestedCandidates([second, first], candidates);
  assert.deepEqual(selected.map(({ id, path }) => [id, path]), [
    [second, secondPath],
    [first, firstPath],
  ]);

  for (const requested of [[first, '123e4567-e89b-42d3-a456-426614174099'], [first]]) {
    const available = requested.length === 1 ? [] : candidates;
    assert.throws(
      () => coordinator.selectRequestedCandidates(requested, available),
      /requested candidate is not currently eligible/i,
    );
  }

  const alternateRoot = fs.realpathSync(mkdtempSync(join(tmpdir(), 'stack-stray-requested-duplicate-')));
  const alternatePath = join(alternateRoot, `${first}.jsonl`);
  transcript(alternatePath, 122);
  assert.throws(
    () => coordinator.selectRequestedCandidates([first], [candidate(first, firstPath), candidate(first, alternatePath)]),
    /ambiguous/i,
  );

  assert.throws(
    () => coordinator.selectRequestedCandidates([first], [{ ...candidate(first, firstPath), size: 999 }]),
    /unsafe/i,
  );
  assert.throws(
    () => coordinator.selectRequestedCandidates([first], [{ ...candidate(first, firstPath), path: secondPath }]),
    /unsafe/i,
  );
  for (const error of [
    () => coordinator.selectRequestedCandidates([first], []),
    () => coordinator.selectRequestedCandidates([first], [candidate(first, firstPath), candidate(first, alternatePath)]),
  ]) {
    assert.throws(error, (failure) => !failure.message.includes(first));
  }
});

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

test('legacy run artifacts bind one private Stack-owned run and token', () => {
  assert.equal(typeof coordinator.createLegacyRunArtifacts, 'function');
  const root = mkdtempSync(join(tmpdir(), 'stack-legacy-runs-'));
  const stateRoot = join(root, 'state');
  const ledgerPath = join(root, 'ledger.txt');
  const dispositionsPath = join(root, 'dispositions.jsonl');
  const drainerPath = join(root, 'drainer.mjs');
  const vaultPath = join(root, 'vault');
  const vaultHead = 'a'.repeat(40);
  const tuning = {
    maxPerRun: 10, concurrency: 2, subscriptionConcurrency: 1,
    quiescenceMinutes: 45, perProviderTimeoutMs: 5_000,
    perTranscriptDeadlineMs: 10_000, maxAttemptsPerProvider: 1,
    maxSourceBytes: 1_000_000, chunkChars: 4_000, maxChunksPerTranscript: 4,
  };
  const first = coordinator.createLegacyRunArtifacts(root, {
    stateRoot, ledgerPath, dispositionsPath, drainerPath, vaultPath, vaultHead, tuning,
  });
  const second = coordinator.createLegacyRunArtifacts(root, {
    stateRoot, ledgerPath, dispositionsPath, drainerPath, vaultPath, vaultHead, tuning,
  });
  assert.notEqual(first.runDirectory, second.runDirectory);
  assert.match(first.runId, /^[0-9a-f-]{36}$/);
  assert.match(first.token, /^[a-f0-9]{64}$/);
  for (const path of [
    first.runDirectory, first.progress, first.placementJournal,
    first.transactionOwner, first.legacyRun,
  ]) {
    assert.equal(lstatSync(path).mode & 0o777, path === first.runDirectory ? 0o700 : 0o600);
    assert.equal(lstatSync(path).isSymbolicLink(), false);
  }
  assert.deepEqual(JSON.parse(readFileSync(first.progress, 'utf8')), {
    legacyProgressVersion: 1, event: 'marker', runId: first.runId, token: first.token,
  });
  assert.deepEqual(JSON.parse(readFileSync(first.placementJournal, 'utf8')), {
    legacyPlacementVersion: 1, event: 'marker', runId: first.runId, token: first.token,
  });
  const owner = JSON.parse(readFileSync(first.transactionOwner, 'utf8'));
  assert.deepEqual(owner.sources, []);
  const marker = JSON.parse(readFileSync(first.legacyRun, 'utf8'));
  assert.deepEqual(marker, {
    legacyRunVersion: 1,
    event: 'legacy_run',
    createdAt: marker.createdAt,
    ownerPid: process.pid,
    vaultHead,
    runId: first.runId,
    token: first.token,
    stateRoot,
    ledgerPath,
    dispositionsPath,
    drainerPath,
    vaultPath,
    tuning,
    progressPath: first.progress,
    placementJournalPath: first.placementJournal,
  });
});

test('legacy recovery rejects unsafe metadata modes and symbolic links', () => {
  assert.equal(typeof coordinator.readLegacyRunMarker, 'function');
  assert.equal(typeof coordinator.legacyTransactionOwnerIsActive, 'function');
  const root = mkdtempSync(join(tmpdir(), 'stack-legacy-unsafe-'));
  const tuning = {
    maxPerRun: 10, concurrency: 2, subscriptionConcurrency: 1,
    quiescenceMinutes: 45, perProviderTimeoutMs: 5_000,
    perTranscriptDeadlineMs: 10_000, maxAttemptsPerProvider: 1,
    maxSourceBytes: 1_000_000, chunkChars: 4_000, maxChunksPerTranscript: 4,
  };
  const artifacts = coordinator.createLegacyRunArtifacts(root, {
    stateRoot: join(root, 'state'), ledgerPath: join(root, 'ledger'),
    dispositionsPath: join(root, 'dispositions'), drainerPath: join(root, 'drainer'),
    vaultPath: join(root, 'vault'), vaultHead: 'a'.repeat(40), tuning,
  });
  chmodSync(artifacts.runDirectory, 0o500);
  assert.throws(
    () => coordinator.readLegacyRunMarker(artifacts.runDirectory),
    /directory is not private/i,
  );
  chmodSync(artifacts.runDirectory, 0o700);
  chmodSync(artifacts.runDirectory, 0o1700);
  assert.throws(
    () => coordinator.readLegacyRunMarker(artifacts.runDirectory),
    /directory is not private/i,
  );
  chmodSync(artifacts.runDirectory, 0o700);
  chmodSync(artifacts.transactionOwner, 0o640);
  assert.throws(
    () => coordinator.legacyTransactionOwnerIsActive(artifacts.runDirectory),
    /exact private regular file/i,
  );
  chmodSync(artifacts.transactionOwner, 0o600);
  const ownerHardlink = join(artifacts.runDirectory, 'owner-hardlink.json');
  fs.linkSync(artifacts.transactionOwner, ownerHardlink);
  assert.throws(
    () => coordinator.legacyTransactionOwnerIsActive(artifacts.runDirectory),
    /exact private regular file/i,
  );
  fs.unlinkSync(ownerHardlink);
  chmodSync(artifacts.progress, 0o640);
  assert.throws(
    () => coordinator.readLegacyRunMarker(artifacts.runDirectory),
    /exact private regular file/i,
  );
  chmodSync(artifacts.progress, 0o600);
  const savedMarker = join(artifacts.runDirectory, 'saved-marker.json');
  fs.renameSync(artifacts.legacyRun, savedMarker);
  symlinkSync(savedMarker, artifacts.legacyRun);
  assert.throws(
    () => coordinator.readLegacyRunMarker(artifacts.runDirectory),
    /legacy run marker/i,
  );
  const unsafeRoot = mkdtempSync(join(tmpdir(), 'stack-legacy-root-mode-'));
  chmodSync(unsafeRoot, 0o750);
  assert.throws(() => coordinator.createLegacyRunArtifacts(unsafeRoot, {
    stateRoot: join(unsafeRoot, 'state'), ledgerPath: join(unsafeRoot, 'ledger'),
    dispositionsPath: join(unsafeRoot, 'dispositions'), drainerPath: join(unsafeRoot, 'drainer'),
    vaultPath: join(unsafeRoot, 'vault'), vaultHead: 'a'.repeat(40), tuning,
  }), /root directory is not private/i);
  const boundedRoot = mkdtempSync(join(tmpdir(), 'stack-legacy-root-bounds-'));
  assert.throws(() => coordinator.createLegacyRunArtifacts(boundedRoot, {
    stateRoot: join(boundedRoot, 'state'), ledgerPath: join(boundedRoot, 'ledger'),
    dispositionsPath: join(boundedRoot, 'dispositions'), drainerPath: join(boundedRoot, 'drainer'),
    vaultPath: join(boundedRoot, 'vault'), vaultHead: 'a'.repeat(40),
    tuning: { ...tuning, maxPerRun: 401 },
  }), /invalid legacy run metadata/i);
});

test('legacy adoption receipt is one exact counts-only line', () => {
  assert.equal(typeof coordinator.parseLegacyAdoptionReceipt, 'function');
  assert.deepEqual(coordinator.parseLegacyAdoptionReceipt(`${JSON.stringify({
    selected: 2,
    processed: 2,
    pending: 1,
    counts: { mined: 1, proven_duplicate: 1 },
    status: 'needs_commit',
  })}\n`), {
    selected: 2,
    processed: 2,
    pending: 1,
    counts: { mined: 1, proven_duplicate: 1 },
    status: 'needs_commit',
  });
  assert.deepEqual(coordinator.parseLegacyAdoptionReceipt(`${JSON.stringify({
    selected: 0, processed: 0, pending: 0, counts: {}, status: 'reconciled',
  })}\n`), {
    selected: 0, processed: 0, pending: 0, counts: {}, status: 'reconciled',
  });
  const invalid = [
    '',
    '{}\n',
    '{"selected":0}\nextra\n',
    `${JSON.stringify({ selected: 1, processed: 0, pending: 0, counts: {}, status: 'reconciled' })}\n`,
    `${JSON.stringify({ selected: 1, processed: 1, pending: 0, counts: { mined: 1 }, status: 'reconciled' })}\n`,
    `${JSON.stringify({ selected: 1, processed: 1, pending: 1, counts: { mined: 0, proven_duplicate: 1 }, status: 'needs_commit' })}\n`,
    `${JSON.stringify({ selected: 1, processed: 1, pending: 0, counts: { unknown: 1 }, status: 'reconciled' })}\n`,
    `${JSON.stringify({ selected: 1, processed: 1, pending: 0, counts: { proven_duplicate: 1 }, status: 'needs_commit' })}\n`,
    `${JSON.stringify({ selected: 0, processed: 0, pending: 0, counts: {}, status: 'reconciled', transcriptId: 'private' })}\n`,
    `${JSON.stringify({ selected: 401, processed: 401, pending: 0, counts: { proven_duplicate: 401 }, status: 'reconciled' })}\n`,
  ];
  for (const raw of invalid) {
    assert.throws(() => coordinator.parseLegacyAdoptionReceipt(raw), /invalid legacy adoption receipt/i);
  }
});

test('legacy evidence requires exact run token markers and matching placement proof', () => {
  assert.equal(typeof coordinator.reconcileLegacyEvidence, 'function');
  const runId = '123e4567-e89b-42d3-a456-426614174099';
  const token = 'd'.repeat(64);
  const minedId = '123e4567-e89b-42d3-a456-426614174094';
  const missingId = '123e4567-e89b-42d3-a456-426614174095';
  const mined = {
    transcriptId: minedId,
    sourcePath: `/safe/${minedId}.jsonl`,
    status: 'mined',
    observedAt: '2026-08-09T22:00:00.000Z',
    runId,
    sourceSha256: 'a'.repeat(64),
    recordPath: '/safe/vault/project-memory/documents/sessions/legacy-mined.md',
    recordSha256: 'b'.repeat(64),
    project: 'documents',
    chars: 10,
    chunks: 1,
    ...PROVIDER_PROOF,
  };
  const missing = {
    transcriptId: missingId,
    sourcePath: null,
    status: 'legacy_source_missing',
    observedAt: '2026-08-09T22:00:00.000Z',
    runId,
    legacyLedgerSha256: 'd'.repeat(64),
    censusSha256: 'c'.repeat(64),
  };
  const progressMarker = { legacyProgressVersion: 1, event: 'marker', runId, token };
  const placementMarker = { legacyPlacementVersion: 1, event: 'marker', runId, token };
  const intent = {
    legacyPlacementVersion: 1,
    event: 'intent',
    token,
    transcriptId: mined.transcriptId,
    sourcePath: mined.sourcePath,
    observedAt: mined.observedAt,
    runId,
    project: mined.project,
    chars: mined.chars,
    chunks: mined.chunks,
    sourceSha256: mined.sourceSha256,
    desiredRecordPath: mined.recordPath,
    recordSha256: mined.recordSha256,
    requestedSlot: mined.requestedSlot,
    provider: mined.provider,
    resolvedModel: mined.resolvedModel,
    accountType: mined.accountType,
    failureReason: mined.failureReason,
    providerAttempts: mined.providerAttempts,
  };
  const placed = {
    legacyPlacementVersion: 1,
    event: 'placed',
    token,
    ...mined,
  };
  const receipt = {
    selected: 2, processed: 2, pending: 1,
    counts: { mined: 1, legacy_source_missing: 1 }, status: 'needs_commit',
  };
  const progressRaw = [progressMarker, mined, missing, ''].map((row) => (
    typeof row === 'string' ? row : JSON.stringify(row)
  )).join('\n');
  const placementRaw = [placementMarker, intent, placed, ''].map((row) => (
    typeof row === 'string' ? row : JSON.stringify(row)
  )).join('\n');
  const evidence = coordinator.reconcileLegacyEvidence({
    progressRaw, placementRaw, receipt, runId, token,
  });
  assert.deepEqual(evidence.rows, [mined, missing]);
  assert.deepEqual(evidence.mined, [mined]);
  assert.throws(
    () => coordinator.parseProgress(`${JSON.stringify(missing)}\n`),
    /missing required metadata|invalid progress schema/i,
  );

  for (const mutation of [
    { progressRaw: progressRaw.replace(token, 'e'.repeat(64)) },
    { progressRaw: progressRaw.replace(runId, '123e4567-e89b-42d3-a456-426614174098') },
    { progressRaw: progressRaw.replace(
      JSON.stringify(progressMarker), JSON.stringify({ ...progressMarker, path: '/unsafe' }),
    ) },
    { placementRaw: placementRaw.replace(mined.recordSha256, 'c'.repeat(64)) },
    { placementRaw: `${JSON.stringify(placementMarker)}\n${JSON.stringify({ event: 'claim_intent' })}\n` },
    { receipt: { ...receipt, counts: { mined: 2 }, selected: 2, processed: 2, pending: 2 } },
  ]) {
    assert.throws(
      () => coordinator.reconcileLegacyEvidence({
        progressRaw, placementRaw, receipt, runId, token, ...mutation,
      }),
      /invalid legacy evidence/i,
    );
  }
});

test('legacy child arguments are explicit, bounded, and never generic', () => {
  assert.equal(typeof coordinator.buildLegacyDrainerArgs, 'function');
  const args = coordinator.buildLegacyDrainerArgs({
    drainer: '/safe/drainer.mjs',
    ledger: '/safe/ledger.txt',
    stateRoot: '/safe/state',
    progress: '/safe/progress.jsonl',
    placementJournal: '/safe/placement.jsonl',
    dispositions: '/safe/dispositions.jsonl',
    runId: RUN_ID,
    token: 'a'.repeat(64),
    bounds: {
      maxPerRun: 10, concurrency: 2, subscriptionConcurrency: 1,
      quiescenceMinutes: 45, perProviderTimeoutMs: 5_000,
      perTranscriptDeadlineMs: 10_000, maxAttemptsPerProvider: 1,
      maxSourceBytes: 1_000_000, chunkChars: 4_000, maxChunksPerTranscript: 4,
    },
  });
  assert.deepEqual(args, [
    '/safe/drainer.mjs', '--adopt-legacy-list', '/safe/ledger.txt',
    '--legacy-state-root', '/safe/state', '--out', '/safe/progress.jsonl',
    '--placement-journal', '/safe/placement.jsonl', '--dispositions', '/safe/dispositions.jsonl',
    '--legacy-run-id', RUN_ID, '--legacy-token', 'a'.repeat(64),
    '--limit', '10', '--concurrency', '2', '--subscription-concurrency', '1',
    '--quiescence-minutes', '45', '--provider-timeout-ms', '5000',
    '--transcript-deadline-ms', '10000', '--max-attempts-per-provider', '1',
    '--max-source-bytes', '1000000', '--chunk-chars', '4000', '--max-chunks', '4',
  ]);
  assert.equal(args.some((value) => [
    '--list', '--verify-progress', '--finalize-progress', '--rollback-progress',
    '--recover-placement-journal',
  ].includes(value)), false);
  const normal = buildDrainerArgs({
    drainer: '/safe/drainer.mjs', listFile: '/safe/list', progress: '/safe/progress',
    dispositions: '/safe/dispositions', placementJournal: '/safe/placement',
    selectedCount: 1, bounds: {
      concurrency: 1, subscriptionConcurrency: 1, quiescenceMinutes: 45,
      perProviderTimeoutMs: 5_000, perTranscriptDeadlineMs: 10_000,
      maxAttemptsPerProvider: 1, maxSourceBytes: 1_000_000,
      chunkChars: 4_000, maxChunksPerTranscript: 4,
    },
  });
  assert.equal(normal.some((value) => value.includes('legacy')), false);
});

test('legacy phase receipts are strict counts-only one-line metadata', () => {
  assert.equal(typeof coordinator.parseLegacyPhaseReceipt, 'function');
  assert.deepEqual(coordinator.parseLegacyPhaseReceipt(
    `${JSON.stringify({ verified: 2, status: 'needs_commit' })}\n`, 'verify', 2,
  ), { verified: 2, status: 'needs_commit' });
  assert.deepEqual(coordinator.parseLegacyPhaseReceipt(
    `${JSON.stringify({ finalized: 2, released: 2, status: 'captured' })}\n`, 'finalize', 2,
  ), { finalized: 2, released: 2, status: 'captured' });
  assert.deepEqual(coordinator.parseLegacyPhaseReceipt(
    `${JSON.stringify({ aborted: 2, released: 2, status: 'aborted' })}\n`, 'abort', 2,
  ), { aborted: 2, released: 2, status: 'aborted' });
  for (const [raw, phase, expected] of [
    ['{}\n', 'verify', 0],
    [`${JSON.stringify({ verified: 1, status: 'reconciled' })}\n`, 'verify', 1],
    [`${JSON.stringify({ verified: 1, status: 'needs_commit', path: '/private' })}\n`, 'verify', 1],
    [`${JSON.stringify({ finalized: 1, released: 0, status: 'captured' })}\n`, 'finalize', 1],
    [`${JSON.stringify({ aborted: 1, released: 1, status: 'captured' })}\n`, 'abort', 1],
    [`${JSON.stringify({ aborted: 401, released: 401, status: 'aborted' })}\n`, 'abort', 401],
  ]) {
    assert.throws(
      () => coordinator.parseLegacyPhaseReceipt(raw, phase, expected),
      /invalid legacy phase receipt/i,
    );
  }
});

test('legacy staged proof rejects postscan mutation, binds postadd blobs, and writes the exact abort manifest', () => {
  assert.equal(typeof coordinator.materializeLegacyTransaction, 'function');
  assert.equal(typeof coordinator.quarantineLegacyRecords, 'function');
  assert.equal(typeof coordinator.verifyLegacyStagedTransaction, 'function');
  const root = mkdtempSync(join(tmpdir(), 'stack-legacy-transaction-'));
  const vault = join(root, 'vault');
  mkdirSync(vault);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['commit', '--allow-empty', '-q', '-m', 'base'],
  ]) assert.equal(spawnSync('git', args, { cwd: vault }).status, 0);
  const runDirectory = join(root, 'legacy-run-safe');
  mkdirSync(runDirectory, { mode: 0o700 });
  const sourcePath = join(root, 'source.jsonl');
  const sourceBody = Buffer.from('{"safe":true}\n');
  writeFileSync(sourcePath, sourceBody, { mode: 0o600 });
  const recordPath = join(vault, 'project-memory', 'documents', 'sessions', 'legacy.md');
  mkdirSync(join(recordPath, '..'), { recursive: true, mode: 0o700 });
  const recordBody = Buffer.from('# legacy\n');
  writeFileSync(recordPath, recordBody, { mode: 0o600 });
  const runId = RUN_ID;
  const token = 'b'.repeat(64);
  const beforeHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  const mined = [{
    transcriptId: '123e4567-e89b-42d3-a456-426614174093', sourcePath, status: 'mined',
    observedAt: '2026-08-09T22:00:00.000Z', runId,
    sourceSha256: createHash('sha256').update(sourceBody).digest('hex'),
    recordPath, recordSha256: createHash('sha256').update(recordBody).digest('hex'),
    project: 'documents', chars: sourceBody.length, chunks: 1, ...PROVIDER_PROOF,
  }];
  const transaction = coordinator.materializeLegacyTransaction({
    runDirectory, vault, mined, beforeHead, runId, token,
  });
  assert.equal(transaction.paths.length, 1);
  const messageBody = readFileSync(transaction.messageFile, 'utf8');
  chmodSync(transaction.messageFile, 0o640);
  assert.throws(
    () => coordinator.materializeLegacyTransaction({
      runDirectory, vault, mined, beforeHead, runId, token,
    }),
    /commit message|private|transaction/i,
  );
  chmodSync(transaction.messageFile, 0o600);
  writeFileSync(transaction.messageFile, 'private replacement canary\n', { mode: 0o600 });
  assert.throws(
    () => coordinator.materializeLegacyTransaction({
      runDirectory, vault, mined, beforeHead, runId, token,
    }),
    /commit message|conflicts|transaction/i,
  );
  writeFileSync(transaction.messageFile, messageBody, { mode: 0o600 });
  fs.unlinkSync(transaction.messageFile);
  symlinkSync(sourcePath, transaction.messageFile);
  assert.throws(
    () => coordinator.materializeLegacyTransaction({
      runDirectory, vault, mined, beforeHead, runId, token,
    }),
    /commit message|private|transaction/i,
  );
  fs.unlinkSync(transaction.messageFile);
  writeFileSync(transaction.messageFile, messageBody, { mode: 0o600 });
  const stagedScanner = join(root, 'staged-scanner.mjs');
  writeFileSync(stagedScanner, `
    import { writeFileSync } from 'node:fs';
    if (process.env.STACK_STAGED_MUTATION_TARGET) {
      writeFileSync(process.env.STACK_STAGED_MUTATION_TARGET, '# mutated after scan\\n', { mode: 0o600 });
    }
  `, { mode: 0o700 });
  process.env.STACK_STAGED_MUTATION_TARGET = recordPath;
  scanExactRecords({ scanner: stagedScanner, paths: [recordPath] });
  delete process.env.STACK_STAGED_MUTATION_TARGET;
  assert.equal(spawnSync('git', ['add', transaction.paths[0]], { cwd: vault }).status, 0);
  assert.throws(
    () => coordinator.verifyLegacyStagedTransaction(
      transaction.specPath, vault, stagedScanner, runId, token,
    ),
    /staged record hash mismatches frozen evidence/i,
  );
  assert.equal(spawnSync('git', ['update-index', '--force-remove', transaction.paths[0]], { cwd: vault }).status, 0);
  writeFileSync(recordPath, recordBody, { mode: 0o600 });
  assert.equal(spawnSync('git', ['add', transaction.paths[0]], { cwd: vault }).status, 0);
  process.env.STACK_STAGED_MUTATION_TARGET = recordPath;
  assert.equal(coordinator.verifyLegacyStagedTransaction(
    transaction.specPath, vault, stagedScanner, runId, token,
  ), 1);
  delete process.env.STACK_STAGED_MUTATION_TARGET;
  const stagedBlob = spawnSync('git', ['cat-file', 'blob', `:${transaction.paths[0]}`], {
    cwd: vault, encoding: 'utf8',
  });
  assert.equal(stagedBlob.status, 0);
  assert.equal(createHash('sha256').update(stagedBlob.stdout).digest('hex'), mined[0].recordSha256);
  assert.notEqual(createHash('sha256').update(readFileSync(recordPath)).digest('hex'), mined[0].recordSha256);
  assert.equal(spawnSync('git', ['update-index', '--force-remove', transaction.paths[0]], { cwd: vault }).status, 0);
  writeFileSync(recordPath, recordBody, { mode: 0o600 });
  const progress = join(runDirectory, 'progress.jsonl');
  const placement = join(runDirectory, 'placement-journal.jsonl');
  writeFileSync(progress, 'sanitized progress\n', { mode: 0o600 });
  writeFileSync(placement, 'sanitized placement\n', { mode: 0o600 });
  const manifestPath = coordinator.quarantineLegacyRecords({
    specPath: transaction.specPath,
    manifestPath: transaction.recoveryManifest,
    progressPath: progress,
    placementJournalPath: placement,
    vault,
    runId,
    token,
  });
  assert.equal(existsSync(recordPath), false);
  assert.equal(lstatSync(manifestPath).mode & 0o777, 0o600);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), [
    'entries', 'placementJournalSha256', 'progressSha256', 'runId', 'token', 'version',
  ]);
  assert.equal(manifest.entries.length, 1);
  assert.deepEqual(Object.keys(manifest.entries[0]).sort(), [
    'recordPathSha256', 'recordSha256', 'recoveryPath', 'recoverySha256', 'transcriptIdSha256',
  ]);
  assert.equal(manifest.entries[0].transcriptIdSha256,
    createHash('sha256').update(mined[0].transcriptId).digest('hex'));
  assert.equal(manifest.entries[0].recordPathSha256,
    createHash('sha256').update(recordPath).digest('hex'));
  assert.equal(manifest.entries[0].recoverySha256, mined[0].recordSha256);
  assert.equal(readFileSync(manifest.entries[0].recoveryPath, 'utf8'), recordBody.toString());
  assert.equal(readFileSync(manifestPath, 'utf8').includes(mined[0].transcriptId), false);
  assert.equal(readFileSync(manifestPath, 'utf8').includes(recordPath), false);
});

test('legacy commit recovery rejects a commit containing any extra path', () => {
  assert.equal(typeof coordinator.derivePendingCommit, 'function');
  const root = mkdtempSync(join(tmpdir(), 'stack-legacy-extra-commit-'));
  const vault = join(root, 'vault');
  mkdirSync(vault);
  for (const args of [
    ['init', '-q'], ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.invalid'], ['config', 'commit.gpgsign', 'false'],
    ['commit', '--allow-empty', '-q', '-m', 'base'],
  ]) assert.equal(spawnSync('git', args, { cwd: vault }).status, 0);
  const beforeHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  const recordPath = join(vault, 'project-memory', 'documents', 'sessions', 'legacy.md');
  mkdirSync(join(recordPath, '..'), { recursive: true });
  const body = Buffer.from('# legacy\n');
  writeFileSync(recordPath, body, { mode: 0o600 });
  writeFileSync(join(vault, 'extra.txt'), 'unrelated\n');
  assert.equal(spawnSync('git', ['add', '--', 'project-memory/documents/sessions/legacy.md', 'extra.txt'], {
    cwd: vault,
  }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-q', '-m', 'unsafe combined commit'], { cwd: vault }).status, 0);
  const row = {
    transcriptId: '123e4567-e89b-42d3-a456-426614174096',
    sourcePath: join(root, 'source.jsonl'), status: 'mined',
    observedAt: '2026-08-09T22:00:00.000Z', runId: RUN_ID,
    sourceSha256: 'a'.repeat(64), recordPath,
    recordSha256: createHash('sha256').update(body).digest('hex'), ...PROVIDER_PROOF,
  };
  assert.throws(
    () => coordinator.derivePendingCommit(vault, beforeHead, [row]),
    /expected 1 match, received 0/i,
  );
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
  assert.throws(() => validateMinedRows(rows, vault, untracked), /private regular file/i);
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

test('an unknown coordinator flag can never fall back to the default batch', () => {
  const f = fixture();
  transcript(join(f.project, 'eligible-id.jsonl'));
  const marker = join(f.root, 'unexpected-child');
  const env = wrapperEnvironment(f, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.UNEXPECTED_CHILD_MARKER, 'invoked');
  `);
  env.UNEXPECTED_CHILD_MARKER = marker;
  const result = spawnSync(process.execPath, [WRAPPER, '--bogus'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid coordinator arguments/i);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(f.root, 'logs', 'stray-drain')), false);
});

test('targeted dry run narrows exactly and performs no recovery or writes', () => {
  const f = fixture();
  const requestedId = '123e4567-e89b-42d3-a456-426614174010';
  const otherId = '123e4567-e89b-42d3-a456-426614174011';
  transcript(join(f.project, `${requestedId}.jsonl`));
  transcript(join(f.project, `${otherId}.jsonl`), 121);
  const idsFile = join(f.root, 'requested.txt');
  writeFileSync(idsFile, `${requestedId}\n`, { mode: 0o600 });
  const marker = join(f.root, 'unexpected-targeted-child');
  const env = wrapperEnvironment(f, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.UNEXPECTED_CHILD_MARKER, 'invoked');
  `);
  env.UNEXPECTED_CHILD_MARKER = marker;

  const runDirectory = join(f.root, 'logs', 'stray-drain', 'run-dead-owner');
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const sourcePath = join(f.project, `${requestedId}.jsonl`);
  writeFileSync(join(runDirectory, 'sources.txt'), `${sourcePath}\n`, { mode: 0o600 });
  writeFileSync(join(runDirectory, 'progress.jsonl'), '', { mode: 0o600 });
  writeFileSync(join(runDirectory, 'placement-journal.jsonl'), '', { mode: 0o600 });
  writeFileSync(join(runDirectory, 'transaction-owner.json'), `${JSON.stringify({
    schemaVersion: 1, createdAt: '2026-08-09T22:00:00.000Z', ownerPid: 2_147_483_647,
    vaultHead: 'a'.repeat(40), sources: [{ transcriptId: requestedId, sourcePath }],
  })}\n`, { mode: 0o600 });

  const beforeTree = snapshotTree(f.root);
  const result = spawnSync(process.execPath, [WRAPPER, '--ids-file', idsFile, '--dry-run'], {
    env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /targeted dry run census: requested 1; selected 1/i);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(runDirectory, 'transaction-resolution.json')), false);
  assert.equal(existsSync(join(runDirectory, 'incomplete-progress.json')), false);
  assert.deepEqual(snapshotTree(f.root), beforeTree);
});

test('targeted membership drift after startup recovery is refused before child invocation', () => {
  const f = fixture();
  const requestedId = '123e4567-e89b-42d3-a456-426614174020';
  const sourcePathInput = join(f.project, `${requestedId}.jsonl`);
  transcript(sourcePathInput);
  const sourcePath = fs.realpathSync(sourcePathInput);
  const idsFile = join(f.root, 'requested.txt');
  writeFileSync(idsFile, `${requestedId}\n`, { mode: 0o600 });
  const mainChildMarker = join(f.root, 'unexpected-main-child');
  const env = wrapperEnvironment(f, `
    import { utimesSync, writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    if (args.includes('--recover-placement-journal')) {
      const now = new Date();
      utimesSync(process.env.TARGET_SOURCE, now, now);
      process.stdout.write(JSON.stringify({ recovered: 0, released: 0, active: 0, missing: 0, unproven: 0, status: 'reconciled' }) + '\\n');
    } else {
      writeFileSync(process.env.UNEXPECTED_MAIN_CHILD, 'invoked');
    }
  `);
  env.TARGET_SOURCE = sourcePath;
  env.UNEXPECTED_MAIN_CHILD = mainChildMarker;
  const config = JSON.parse(readFileSync(env.STACK_STRAY_CONFIG, 'utf8'));
  const vaultHead = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: config.vaultRoot, encoding: 'utf8',
  }).stdout.trim();
  const runDirectory = join(f.root, 'logs', 'stray-drain', 'run-membership-drift');
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(runDirectory, 'sources.txt'), `${sourcePath}\n`, { mode: 0o600 });
  writeFileSync(join(runDirectory, 'progress.jsonl'), '', { mode: 0o600 });
  const claim = {
    event: 'claim_intent', transcriptId: requestedId, sourcePath,
    observedAt: '2026-08-09T22:00:00.000Z', runId: RUN_ID, ownerPid: 2_147_483_647,
  };
  writeFileSync(join(runDirectory, 'placement-journal.jsonl'), [
    JSON.stringify(claim),
    JSON.stringify({ ...claim, event: 'claim_acquired' }),
    '',
  ].join('\n'), { mode: 0o600 });
  writeFileSync(join(runDirectory, 'transaction-owner.json'), `${JSON.stringify({
    schemaVersion: 1, createdAt: '2026-08-09T22:00:00.000Z', ownerPid: 2_147_483_647,
    vaultHead, sources: [{ transcriptId: requestedId, sourcePath }],
  })}\n`, { mode: 0o600 });
  const lib = join(f.root, 'wrap-lib.sh');
  writeFileSync(lib, `
    wrap_lock() { d="${f.root}/membership-drift.lock"; mkdir "$d" || return 1; printf '%s' "$d|$$|token"; }
    wrap_unlock() { d="\${1%%|*}"; rmdir "$d"; }
  `, { mode: 0o600 });
  env.WRAP_LIB = lib;

  const result = spawnSync(process.execPath, [WRAPPER, '--ids-file', idsFile], {
    env, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^stray-drain: targeted drain failed\n$/i);
  assert.equal(result.stderr.includes(requestedId), false);
  assert.equal(existsSync(mainChildMarker), false);
  assert.equal(
    readdirSync(join(f.root, 'logs', 'stray-drain')).filter((name) => name.startsWith('run-')).length,
    1,
  );
});

test('targeted mode rejects claimed, self-owned, recent, and excluded-root identifiers before child invocation', async (t) => {
  for (const category of ['claimed', 'self-owned', 'recent', 'excluded-root']) {
    await t.test(category, () => {
      const f = fixture();
      const requestedId = {
        claimed: '123e4567-e89b-42d3-a456-426614174030',
        'self-owned': '123e4567-e89b-42d3-a456-426614174031',
        recent: '123e4567-e89b-42d3-a456-426614174032',
        'excluded-root': '123e4567-e89b-42d3-a456-426614174033',
      }[category];
      if (category === 'excluded-root') {
        const excluded = join(f.projects, '-Users-example-excluded');
        mkdirSync(excluded, { recursive: true });
        transcript(join(excluded, `${requestedId}.jsonl`));
      } else {
        transcript(join(f.project, `${requestedId}.jsonl`), category === 'recent' ? 5 : 120);
      }
      if (category === 'claimed') writeFileSync(f.ledger, `${requestedId}\n`, { mode: 0o600 });
      const idsFile = join(f.root, 'requested.txt');
      writeFileSync(idsFile, `${requestedId}\n`, { mode: 0o600 });
      const marker = join(f.root, 'unexpected-ineligible-child');
      const env = wrapperEnvironment(f, `
        import { writeFileSync } from 'node:fs';
        writeFileSync(process.env.UNEXPECTED_CHILD_MARKER, 'invoked');
      `);
      env.UNEXPECTED_CHILD_MARKER = marker;
      if (category === 'self-owned') env.WRAP_SELF_SESSION_ID = requestedId;
      const result = spawnSync(process.execPath, [WRAPPER, '--ids-file', idsFile], {
        env, encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^stray-drain: targeted drain failed\n$/i);
      assert.equal(result.stderr.includes(requestedId), false);
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(join(f.root, 'logs', 'stray-drain')), false);
    });
  }
});

test('legacy no-record reconciliation uses exact private binding without Git mutation or ledger pre-read', () => {
  const f = fixture();
  const argsMarker = join(f.root, 'legacy-args.json');
  const ledgerPath = join(f.root, 'present-unreadable-ledger.txt');
  writeFileSync(ledgerPath, 'synthetic-ledger-evidence\n', { mode: 0o600 });
  chmodSync(ledgerPath, 0o000);
  const env = wrapperEnvironment(f, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.LEGACY_ARGS_MARKER, JSON.stringify(process.argv.slice(2)), { mode: 0o600 });
    process.stdout.write(JSON.stringify({
      selected: 0, processed: 0, pending: 0, counts: {}, status: 'reconciled',
    }) + '\\n');
  `);
  env.LEGACY_ARGS_MARKER = argsMarker;
  env.WRAP_LEDGER = ledgerPath;
  env.WRAP_LEGACY_STATE_ROOT = join(f.root, 'legacy-state');
  env.WRAP_PROJECTS_ROOT = join(f.root, 'intentionally-absent-projects');
  const vault = JSON.parse(readFileSync(env.STACK_STRAY_CONFIG, 'utf8')).vaultRoot;
  const beforeHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  const result = spawnSync(process.execPath, [WRAPPER, '--reconcile-legacy'], {
    env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(readFileSync(argsMarker, 'utf8'));
  assert.deepEqual(args.slice(0, 12), [
    '--adopt-legacy-list', ledgerPath,
    '--legacy-state-root', env.WRAP_LEGACY_STATE_ROOT,
    '--out', args[5],
    '--placement-journal', args[7],
    '--dispositions', env.WRAP_DISPOSITIONS,
    '--legacy-run-id', args[11],
  ]);
  assert.equal(args[12], '--legacy-token');
  assert.match(args[13], /^[a-f0-9]{64}$/);
  assert.equal(args.includes('--recover-placement-journal'), false);
  assert.equal(args.includes('--verify-progress'), false);
  assert.equal(lstatSync(ledgerPath).mode & 0o777, 0o000);
  const legacyRoot = join(f.root, 'logs', 'stray-drain-legacy');
  const runName = readdirSync(legacyRoot).find((name) => name.startsWith('legacy-run-'));
  const runDirectory = join(legacyRoot, runName);
  assert.equal(lstatSync(runDirectory).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(join(runDirectory, 'legacy-resolution.json'), 'utf8')), {
    version: 1, event: 'legacy_resolution', runId: args[11], token: args[13],
    status: 'reconciled', records: 0, commit: null,
  });
  assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim(), beforeHead);
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: vault, encoding: 'utf8' }).stdout, '');
});

test('legacy startup replays identical adoption arguments after a crash before receipt persistence', () => {
  const f = fixture();
  const calls = join(f.root, 'legacy-replay-calls.jsonl');
  const env = wrapperEnvironment(f, `
    import { appendFileSync } from 'node:fs';
    appendFileSync(process.env.LEGACY_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ selected: 0, processed: 0, pending: 0,
      counts: {}, status: 'reconciled' }) + '\\n');
  `);
  const config = JSON.parse(readFileSync(env.STACK_STRAY_CONFIG, 'utf8'));
  const vault = config.vaultRoot;
  const stateRoot = join(f.root, 'legacy-state');
  const legacyRoot = join(f.root, 'logs', 'stray-drain-legacy');
  const tuning = { ...config.strayDrain };
  delete tuning.globalDeadlineMs;
  const vaultHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  const crashed = coordinator.createLegacyRunArtifacts(legacyRoot, {
    stateRoot, ledgerPath: f.ledger, dispositionsPath: env.WRAP_DISPOSITIONS,
    drainerPath: env.WRAP_DRAINER, vaultPath: vault, vaultHead, tuning,
  });
  for (const path of [crashed.transactionOwner, crashed.legacyRun]) {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, `${JSON.stringify({ ...value, ownerPid: 2_147_483_647 })}\n`, { mode: 0o600 });
  }
  Object.assign(env, {
    LEGACY_CALLS: calls,
    WRAP_LEGACY_STATE_ROOT: stateRoot,
  });
  const result = spawnSync(process.execPath, [WRAPPER, '--reconcile-legacy'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const invocations = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[0], coordinator.buildLegacyDrainerArgs({
    drainer: env.WRAP_DRAINER, ledger: f.ledger, stateRoot,
    progress: crashed.progress, placementJournal: crashed.placementJournal,
    dispositions: env.WRAP_DISPOSITIONS, runId: crashed.runId, token: crashed.token,
    bounds: tuning,
  }).slice(1));
  assert.equal(invocations[1][0], '--adopt-legacy-list');
  assert.notEqual(invocations[1][invocations[1].indexOf('--legacy-run-id') + 1], crashed.runId);
  assert.equal(JSON.parse(readFileSync(
    join(crashed.runDirectory, 'legacy-resolution.json'), 'utf8',
  )).status, 'reconciled');
});

test('legacy mined reconciliation verifies under lock, commits exact paths, and finalizes explicitly', () => {
  const f = fixture();
  const legacyId = '123e4567-e89b-42d3-a456-426614174088';
  const sourcePath = join(f.project, `${legacyId}.jsonl`);
  transcript(sourcePath);
  writeFileSync(f.ledger, `${legacyId}\n`, { mode: 0o600 });
  const calls = join(f.root, 'legacy-calls.jsonl');
  const env = wrapperEnvironment(f, `
    import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import { join } from 'node:path';
    const args = process.argv.slice(2);
    const get = (flag) => args[args.indexOf(flag) + 1];
    const hash = (body) => createHash('sha256').update(body).digest('hex');
    appendFileSync(process.env.LEGACY_CALLS, JSON.stringify(args) + '\\n', { mode: 0o600 });
    if (args.includes('--adopt-legacy-list')) {
      const runId = get('--legacy-run-id');
      const token = get('--legacy-token');
      const sourcePath = process.env.LEGACY_SOURCE;
      const sourceBody = readFileSync(sourcePath);
      const recordPath = join(process.env.FAKE_VAULT, 'project-memory', 'documents', 'sessions', 'legacy-adopted.md');
      mkdirSync(join(process.env.FAKE_VAULT, 'project-memory', 'documents', 'sessions'), { recursive: true, mode: 0o700 });
      const recordBody = Buffer.from('# adopted\\n');
      writeFileSync(recordPath, recordBody, { mode: 0o600 });
      const row = {
        transcriptId: process.env.LEGACY_ID, sourcePath, status: 'mined',
        observedAt: '2026-08-09T22:00:00.000Z', runId, project: 'documents',
        chars: sourceBody.length, chunks: 1, sourceSha256: hash(sourceBody),
        recordPath, recordSha256: hash(recordBody),
        requestedSlot: 'bulk_summarize', provider: 'cheap-cli', resolvedModel: null,
        accountType: 'configured-cli', failureReason: null,
        providerAttempts: [{ engine: 'cheap', requestedSlot: 'bulk_summarize', provider: 'cheap-cli',
          resolvedModel: null, accountType: 'configured-cli', outcome: 'success', failureReason: null }],
      };
      appendFileSync(get('--out'), JSON.stringify(row) + '\\n');
      appendFileSync(get('--placement-journal'), JSON.stringify({
        legacyPlacementVersion: 1, event: 'intent', token,
        ...row, status: undefined, recordPath: undefined, desiredRecordPath: row.recordPath,
      }, (key, value) => value === undefined ? undefined : value) + '\\n');
      appendFileSync(get('--placement-journal'), JSON.stringify({
        legacyPlacementVersion: 1, event: 'placed', token, ...row,
      }) + '\\n');
      writeFileSync(get('--dispositions'), '', { flag: 'a', mode: 0o600 });
      process.stdout.write(JSON.stringify({
        selected: 1, processed: 1, pending: 1, counts: { mined: 1 }, status: 'needs_commit',
      }) + '\\n');
    } else if (args.includes('--verify-legacy-progress')) {
      if (!existsSync(process.env.FAKE_LOCK_MARKER)) process.exit(9);
      process.stdout.write(JSON.stringify({ verified: 1, status: 'needs_commit' }) + '\\n');
    } else if (args.includes('--finalize-legacy-progress')) {
      if (!existsSync(process.env.FAKE_LOCK_MARKER)) process.exit(9);
      process.stdout.write(JSON.stringify({ finalized: 1, released: 1, status: 'captured' }) + '\\n');
    } else if (args.includes('--abort-legacy-progress')) {
      process.stdout.write(JSON.stringify({ aborted: 1, released: 1, status: 'aborted' }) + '\\n');
    } else {
      process.exit(19);
    }
  `);
  const vault = JSON.parse(readFileSync(env.STACK_STRAY_CONFIG, 'utf8')).vaultRoot;
  const lib = join(f.root, 'wrap-lib.sh');
  const lockMarker = join(f.root, 'legacy-vault.lock');
  writeFileSync(lib, `
    wrap_lock() { d="$FAKE_LOCK_MARKER"; mkdir "$d" || return 1; printf '%s' "$d|$$|token"; }
    wrap_unlock() { d="\${1%%|*}"; rmdir "$d"; }
  `, { mode: 0o600 });
  const scanner = join(f.root, 'scanner.mjs');
  writeFileSync(scanner, `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    const calls = existsSync(process.env.SCANNER_CALLS)
      ? Number(readFileSync(process.env.SCANNER_CALLS, 'utf8')) : 0;
    writeFileSync(process.env.SCANNER_CALLS, String(calls + 1), { mode: 0o600 });
    if (calls >= 1) writeFileSync(process.env.SCANNER_MUTATION_TARGET, '# changed after add\\n', { mode: 0o600 });
  `, { mode: 0o700 });
  Object.assign(env, {
    LEGACY_CALLS: calls,
    LEGACY_SOURCE: sourcePath,
    LEGACY_ID: legacyId,
    FAKE_VAULT: vault,
    FAKE_LOCK_MARKER: lockMarker,
    WRAP_LIB: lib,
    WRAP_SCANNER: scanner,
    WRAP_LEGACY_STATE_ROOT: join(f.root, 'legacy-state'),
    SCANNER_CALLS: join(f.root, 'scanner-calls.txt'),
    SCANNER_MUTATION_TARGET: join(vault, 'project-memory', 'documents', 'sessions', 'legacy-adopted.md'),
  });
  const beforeHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  const result = spawnSync(process.execPath, [WRAPPER, '--reconcile-legacy'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const afterHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  assert.notEqual(afterHead, beforeHead);
  assert.equal(
    spawnSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', afterHead], {
      cwd: vault, encoding: 'utf8',
    }).stdout.trim(),
    'project-memory/documents/sessions/legacy-adopted.md',
  );
  const committedBlob = spawnSync('git', ['cat-file', 'blob', `${afterHead}:project-memory/documents/sessions/legacy-adopted.md`], {
    cwd: vault,
  });
  assert.equal(committedBlob.status, 0);
  assert.equal(createHash('sha256').update(committedBlob.stdout).digest('hex'), createHash('sha256').update('# adopted\n').digest('hex'));
  assert.equal(Number(readFileSync(env.SCANNER_CALLS, 'utf8')), 3);
  assert.notEqual(
    createHash('sha256').update(readFileSync(env.SCANNER_MUTATION_TARGET)).digest('hex'),
    createHash('sha256').update('# adopted\n').digest('hex'),
  );
  const invocations = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(invocations.map((args) => args[0]), [
    '--adopt-legacy-list', '--verify-legacy-progress', '--finalize-legacy-progress',
  ]);
  assert.equal(invocations.some((args) => args.some((value) => [
    '--recover-placement-journal', '--verify-progress', '--finalize-progress', '--rollback-progress',
  ].includes(value))), false);
  assert.equal(existsSync(lockMarker), false);
  const legacyRoot = join(f.root, 'logs', 'stray-drain-legacy');
  const runName = readdirSync(legacyRoot).find((name) => name.startsWith('legacy-run-'));
  const resolution = JSON.parse(readFileSync(join(legacyRoot, runName, 'legacy-resolution.json'), 'utf8'));
  assert.equal(resolution.status, 'captured');
  assert.equal(resolution.commit, afterHead);
  assert.equal(resolution.records, 1);
});

test('legacy commit failure quarantines exact records and invokes only explicit abort', () => {
  const f = fixture();
  const legacyId = '123e4567-e89b-42d3-a456-426614174089';
  const sourcePath = join(f.project, `${legacyId}.jsonl`);
  transcript(sourcePath);
  writeFileSync(f.ledger, `${legacyId}\n`, { mode: 0o600 });
  const calls = join(f.root, 'legacy-abort-calls.jsonl');
  const env = wrapperEnvironment(f, `
    import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import { join } from 'node:path';
    const args = process.argv.slice(2);
    const get = (flag) => args[args.indexOf(flag) + 1];
    const hash = (body) => createHash('sha256').update(body).digest('hex');
    appendFileSync(process.env.LEGACY_CALLS, JSON.stringify(args) + '\\n', { mode: 0o600 });
    if (args.includes('--adopt-legacy-list')) {
      const runId = get('--legacy-run-id'); const token = get('--legacy-token');
      const sourcePath = process.env.LEGACY_SOURCE; const sourceBody = readFileSync(sourcePath);
      const recordPath = join(process.env.FAKE_VAULT, 'project-memory', 'documents', 'sessions', 'legacy-abort.md');
      mkdirSync(join(recordPath, '..'), { recursive: true, mode: 0o700 });
      const recordBody = Buffer.from('# abort me\\n'); writeFileSync(recordPath, recordBody, { mode: 0o600 });
      const row = { transcriptId: process.env.LEGACY_ID, sourcePath, status: 'mined',
        observedAt: '2026-08-09T22:00:00.000Z', runId, project: 'documents', chars: sourceBody.length,
        chunks: 1, sourceSha256: hash(sourceBody), recordPath, recordSha256: hash(recordBody),
        requestedSlot: 'bulk_summarize', provider: 'cheap-cli', resolvedModel: null,
        accountType: 'configured-cli', failureReason: null, providerAttempts: [{ engine: 'cheap',
          requestedSlot: 'bulk_summarize', provider: 'cheap-cli', resolvedModel: null,
          accountType: 'configured-cli', outcome: 'success', failureReason: null }] };
      appendFileSync(get('--out'), JSON.stringify(row) + '\\n');
      const { status, recordPath: placedPath, ...proof } = row;
      appendFileSync(get('--placement-journal'), JSON.stringify({ legacyPlacementVersion: 1,
        event: 'intent', token, ...proof, desiredRecordPath: placedPath }) + '\\n');
      appendFileSync(get('--placement-journal'), JSON.stringify({ legacyPlacementVersion: 1,
        event: 'placed', token, ...row }) + '\\n');
      writeFileSync(get('--dispositions'), '', { flag: 'a', mode: 0o600 });
      process.stdout.write(JSON.stringify({ selected: 1, processed: 1, pending: 1,
        counts: { mined: 1 }, status: 'needs_commit' }) + '\\n');
    } else if (args.includes('--verify-legacy-progress')) {
      if (!existsSync(process.env.FAKE_LOCK_MARKER)) process.exit(9);
      process.stdout.write(JSON.stringify({ verified: 1, status: 'needs_commit' }) + '\\n');
    } else if (args.includes('--abort-legacy-progress')) {
      if (!existsSync(process.env.FAKE_LOCK_MARKER)) process.exit(9);
      const manifest = JSON.parse(readFileSync(get('--recovery-manifest'), 'utf8'));
      if (manifest.entries.length !== 1 || !existsSync(manifest.entries[0].recoveryPath)) process.exit(8);
      process.stdout.write(JSON.stringify({ aborted: 1, released: 1, status: 'aborted' }) + '\\n');
    } else process.exit(19);
  `);
  const vault = JSON.parse(readFileSync(env.STACK_STRAY_CONFIG, 'utf8')).vaultRoot;
  const lib = join(f.root, 'wrap-lib.sh');
  const lockMarker = join(f.root, 'legacy-vault.lock');
  writeFileSync(lib, `
    wrap_lock() { d="$FAKE_LOCK_MARKER"; mkdir "$d" || return 1; printf '%s' "$d|$$|token"; }
    wrap_unlock() { d="\${1%%|*}"; rmdir "$d"; }
  `, { mode: 0o600 });
  const scanner = join(f.root, 'scanner.mjs');
  writeFileSync(scanner, 'process.exit(0);\n', { mode: 0o700 });
  const hook = join(vault, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  Object.assign(env, {
    LEGACY_CALLS: calls, LEGACY_SOURCE: sourcePath, LEGACY_ID: legacyId,
    FAKE_VAULT: vault, FAKE_LOCK_MARKER: lockMarker, WRAP_LIB: lib, WRAP_SCANNER: scanner,
    WRAP_LEGACY_STATE_ROOT: join(f.root, 'legacy-state'),
  });
  const beforeHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  const result = spawnSync(process.execPath, [WRAPPER, '--reconcile-legacy'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^stray-drain: legacy reconciliation failed\n$/);
  assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim(), beforeHead);
  assert.equal(existsSync(join(vault, 'project-memory', 'documents', 'sessions', 'legacy-abort.md')), false);
  const invocations = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(invocations.map((args) => args[0]), [
    '--adopt-legacy-list', '--verify-legacy-progress', '--abort-legacy-progress',
  ]);
  const legacyRoot = join(f.root, 'logs', 'stray-drain-legacy');
  const runName = readdirSync(legacyRoot).find((name) => name.startsWith('legacy-run-'));
  const runDirectory = join(legacyRoot, runName);
  const manifest = JSON.parse(readFileSync(join(runDirectory, 'legacy-abort-manifest.json'), 'utf8'));
  assert.equal(manifest.entries.length, 1);
  assert.equal(existsSync(manifest.entries[0].recoveryPath), true);
  assert.equal(JSON.parse(readFileSync(join(runDirectory, 'legacy-resolution.json'), 'utf8')).status, 'aborted');
  assert.equal(readFileSync(f.ledger, 'utf8'), `${legacyId}\n`);
  assert.equal(existsSync(lockMarker), false);
});

test('legacy unrelated head advance aborts exact untracked records instead of stranding recovery', () => {
  const f = fixture();
  const legacyId = '123e4567-e89b-42d3-a456-426614174091';
  const sourcePath = join(f.project, `${legacyId}.jsonl`);
  transcript(sourcePath);
  writeFileSync(f.ledger, `${legacyId}\n`, { mode: 0o600 });
  const calls = join(f.root, 'legacy-head-advance-calls.jsonl');
  const env = wrapperEnvironment(f, `
    import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { createHash } from 'node:crypto';
    import { join } from 'node:path';
    const args = process.argv.slice(2);
    const get = (flag) => args[args.indexOf(flag) + 1];
    const hash = (body) => createHash('sha256').update(body).digest('hex');
    appendFileSync(process.env.LEGACY_CALLS, JSON.stringify(args) + '\\n', { mode: 0o600 });
    if (args.includes('--adopt-legacy-list')) {
      const runId = get('--legacy-run-id'); const token = get('--legacy-token');
      const sourcePath = process.env.LEGACY_SOURCE; const sourceBody = readFileSync(sourcePath);
      const recordPath = join(process.env.FAKE_VAULT, 'project-memory', 'documents', 'sessions', 'legacy-head-advance.md');
      mkdirSync(join(recordPath, '..'), { recursive: true, mode: 0o700 });
      const recordBody = Buffer.from('# exact record\\n'); writeFileSync(recordPath, recordBody, { mode: 0o600 });
      const row = { transcriptId: process.env.LEGACY_ID, sourcePath, status: 'mined',
        observedAt: '2026-08-09T22:00:00.000Z', runId, project: 'documents', chars: sourceBody.length,
        chunks: 1, sourceSha256: hash(sourceBody), recordPath, recordSha256: hash(recordBody),
        requestedSlot: 'bulk_summarize', provider: 'cheap-cli', resolvedModel: null,
        accountType: 'configured-cli', failureReason: null, providerAttempts: [{ engine: 'cheap',
          requestedSlot: 'bulk_summarize', provider: 'cheap-cli', resolvedModel: null,
          accountType: 'configured-cli', outcome: 'success', failureReason: null }] };
      appendFileSync(get('--out'), JSON.stringify(row) + '\\n');
      const { status, recordPath: placedPath, ...proof } = row;
      appendFileSync(get('--placement-journal'), JSON.stringify({ legacyPlacementVersion: 1,
        event: 'intent', token, ...proof, desiredRecordPath: placedPath }) + '\\n');
      appendFileSync(get('--placement-journal'), JSON.stringify({ legacyPlacementVersion: 1,
        event: 'placed', token, ...row }) + '\\n');
      writeFileSync(get('--dispositions'), '', { flag: 'a', mode: 0o600 });
      writeFileSync(join(process.env.FAKE_VAULT, 'unrelated.txt'), 'unrelated head advance\\n');
      if (spawnSync('git', ['add', 'unrelated.txt'], { cwd: process.env.FAKE_VAULT }).status !== 0
          || spawnSync('git', ['commit', '-q', '-m', 'unrelated head advance'], { cwd: process.env.FAKE_VAULT }).status !== 0) process.exit(18);
      process.stdout.write(JSON.stringify({ selected: 1, processed: 1, pending: 1,
        counts: { mined: 1 }, status: 'needs_commit' }) + '\\n');
    } else if (args.includes('--abort-legacy-progress')) {
      if (!existsSync(process.env.FAKE_LOCK_MARKER)) process.exit(9);
      const manifest = JSON.parse(readFileSync(get('--recovery-manifest'), 'utf8'));
      if (manifest.entries.length !== 1 || !existsSync(manifest.entries[0].recoveryPath)) process.exit(8);
      process.stdout.write(JSON.stringify({ aborted: 1, released: 1, status: 'aborted' }) + '\\n');
    } else process.exit(19);
  `);
  const vault = JSON.parse(readFileSync(env.STACK_STRAY_CONFIG, 'utf8')).vaultRoot;
  const lib = join(f.root, 'wrap-lib.sh');
  const lockMarker = join(f.root, 'legacy-head-advance.lock');
  writeFileSync(lib, `
    wrap_lock() { d="$FAKE_LOCK_MARKER"; mkdir "$d" || return 1; printf '%s' "$d|$$|token"; }
    wrap_unlock() { d="\${1%%|*}"; rmdir "$d"; }
  `, { mode: 0o600 });
  const scanner = join(f.root, 'scanner.mjs');
  writeFileSync(scanner, 'process.exit(0);\n', { mode: 0o700 });
  Object.assign(env, {
    LEGACY_CALLS: calls, LEGACY_SOURCE: sourcePath, LEGACY_ID: legacyId,
    FAKE_VAULT: vault, FAKE_LOCK_MARKER: lockMarker, WRAP_LIB: lib, WRAP_SCANNER: scanner,
    WRAP_LEGACY_STATE_ROOT: join(f.root, 'legacy-state'),
  });
  const beforeHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  const result = spawnSync(process.execPath, [WRAPPER, '--reconcile-legacy'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^stray-drain: legacy reconciliation failed\n$/);
  const afterHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  assert.notEqual(afterHead, beforeHead);
  assert.equal(existsSync(join(vault, 'project-memory', 'documents', 'sessions', 'legacy-head-advance.md')), false);
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).map((args) => args[0]), [
    '--adopt-legacy-list', '--abort-legacy-progress',
  ]);
  const legacyRoot = join(f.root, 'logs', 'stray-drain-legacy');
  const runName = readdirSync(legacyRoot).find((name) => name.startsWith('legacy-run-'));
  assert.equal(JSON.parse(readFileSync(join(legacyRoot, runName, 'legacy-resolution.json'), 'utf8')).status, 'aborted');
  assert.equal(readFileSync(f.ledger, 'utf8'), `${legacyId}\n`);
  assert.equal(existsSync(lockMarker), false);
});

test('legacy startup derives one exact commit after a crash before commit receipt and finalizes once', () => {
  const f = fixture();
  const legacyId = '123e4567-e89b-42d3-a456-426614174090';
  const sourcePath = join(f.project, `${legacyId}.jsonl`);
  transcript(sourcePath);
  writeFileSync(f.ledger, `${legacyId}\n`, { mode: 0o600 });
  const calls = join(f.root, 'legacy-recovery-calls.jsonl');
  const env = wrapperEnvironment(f, `
    import { appendFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    const get = (flag) => args[args.indexOf(flag) + 1];
    appendFileSync(process.env.LEGACY_CALLS, JSON.stringify(args) + '\\n', { mode: 0o600 });
    if (args.includes('--finalize-legacy-progress')) {
      process.stdout.write(JSON.stringify({ finalized: 1, released: 1, status: 'captured' }) + '\\n');
    } else if (args.includes('--adopt-legacy-list')) {
      process.stdout.write(JSON.stringify({ selected: 0, processed: 0, pending: 0,
        counts: {}, status: 'reconciled' }) + '\\n');
    } else process.exit(19);
  `);
  const config = JSON.parse(readFileSync(env.STACK_STRAY_CONFIG, 'utf8'));
  const vault = config.vaultRoot;
  const legacyRoot = join(f.root, 'logs', 'stray-drain-legacy');
  const stateRoot = join(f.root, 'legacy-state');
  const tuning = { ...config.strayDrain };
  delete tuning.globalDeadlineMs;
  const beforeHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  const artifacts = coordinator.createLegacyRunArtifacts(legacyRoot, {
    stateRoot, ledgerPath: f.ledger, dispositionsPath: env.WRAP_DISPOSITIONS,
    drainerPath: env.WRAP_DRAINER, vaultPath: vault, vaultHead: beforeHead, tuning,
  });
  const owner = JSON.parse(readFileSync(artifacts.transactionOwner, 'utf8'));
  writeFileSync(artifacts.transactionOwner, `${JSON.stringify({ ...owner, ownerPid: 2_147_483_647 })}\n`, { mode: 0o600 });
  const marker = JSON.parse(readFileSync(artifacts.legacyRun, 'utf8'));
  writeFileSync(artifacts.legacyRun, `${JSON.stringify({ ...marker, ownerPid: 2_147_483_647 })}\n`, { mode: 0o600 });
  const sourceBody = readFileSync(sourcePath);
  const recordPath = join(vault, 'project-memory', 'documents', 'sessions', 'legacy-recovered.md');
  mkdirSync(join(recordPath, '..'), { recursive: true, mode: 0o700 });
  const recordBody = Buffer.from('# recovered\n');
  writeFileSync(recordPath, recordBody, { mode: 0o600 });
  const row = {
    transcriptId: legacyId, sourcePath, status: 'mined', observedAt: '2026-08-09T22:00:00.000Z',
    runId: artifacts.runId, project: 'documents', chars: sourceBody.length, chunks: 1,
    sourceSha256: createHash('sha256').update(sourceBody).digest('hex'), recordPath,
    recordSha256: createHash('sha256').update(recordBody).digest('hex'), ...PROVIDER_PROOF,
  };
  appendFileSync(artifacts.progress, `${JSON.stringify(row)}\n`);
  const { status, recordPath: placedPath, ...proof } = row;
  appendFileSync(artifacts.placementJournal, [
    JSON.stringify({ legacyPlacementVersion: 1, event: 'intent', token: artifacts.token,
      ...proof, desiredRecordPath: placedPath }),
    JSON.stringify({ legacyPlacementVersion: 1, event: 'placed', token: artifacts.token, ...row }),
    '',
  ].join('\n'));
  writeFileSync(join(artifacts.runDirectory, 'legacy-adoption-receipt.json'), `${JSON.stringify({
    selected: 1, processed: 1, pending: 1, counts: { mined: 1 }, status: 'needs_commit',
  })}\n`, { mode: 0o600 });
  const transaction = coordinator.materializeLegacyTransaction({
    runDirectory: artifacts.runDirectory, vault, mined: [row], beforeHead,
    runId: artifacts.runId, token: artifacts.token,
  });
  writeFileSync(transaction.verifyReceipt, `${JSON.stringify({ verified: 1, status: 'needs_commit' })}\n`, { mode: 0o600 });
  assert.equal(spawnSync('git', ['add', '--', transaction.paths[0]], { cwd: vault }).status, 0);
  assert.equal(spawnSync('git', ['commit', '--only', '-m', 'legacy crash boundary', '--', transaction.paths[0]], {
    cwd: vault,
  }).status, 0);
  const committed = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: vault, encoding: 'utf8' }).stdout.trim();
  assert.equal(existsSync(transaction.commitOid), false);

  const lib = join(f.root, 'wrap-lib.sh');
  const lockMarker = join(f.root, 'legacy-vault.lock');
  writeFileSync(lib, `
    wrap_lock() { d="$FAKE_LOCK_MARKER"; mkdir "$d" || return 1; printf '%s' "$d|$$|token"; }
    wrap_unlock() { d="\${1%%|*}"; rmdir "$d"; }
  `, { mode: 0o600 });
  const scanner = join(f.root, 'scanner.mjs');
  writeFileSync(scanner, 'process.exit(0);\n', { mode: 0o700 });
  Object.assign(env, {
    LEGACY_CALLS: calls, FAKE_LOCK_MARKER: lockMarker, WRAP_LIB: lib,
    WRAP_SCANNER: scanner, WRAP_LEGACY_STATE_ROOT: stateRoot,
  });
  const result = spawnSync(process.execPath, [WRAPPER, '--reconcile-legacy'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(transaction.commitOid, 'utf8'), `${committed}\n`);
  const invocations = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(invocations.map((args) => args[0]), [
    '--finalize-legacy-progress', '--adopt-legacy-list',
  ]);
  const resolution = JSON.parse(readFileSync(join(artifacts.runDirectory, 'legacy-resolution.json'), 'utf8'));
  assert.equal(resolution.status, 'captured');
  assert.equal(resolution.commit, committed);
  fs.renameSync(
    join(artifacts.runDirectory, 'legacy-resolution.json'),
    join(artifacts.runDirectory, 'synthetic-crash-after-finalize-receipt.json'),
  );
  const replay = spawnSync(process.execPath, [WRAPPER, '--reconcile-legacy'], { env, encoding: 'utf8' });
  assert.equal(replay.status, 0, replay.stderr);
  const replayedInvocations = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(replayedInvocations.map((args) => args[0]), [
    '--finalize-legacy-progress', '--adopt-legacy-list', '--adopt-legacy-list',
  ]);
  assert.equal(replayedInvocations.filter((args) => args[0] === '--finalize-legacy-progress').length, 1);
  assert.equal(JSON.parse(
    readFileSync(join(artifacts.runDirectory, 'legacy-resolution.json'), 'utf8'),
  ).status, 'captured');
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
