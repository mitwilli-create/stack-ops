#!/usr/bin/env node
/**
 * Scheduled, bounded transcript drain coordinator.
 *
 * Discovery reads metadata only. The Claude-config drainer owns claim-before-read,
 * credential scanning, provider routing, and append-only placement. This wrapper
 * validates one metadata-only receipt per selected transcript and commits only the
 * exact records returned by this run under the shared vault lock.
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { discoverCandidates } from './stray-discovery.mjs';

const HOME = homedir();
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = join(HERE, 'config.json');
const FORBIDDEN_RECEIPT_KEYS = new Set(['prompt', 'text', 'body', 'content', 'stdout', 'stderr']);
const TERMINAL_NO_RECORD = new Set([
  'proven_duplicate',
  'skipped_empty',
  'skipped_thin',
  'unsupported_source',
]);
const RETRYABLE = new Set([
  'live_owned',
  'parse_incomplete',
  'privacy_refused',
  'provider_failed',
  'unroutable',
  'claim_error',
  'orphan_claim',
]);
const PROGRESS_STATUSES = new Set(['mined', ...TERMINAL_NO_RECORD, ...RETRYABLE]);
const LEGACY_PROGRESS_STATUSES = new Set([...PROGRESS_STATUSES, 'legacy_source_missing']);
const BASE_PROGRESS_KEYS = ['observedAt', 'runId', 'sourcePath', 'status', 'transcriptId'];
const OPTIONAL_PROGRESS_KEYS = new Set([
  'accountType',
  'chars',
  'chunks',
  'detailCode',
  'durationMs',
  'failureReason',
  'project',
  'provider',
  'providerAttempts',
  'recordPath',
  'recordSha256',
  'requestedSlot',
  'resolvedModel',
  'sourceSha256',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUESTED_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

function hasControlCharacter(value) {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`invalid strayDrain.${name}: expected integer ${min}..${max}`);
  }
  return value;
}

const INVALID_COORDINATOR_ARGUMENTS = 'invalid coordinator arguments';

export function parseCoordinatorArgs(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string'
      || hasControlCharacter(value))) {
    throw new Error(INVALID_COORDINATOR_ARGUMENTS);
  }
  let dryRun = false;
  let limit = null;
  let idsFile = null;
  let legacy = false;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--') || flag.includes('=') || seen.has(flag)) {
      throw new Error(INVALID_COORDINATOR_ARGUMENTS);
    }
    seen.add(flag);
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (flag === '--reconcile-legacy') {
      legacy = true;
      continue;
    }
    if (flag !== '--limit' && flag !== '--ids-file') {
      throw new Error(INVALID_COORDINATOR_ARGUMENTS);
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')
        || hasControlCharacter(value)) {
      throw new Error(INVALID_COORDINATOR_ARGUMENTS);
    }
    index += 1;
    if (flag === '--limit') {
      if (!/^[1-9][0-9]*$/.test(value)) throw new Error(INVALID_COORDINATOR_ARGUMENTS);
      limit = Number(value);
      if (!Number.isSafeInteger(limit)) throw new Error(INVALID_COORDINATOR_ARGUMENTS);
    } else {
      idsFile = value;
    }
  }
  if ((idsFile !== null && limit !== null)
      || (legacy && (argv.length !== 1 || dryRun || limit !== null || idsFile !== null))) {
    throw new Error(INVALID_COORDINATOR_ARGUMENTS);
  }
  return {
    mode: legacy ? 'legacy' : idsFile !== null ? 'targeted' : 'default',
    dryRun,
    limit,
    idsFile,
  };
}

export function parseLegacyAdoptionReceipt(raw) {
  const invalid = () => new Error('invalid legacy adoption receipt');
  if (typeof raw !== 'string' || !raw.endsWith('\n')) throw invalid();
  const body = raw.slice(0, -1);
  if (!body || /[\r\n]/.test(body)) throw invalid();
  let receipt;
  try { receipt = JSON.parse(body); } catch { throw invalid(); }
  const keys = ['counts', 'pending', 'processed', 'selected', 'status'];
  if (!receipt || Array.isArray(receipt) || typeof receipt !== 'object'
      || !exactObjectKeys(receipt, keys)
      || !receipt.counts || Array.isArray(receipt.counts) || typeof receipt.counts !== 'object') {
    throw invalid();
  }
  for (const key of ['selected', 'processed', 'pending']) {
    if (!Number.isSafeInteger(receipt[key]) || receipt[key] < 0 || receipt[key] > 400) throw invalid();
  }
  let total = 0;
  for (const [status, count] of Object.entries(receipt.counts)) {
    if (!LEGACY_PROGRESS_STATUSES.has(status)
        || !Number.isSafeInteger(count) || count < 1 || count > 400) throw invalid();
    total += count;
  }
  const mined = receipt.counts.mined ?? 0;
  if (receipt.selected !== receipt.processed || receipt.selected !== total
      || receipt.pending !== mined
      || receipt.status !== (mined > 0 ? 'needs_commit' : 'reconciled')) {
    throw invalid();
  }
  return receipt;
}

export function parseLegacyPhaseReceipt(raw, phase, expected) {
  const invalid = () => new Error('invalid legacy phase receipt');
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > 400
      || typeof raw !== 'string' || !raw.endsWith('\n')) throw invalid();
  const body = raw.slice(0, -1);
  if (!body || /[\r\n]/.test(body)) throw invalid();
  let receipt;
  try { receipt = JSON.parse(body); } catch { throw invalid(); }
  if (hasForbiddenKey(receipt)) throw invalid();
  const contracts = {
    verify: { keys: ['status', 'verified'], count: 'verified', success: 'needs_commit' },
    finalize: { keys: ['finalized', 'released', 'status'], count: 'finalized', success: 'captured' },
    abort: { keys: ['aborted', 'released', 'status'], count: 'aborted', success: 'aborted' },
  };
  const contract = contracts[phase];
  if (!contract || !exactObjectKeys(receipt, contract.keys)
      || !Number.isSafeInteger(receipt[contract.count])
      || receipt[contract.count] !== expected || receipt[contract.count] < 0
      || receipt[contract.count] > 400
      || receipt.status !== (expected > 0 ? contract.success : 'reconciled')) throw invalid();
  if ((phase === 'finalize' || phase === 'abort') && receipt.released !== expected) throw invalid();
  return receipt;
}

const DEFAULT_REQUESTED_FILE_OPS = {
  lstatSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
};

function privateMode(stat) {
  return typeof stat.mode === 'bigint'
    ? (stat.mode & 0o7777n) === 0o600n
    : (stat.mode & 0o7777) === 0o600;
}

function stableFileStat(left, right) {
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every((key) => (
    left[key] === right[key]
  ));
}

export function readRequestedIds(path, {
  maxBytes = 16 * 1024,
  maxIds = 400,
  fileOps = DEFAULT_REQUESTED_FILE_OPS,
} = {}) {
  const invalid = () => new Error('invalid requested identifiers file');
  if (typeof path !== 'string' || !path || hasControlCharacter(path)
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024
      || !Number.isSafeInteger(maxIds) || maxIds < 1 || maxIds > 400
      || typeof constants.O_NOFOLLOW !== 'number') {
    throw invalid();
  }
  let fd = null;
  let result = null;
  let failed = false;
  try {
    const before = fileOps.lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || !privateMode(before)
        || before.size < 1n || before.size > BigInt(maxBytes)) throw invalid();
    fd = fileOps.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fileOps.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !privateMode(opened) || !stableFileStat(before, opened)) throw invalid();
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fileOps.readSync(fd, buffer, length, buffer.length - length, null);
      if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length - length) throw invalid();
      if (count === 0) break;
      length += count;
    }
    const body = buffer.subarray(0, length);
    if (body.length > maxBytes || body.length !== Number(opened.size)) throw invalid();
    const afterRead = fileOps.fstatSync(fd, { bigint: true });
    const afterPath = fileOps.lstatSync(path, { bigint: true });
    if (!afterRead.isFile() || !afterPath.isFile() || afterPath.isSymbolicLink()
        || !privateMode(afterRead) || !privateMode(afterPath)
        || !stableFileStat(opened, afterRead) || !stableFileStat(opened, afterPath)) throw invalid();
    let raw;
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(body); }
    catch { throw invalid(); }
    if (!raw.endsWith('\n')) throw invalid();
    const ids = raw.slice(0, -1).split('\n');
    if (!ids.length || ids.length > maxIds || ids.some((id) => !REQUESTED_ID_PATTERN.test(id))
        || new Set(ids).size !== ids.length) throw invalid();
    result = ids;
  } catch {
    failed = true;
  } finally {
    if (fd !== null) {
      try { fileOps.closeSync(fd); } catch { failed = true; }
    }
  }
  if (failed || result === null) throw invalid();
  return result;
}

export function selectRequestedCandidates(requestedIds, candidates) {
  if (!Array.isArray(requestedIds) || !requestedIds.length
      || requestedIds.some((id) => typeof id !== 'string' || !REQUESTED_ID_PATTERN.test(id))
      || new Set(requestedIds).size !== requestedIds.length
      || !Array.isArray(candidates)) {
    throw new Error('requested candidate is not currently eligible');
  }
  const byId = new Map();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || typeof candidate.id !== 'string') continue;
    const rows = byId.get(candidate.id) ?? [];
    rows.push(candidate);
    byId.set(candidate.id, rows);
  }
  const selected = [];
  for (const id of requestedIds) {
    const matches = byId.get(id) ?? [];
    if (!matches.length) throw new Error('requested candidate is not currently eligible');
    if (matches.length !== 1) throw new Error('requested candidate membership is ambiguous');
    const [candidate] = matches;
    if (typeof candidate.path !== 'string' || !isAbsolute(candidate.path)
        || resolve(candidate.path) !== candidate.path || hasControlCharacter(candidate.path)
        || basename(candidate.path) !== `${id}.jsonl`
        || !Number.isFinite(candidate.mtimeMs) || !Number.isSafeInteger(candidate.size)
        || candidate.size < 0) {
      throw new Error('requested candidate metadata is unsafe');
    }
    let stat;
    let real;
    try {
      stat = lstatSync(candidate.path);
      real = realpathSync(candidate.path);
    } catch {
      throw new Error('requested candidate metadata is unsafe');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || real !== candidate.path
        || (stat.mode & 0o077) !== 0 || stat.mtimeMs !== candidate.mtimeMs
        || stat.size !== candidate.size) {
      throw new Error('requested candidate metadata is unsafe');
    }
    selected.push({
      ...candidate,
      selectionStat: {
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      },
    });
  }
  return selected;
}

function assertRequestedSelectionStable(before, after) {
  if (before.length !== after.length || before.some((row, index) => {
    const current = after[index];
    return row.id !== current.id || row.path !== current.path
      || !isDeepStrictEqual(row.selectionStat, current.selectionStat);
  })) {
    throw new Error('requested selection changed during startup recovery');
  }
}

export function validateStrayDrainConfig(input) {
  const c = { ...input };
  c.maxPerRun = integer(c.maxPerRun, 'maxPerRun', 1, 400);
  c.concurrency = integer(c.concurrency, 'concurrency', 1, 64);
  c.subscriptionConcurrency = integer(c.subscriptionConcurrency ?? 4, 'subscriptionConcurrency', 1, 4);
  c.quiescenceMinutes = integer(c.quiescenceMinutes, 'quiescenceMinutes', 45, 10_080);
  c.perProviderTimeoutMs = integer(c.perProviderTimeoutMs ?? 240_000, 'perProviderTimeoutMs', 1_000, 240_000);
  c.perTranscriptDeadlineMs = integer(c.perTranscriptDeadlineMs ?? 900_000, 'perTranscriptDeadlineMs', 1_000, 900_000);
  c.globalDeadlineMs = integer(c.globalDeadlineMs ?? 3_300_000, 'globalDeadlineMs', 10_000, 7_200_000);
  c.maxAttemptsPerProvider = integer(c.maxAttemptsPerProvider ?? 1, 'maxAttemptsPerProvider', 1, 1);
  c.maxSourceBytes = integer(c.maxSourceBytes ?? 16_000_000, 'maxSourceBytes', 1_024, 16_000_000);
  c.chunkChars = integer(c.chunkChars ?? 48_000, 'chunkChars', 2_000, 100_000);
  c.maxChunksPerTranscript = integer(c.maxChunksPerTranscript ?? 48, 'maxChunksPerTranscript', 1, 48);
  return c;
}

export function buildDrainerArgs({
  drainer,
  listFile,
  progress,
  dispositions,
  placementJournal,
  selectedCount,
  bounds,
  dryRun = false,
}) {
  const args = [
    drainer,
    '--list', listFile,
    '--limit', String(selectedCount),
    '--concurrency', String(bounds.concurrency),
    '--subscription-concurrency', String(bounds.subscriptionConcurrency),
    '--out', progress,
    '--dispositions', dispositions,
    '--placement-journal', placementJournal,
    '--quiescence-minutes', String(bounds.quiescenceMinutes),
    '--provider-timeout-ms', String(bounds.perProviderTimeoutMs),
    '--transcript-deadline-ms', String(bounds.perTranscriptDeadlineMs),
    '--max-attempts-per-provider', String(bounds.maxAttemptsPerProvider),
    '--max-source-bytes', String(bounds.maxSourceBytes),
    '--chunk-chars', String(bounds.chunkChars),
    '--max-chunks', String(bounds.maxChunksPerTranscript),
  ];
  if (dryRun) args.push('--dry-run');
  return args;
}

export function buildLegacyDrainerArgs({
  drainer,
  ledger,
  stateRoot,
  progress,
  placementJournal,
  dispositions,
  runId,
  token,
  bounds,
}) {
  return [
    drainer,
    '--adopt-legacy-list', ledger,
    '--legacy-state-root', stateRoot,
    '--out', progress,
    '--placement-journal', placementJournal,
    '--dispositions', dispositions,
    '--legacy-run-id', runId,
    '--legacy-token', token,
    '--limit', String(bounds.maxPerRun),
    '--concurrency', String(bounds.concurrency),
    '--subscription-concurrency', String(bounds.subscriptionConcurrency),
    '--quiescence-minutes', String(bounds.quiescenceMinutes),
    '--provider-timeout-ms', String(bounds.perProviderTimeoutMs),
    '--transcript-deadline-ms', String(bounds.perTranscriptDeadlineMs),
    '--max-attempts-per-provider', String(bounds.maxAttemptsPerProvider),
    '--max-source-bytes', String(bounds.maxSourceBytes),
    '--chunk-chars', String(bounds.chunkChars),
    '--max-chunks', String(bounds.maxChunksPerTranscript),
  ];
}

function writeNewPrivateDurable(path, body) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (body) writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

function fsyncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function sameStableFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readPrivateStable(path, label, maxBytes = 16 * 1024 * 1024) {
  let before;
  try { before = lstatSync(path); }
  catch { throw new Error(`${label} is unavailable`); }
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o7777) !== 0o600
      || before.nlink !== 1
      || before.size > maxBytes) {
    throw new Error(`${label} is not an exact private regular file`);
  }
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { throw new Error(`${label} could not be opened safely`); }
  const chunks = [];
  let total = 0;
  let during;
  let afterFd;
  try {
    during = fstatSync(fd);
    if (!sameStableFile(before, during)) throw new Error(`${label} changed before read`);
    while (total <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
    }
    if (total > maxBytes) throw new Error(`${label} exceeds its size bound`);
    afterFd = fstatSync(fd);
  } finally {
    closeSync(fd);
  }
  const after = lstatSync(path);
  if (!sameStableFile(before, afterFd) || !sameStableFile(before, after)) {
    throw new Error(`${label} changed during read`);
  }
  return Buffer.concat(chunks);
}

function readPrivateStableText(path, label, maxBytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(readPrivateStable(path, label, maxBytes));
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`${label} is not valid UTF-8`);
    throw error;
  }
}

const hashPrivateStable = (path, label, maxBytes) => createHash('sha256')
  .update(readPrivateStable(path, label, maxBytes)).digest('hex');

function ensurePrivateDirectory(path, label) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o700) {
    throw new Error(`${label} directory is not private`);
  }
  return path;
}

function ensureOrCreatePrivateDirectory(path, label) {
  if (existsSync(path)) return ensurePrivateDirectory(path, label);
  try { mkdirSync(path, { recursive: true, mode: 0o700 }); }
  catch {
    if (!existsSync(path)) throw new Error(`${label} directory could not be created`);
  }
  ensurePrivateDirectory(path, label);
  return path;
}

export function createRunArtifacts(logDir, selected, ownership = {}) {
  if (selected.some((row) => typeof row.path !== 'string' || !isAbsolute(row.path) || /[\r\n\0]/.test(row.path))) {
    throw new Error('source list contains an unsafe path');
  }
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const runDirectory = mkdtempSync(join(logDir, 'run-'));
  chmodSync(runDirectory, 0o700);
  const listFile = join(runDirectory, 'sources.txt');
  const progress = join(runDirectory, 'progress.jsonl');
  const placementJournal = join(runDirectory, 'placement-journal.jsonl');
  const transactionOwner = join(runDirectory, 'transaction-owner.json');
  writeNewPrivateDurable(listFile, selected.map((row) => row.path).join('\n') + '\n');
  writeNewPrivateDurable(progress, '');
  writeNewPrivateDurable(placementJournal, '');
  writeNewPrivateDurable(transactionOwner, `${JSON.stringify({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    ownerPid: process.pid,
    vaultHead: ownership.vaultHead ?? null,
    sources: selected.map((row) => ({ transcriptId: row.id ?? basename(row.path, '.jsonl'), sourcePath: row.path })),
  })}\n`);
  fsyncDirectory(runDirectory);
  fsyncDirectory(logDir);
  return {
    runDirectory,
    runId: basename(runDirectory),
    listFile,
    progress,
    placementJournal,
    transactionOwner,
  };
}

function validLegacyTuning(tuning, tuningKeys) {
  if (!exactObjectKeys(tuning, tuningKeys)) return false;
  try {
    const checked = validateStrayDrainConfig(tuning);
    return tuningKeys.every((key) => checked[key] === tuning[key]);
  } catch {
    return false;
  }
}

export function createLegacyRunArtifacts(logDir, {
  stateRoot,
  ledgerPath,
  dispositionsPath,
  drainerPath,
  vaultPath,
  vaultHead,
  tuning,
}) {
  const paths = [logDir, stateRoot, ledgerPath, dispositionsPath, drainerPath, vaultPath];
  const tuningKeys = [
    'chunkChars', 'concurrency', 'maxAttemptsPerProvider', 'maxChunksPerTranscript',
    'maxPerRun', 'maxSourceBytes', 'perProviderTimeoutMs', 'perTranscriptDeadlineMs',
    'quiescenceMinutes', 'subscriptionConcurrency',
  ];
  if (paths.some((path) => typeof path !== 'string' || !isAbsolute(path) || hasControlCharacter(path))
      || !/^[a-f0-9]{40,64}$/.test(vaultHead)
      || !validLegacyTuning(tuning, tuningKeys)) {
    throw new Error('invalid legacy run metadata');
  }
  ensureOrCreatePrivateDirectory(logDir, 'legacy run root');
  const runDirectory = mkdtempSync(join(logDir, 'legacy-run-'));
  chmodSync(runDirectory, 0o700);
  ensurePrivateDirectory(runDirectory, 'legacy run');
  const runId = randomUUID();
  const token = randomBytes(32).toString('hex');
  const progress = join(runDirectory, 'progress.jsonl');
  const placementJournal = join(runDirectory, 'placement-journal.jsonl');
  const transactionOwner = join(runDirectory, 'transaction-owner.json');
  const legacyRun = join(runDirectory, 'legacy-run.json');
  const createdAt = new Date().toISOString();
  writeNewPrivateDurable(progress, `${JSON.stringify({
    legacyProgressVersion: 1, event: 'marker', runId, token,
  })}\n`);
  writeNewPrivateDurable(placementJournal, `${JSON.stringify({
    legacyPlacementVersion: 1, event: 'marker', runId, token,
  })}\n`);
  writeNewPrivateDurable(transactionOwner, `${JSON.stringify({
    schemaVersion: 1,
    createdAt,
    ownerPid: process.pid,
    vaultHead,
    sources: [],
  })}\n`);
  writeNewPrivateDurable(legacyRun, `${JSON.stringify({
    legacyRunVersion: 1,
    event: 'legacy_run',
    createdAt,
    ownerPid: process.pid,
    vaultHead,
    runId,
    token,
    stateRoot,
    ledgerPath,
    dispositionsPath,
    drainerPath,
    vaultPath,
    tuning,
    progressPath: progress,
    placementJournalPath: placementJournal,
  })}\n`);
  fsyncDirectory(runDirectory);
  fsyncDirectory(logDir);
  return {
    runDirectory, runId, token, progress, placementJournal, transactionOwner, legacyRun,
  };
}

export function readLegacyRunMarker(runDirectory) {
  ensurePrivateDirectory(runDirectory, 'legacy run');
  const path = join(runDirectory, 'legacy-run.json');
  let marker;
  try { marker = JSON.parse(readPrivateStableText(path, 'legacy run marker')); }
  catch { throw new Error('legacy run marker is malformed'); }
  const keys = [
    'createdAt', 'dispositionsPath', 'drainerPath', 'event', 'ledgerPath',
    'legacyRunVersion', 'ownerPid', 'placementJournalPath', 'progressPath',
    'runId', 'stateRoot', 'token', 'tuning', 'vaultHead', 'vaultPath',
  ];
  const tuningKeys = [
    'chunkChars', 'concurrency', 'maxAttemptsPerProvider', 'maxChunksPerTranscript',
    'maxPerRun', 'maxSourceBytes', 'perProviderTimeoutMs', 'perTranscriptDeadlineMs',
    'quiescenceMinutes', 'subscriptionConcurrency',
  ];
  if (!exactObjectKeys(marker, keys) || marker.legacyRunVersion !== 1
      || marker.event !== 'legacy_run' || !UUID_PATTERN.test(marker.runId)
      || !/^[a-f0-9]{64}$/.test(marker.token) || !/^[a-f0-9]{40,64}$/.test(marker.vaultHead)
      || typeof marker.createdAt !== 'string'
      || new Date(marker.createdAt).toISOString() !== marker.createdAt
      || !Number.isSafeInteger(marker.ownerPid) || marker.ownerPid <= 0
      || !validLegacyTuning(marker.tuning, tuningKeys)) {
    throw new Error('legacy run marker is invalid');
  }
  for (const key of [
    'stateRoot', 'ledgerPath', 'dispositionsPath', 'drainerPath', 'vaultPath',
    'progressPath', 'placementJournalPath',
  ]) {
    if (typeof marker[key] !== 'string' || !isAbsolute(marker[key]) || hasControlCharacter(marker[key])) {
      throw new Error('legacy run marker has unsafe metadata');
    }
  }
  if (marker.progressPath !== join(runDirectory, 'progress.jsonl')
      || marker.placementJournalPath !== join(runDirectory, 'placement-journal.jsonl')) {
    throw new Error('legacy run marker artifact path mismatch');
  }
  readPrivateStable(marker.progressPath, 'legacy progress ledger');
  readPrivateStable(marker.placementJournalPath, 'legacy placement journal');
  return marker;
}

export function legacyTransactionOwnerIsActive(runDirectory) {
  const marker = readLegacyRunMarker(runDirectory);
  let owner;
  try {
    owner = JSON.parse(readPrivateStableText(
      join(runDirectory, 'transaction-owner.json'), 'legacy transaction owner',
    ));
  } catch (error) {
    if (/exact private regular file/i.test(error.message)) throw error;
    throw new Error('legacy transaction owner is malformed');
  }
  if (!exactObjectKeys(owner, ['createdAt', 'ownerPid', 'schemaVersion', 'sources', 'vaultHead'])
      || owner.schemaVersion !== 1 || owner.createdAt !== marker.createdAt
      || owner.ownerPid !== marker.ownerPid || owner.vaultHead !== marker.vaultHead
      || !Array.isArray(owner.sources) || owner.sources.length !== 0) {
    throw new Error('legacy transaction owner is invalid');
  }
  try {
    process.kill(owner.ownerPid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function persistLegacyAdoptionReceipt(path, raw) {
  const receipt = parseLegacyAdoptionReceipt(raw);
  writeLegacyPrivateAtomicIfAbsent(path, `${JSON.stringify(receipt)}\n`, 'legacy adoption receipt');
  return receipt;
}

export function persistLegacyPhaseReceipt(path, raw, phase, expected) {
  const receipt = parseLegacyPhaseReceipt(raw, phase, expected);
  writeLegacyPrivateAtomicIfAbsent(path, `${JSON.stringify(receipt)}\n`, `legacy ${phase} receipt`);
  return receipt;
}

function readLegacyAdoptionReceipt(path) {
  return parseLegacyAdoptionReceipt(readPrivateStableText(path, 'legacy adoption receipt'));
}

function writeLegacyResolution(runDirectory, marker, { status, records, commit = null }) {
  if (!['reconciled', 'captured', 'aborted'].includes(status)
      || !Number.isSafeInteger(records) || records < 0 || records > 400
      || (status === 'captured') !== Boolean(commit)
      || (commit !== null && !/^[a-f0-9]{40,64}$/.test(commit))) {
    throw new Error('invalid legacy resolution');
  }
  const path = join(runDirectory, 'legacy-resolution.json');
  writeLegacyPrivateAtomicIfAbsent(path, `${JSON.stringify({
    version: 1,
    event: 'legacy_resolution',
    runId: marker.runId,
    token: marker.token,
    status,
    records,
    commit,
  })}\n`, 'legacy resolution');
  return path;
}

function readLegacyResolution(path, marker) {
  let value;
  try { value = JSON.parse(readPrivateStableText(path, 'legacy resolution')); }
  catch { throw new Error('legacy resolution is malformed'); }
  if (!exactObjectKeys(value, ['commit', 'event', 'records', 'runId', 'status', 'token', 'version'])
      || value.version !== 1 || value.event !== 'legacy_resolution'
      || value.runId !== marker.runId || value.token !== marker.token
      || !['reconciled', 'captured', 'aborted'].includes(value.status)
      || !Number.isSafeInteger(value.records) || value.records < 0 || value.records > 400
      || (value.status === 'captured') !== Boolean(value.commit)
      || (value.commit !== null && !/^[a-f0-9]{40,64}$/.test(value.commit))) {
    throw new Error('legacy resolution is invalid');
  }
  return value;
}

function processLegacyRun({ runDirectory, timeoutMs, lib, scanner, wrapper }) {
  const marker = readLegacyRunMarker(runDirectory);
  const resolution = join(runDirectory, 'legacy-resolution.json');
  if (existsSync(resolution)) {
    const resolved = readLegacyResolution(resolution, marker);
    return { status: resolved.status, records: resolved.records, commit: resolved.commit };
  }
  const receiptPath = join(runDirectory, 'legacy-adoption-receipt.json');
  let receipt;
  if (existsSync(receiptPath)) {
    receipt = readLegacyAdoptionReceipt(receiptPath);
  } else {
    const child = run(process.execPath, buildLegacyDrainerArgs({
      drainer: marker.drainerPath,
      ledger: marker.ledgerPath,
      stateRoot: marker.stateRoot,
      progress: marker.progressPath,
      placementJournal: marker.placementJournalPath,
      dispositions: marker.dispositionsPath,
      runId: marker.runId,
      token: marker.token,
      bounds: marker.tuning,
    }), {
      timeoutMs,
      maxBuffer: 64 * 1024,
      env: { ...process.env, CHEAP_NO_ESCALATE: '1' },
    });
    if (child.code !== 0) throw new Error('legacy adoption child failed');
    receipt = persistLegacyAdoptionReceipt(receiptPath, child.stdout);
  }
  const evidence = reconcileLegacyEvidence({
    progressRaw: readPrivateStableText(marker.progressPath, 'legacy progress ledger'),
    placementRaw: readPrivateStableText(marker.placementJournalPath, 'legacy placement journal'),
    receipt,
    runId: marker.runId,
    token: marker.token,
  });
  if (!evidence.mined.length) {
    writeLegacyResolution(runDirectory, marker, { status: 'reconciled', records: 0 });
    return { status: 'reconciled', records: 0 };
  }
  const transaction = materializeLegacyTransaction({
    runDirectory,
    vault: marker.vaultPath,
    mined: evidence.mined,
    beforeHead: marker.vaultHead,
    runId: marker.runId,
    token: marker.token,
  });
  let commit;
  if (existsSync(transaction.commitOid)) {
    parseLegacyPhaseReceipt(
      readPrivateStableText(transaction.verifyReceipt, 'legacy verify receipt'),
      'verify', evidence.mined.length,
    );
    commit = persistLegacyCommitReceipt(
      transaction.commitOid,
      readPrivateStableText(transaction.commitOid, 'legacy commit receipt'),
    );
  } else {
    const current = run('git', ['rev-parse', 'HEAD'], { cwd: marker.vaultPath });
    if (current.code !== 0) throw new Error('legacy vault HEAD recovery query failed');
    if (current.stdout.trim() !== marker.vaultHead) {
      try {
        parseLegacyPhaseReceipt(
          readPrivateStableText(transaction.verifyReceipt, 'legacy verify receipt'),
          'verify', evidence.mined.length,
        );
        commit = derivePendingCommit(marker.vaultPath, marker.vaultHead, evidence.mined);
        persistLegacyCommitReceipt(transaction.commitOid, `${commit}\n`);
      } catch {
        const aborted = abortLegacyUnderVaultLock({
          marker, transaction, lib, timeoutMs, wrapper,
        });
        if (aborted.code !== 0) throw new Error('legacy head-advance abort failed');
        parseLegacyPhaseReceipt(
          readPrivateStableText(transaction.abortReceipt, 'legacy abort receipt'),
          'abort', evidence.mined.length,
        );
        writeLegacyResolution(runDirectory, marker, {
          status: 'aborted', records: evidence.mined.length,
        });
        throw new Error('legacy exact-path adoption aborted after vault head advance');
      }
    } else {
      const committed = commitLegacyExact({
        marker, transaction, lib, scanner, timeoutMs, wrapper,
      });
      if (committed.code !== 0) {
        const afterFailure = run('git', ['rev-parse', 'HEAD'], { cwd: marker.vaultPath });
        if (afterFailure.code !== 0 || afterFailure.stdout.trim() !== marker.vaultHead) {
          throw new Error('legacy exact-path commit outcome requires recovery');
        }
        const aborted = abortLegacyUnderVaultLock({
          marker, transaction, lib, timeoutMs, wrapper,
        });
        if (aborted.code !== 0) throw new Error('legacy exact-path abort failed');
        parseLegacyPhaseReceipt(
          readPrivateStableText(transaction.abortReceipt, 'legacy abort receipt'),
          'abort', evidence.mined.length,
        );
        writeLegacyResolution(runDirectory, marker, {
          status: 'aborted', records: evidence.mined.length,
        });
        throw new Error('legacy exact-path commit aborted');
      }
      parseLegacyPhaseReceipt(
        readPrivateStableText(transaction.verifyReceipt, 'legacy verify receipt'),
        'verify', evidence.mined.length,
      );
      commit = persistLegacyCommitReceipt(
        transaction.commitOid,
        readPrivateStableText(transaction.commitOid, 'legacy commit receipt'),
      );
    }
  }
  verifyCommittedTransaction(marker.vaultPath, evidence.mined, commit);
  if (existsSync(transaction.finalizeReceipt)) {
    parseLegacyPhaseReceipt(
      readPrivateStableText(transaction.finalizeReceipt, 'legacy finalize receipt'),
      'finalize', evidence.mined.length,
    );
  } else {
    const finalized = finalizeLegacyUnderVaultLock({
      marker, transaction, commit, lib, timeoutMs, wrapper,
    });
    if (finalized.code !== 0) throw new Error('legacy finalization failed');
    parseLegacyPhaseReceipt(
      readPrivateStableText(transaction.finalizeReceipt, 'legacy finalize receipt'),
      'finalize', evidence.mined.length,
    );
  }
  writeLegacyResolution(runDirectory, marker, {
    status: 'captured', records: evidence.mined.length, commit,
  });
  return { status: 'captured', records: evidence.mined.length, commit };
}

function resumeLegacyTransactions({ legacyRoot, timeoutMs, lib, scanner, wrapper }) {
  if (!existsSync(legacyRoot)) return [];
  const resumed = [];
  for (const entry of readdirSync(legacyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('legacy-run-')) continue;
    const runDirectory = join(legacyRoot, entry.name);
    if (existsSync(join(runDirectory, 'legacy-resolution.json'))) {
      resumed.push(processLegacyRun({ runDirectory, timeoutMs, lib, scanner, wrapper }));
      continue;
    }
    if (legacyTransactionOwnerIsActive(runDirectory)) {
      resumed.push({ status: 'owner_active', records: 0 });
      continue;
    }
    resumed.push(processLegacyRun({ runDirectory, timeoutMs, lib, scanner, wrapper }));
  }
  return resumed;
}

function readLedgerStrict(path) {
  if (!existsSync(path)) return new Set();
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`ledger read failed at ${path}: ${error.code ?? error.message}`);
  }
  const ids = new Set();
  for (const line of raw.split('\n')) {
    const id = line.trim();
    if (!id) continue;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new Error('ledger contains an invalid identifier');
    ids.add(id);
  }
  return ids;
}

function contained(path, root) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function hasForbiddenKey(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => FORBIDDEN_RECEIPT_KEYS.has(key) || hasForbiddenKey(child));
}

export function parseProgress(raw, expected, allowedStatuses = PROGRESS_STATUSES) {
  const rows = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); }
    catch { throw new Error(`malformed progress row ${index + 1}`); }
    if (hasForbiddenKey(row)) throw new Error(`forbidden content key in progress row ${index + 1}`);
    if (!row || Array.isArray(row) || typeof row !== 'object'
        || typeof row.transcriptId !== 'string' || typeof row.sourcePath !== 'string'
        || typeof row.status !== 'string' || typeof row.observedAt !== 'string'
        || typeof row.runId !== 'string') {
      throw new Error(`progress row ${index + 1} is missing required metadata`);
    }
    if (!allowedStatuses.has(row.status)) {
      throw new Error(`invalid progress status in row ${index + 1}`);
    }
    const observedAt = Date.parse(row.observedAt);
    if (!Number.isFinite(observedAt) || new Date(observedAt).toISOString() !== row.observedAt) {
      throw new Error(`invalid observedAt in progress row ${index + 1}`);
    }
    if (!UUID_PATTERN.test(row.runId)) throw new Error(`invalid runId in progress row ${index + 1}`);
    const allowedKeys = new Set([...BASE_PROGRESS_KEYS, ...OPTIONAL_PROGRESS_KEYS]);
    if (Object.keys(row).some((key) => !allowedKeys.has(key))) {
      throw new Error(`invalid progress schema in row ${index + 1}`);
    }
    for (const key of ['chars', 'chunks', 'durationMs']) {
      if (Object.hasOwn(row, key) && (!Number.isSafeInteger(row[key]) || row[key] < 0)) {
        throw new Error(`invalid ${key} in progress row ${index + 1}`);
      }
    }
    for (const key of ['sourceSha256', 'recordSha256']) {
      if (Object.hasOwn(row, key) && !/^[a-f0-9]{64}$/.test(row[key])) {
        throw new Error(`invalid ${key} in progress row ${index + 1}`);
      }
    }
    for (const key of ['project', 'detailCode', 'requestedSlot', 'provider', 'accountType']) {
      if (Object.hasOwn(row, key) && (typeof row[key] !== 'string' || row[key].length > 256)) {
        throw new Error(`invalid ${key} in progress row ${index + 1}`);
      }
    }
    for (const key of ['resolvedModel', 'failureReason']) {
      if (Object.hasOwn(row, key) && row[key] !== null
          && (typeof row[key] !== 'string' || row[key].length > 256)) {
        throw new Error(`invalid ${key} in progress row ${index + 1}`);
      }
    }
    if (Object.hasOwn(row, 'providerAttempts')) {
      if (!Array.isArray(row.providerAttempts) || row.providerAttempts.length > 144) {
        throw new Error(`invalid providerAttempts in progress row ${index + 1}`);
      }
      const keys = ['accountType', 'engine', 'failureReason', 'outcome', 'provider', 'requestedSlot', 'resolvedModel'];
      for (const attempt of row.providerAttempts) {
        if (!attempt || Array.isArray(attempt) || typeof attempt !== 'object'
            || Object.keys(attempt).sort().join(',') !== keys.sort().join(',')) {
          throw new Error(`invalid providerAttempts in progress row ${index + 1}`);
        }
        for (const key of ['engine', 'requestedSlot', 'provider', 'accountType', 'outcome']) {
          if (typeof attempt[key] !== 'string' || attempt[key].length > 256) {
            throw new Error(`invalid providerAttempts in progress row ${index + 1}`);
          }
        }
        for (const key of ['resolvedModel', 'failureReason']) {
          if (attempt[key] !== null && (typeof attempt[key] !== 'string' || attempt[key].length > 256)) {
            throw new Error(`invalid providerAttempts in progress row ${index + 1}`);
          }
        }
      }
    }
    if (row.status === 'mined'
        && (typeof row.recordPath !== 'string' || !isAbsolute(row.recordPath)
          || !/^[a-f0-9]{64}$/.test(row.recordSha256)
          || !/^[a-f0-9]{64}$/.test(row.sourceSha256))) {
      throw new Error(`mined progress row ${index + 1} requires source and record proof`);
    }
    if (row.status === 'mined'
        && (typeof row.requestedSlot !== 'string' || !row.requestedSlot
          || typeof row.provider !== 'string' || !row.provider
          || typeof row.accountType !== 'string' || !row.accountType
          || !Array.isArray(row.providerAttempts) || !row.providerAttempts.length)) {
      throw new Error(`mined progress row ${index + 1} requires provider proof`);
    }
    if (row.status === 'proven_duplicate'
        && (!/^[a-f0-9]{64}$/.test(row.sourceSha256)
          || typeof row.recordPath !== 'string' || !isAbsolute(row.recordPath)
          || !/^[a-f0-9]{64}$/.test(row.recordSha256))) {
      throw new Error(`proven_duplicate progress row ${index + 1} requires source and record proof`);
    }
    if (row.status !== 'mined' && row.status !== 'proven_duplicate'
        && (Object.hasOwn(row, 'recordPath') || Object.hasOwn(row, 'recordSha256'))) {
      throw new Error(`non-mined progress row ${index + 1} cannot carry record proof`);
    }
    rows.push(row);
  }
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.transcriptId)) throw new Error(`duplicate progress id ${row.transcriptId}`);
    seen.add(row.transcriptId);
  }
  if (expected) {
    const byId = new Map(expected.map((row) => [row.id, row.path]));
    for (const row of rows) {
      if (byId.get(row.transcriptId) !== row.sourcePath) {
        throw new Error(`progress source mismatch for ${row.transcriptId}`);
      }
    }
    if (rows.length !== expected.length) {
      throw new Error(`progress count mismatch: expected ${expected.length}, received ${rows.length}`);
    }
  }
  return rows;
}

function exactObjectKeys(value, keys) {
  return value && !Array.isArray(value) && typeof value === 'object'
    && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

function parseLegacyProgressRow(row) {
  if (row?.status !== 'legacy_source_missing') {
    return parseProgress(`${JSON.stringify(row)}\n`, null, LEGACY_PROGRESS_STATUSES)[0];
  }
  const observedAt = Date.parse(row.observedAt);
  if (!exactObjectKeys(row, [
    'censusSha256', 'legacyLedgerSha256', 'observedAt', 'runId', 'sourcePath', 'status',
    'transcriptId',
  ]) || row.sourcePath !== null || !REQUESTED_ID_PATTERN.test(row.transcriptId)
      || !UUID_PATTERN.test(row.runId) || !Number.isFinite(observedAt)
      || new Date(observedAt).toISOString() !== row.observedAt
      || !/^[a-f0-9]{64}$/.test(row.legacyLedgerSha256)
      || !/^[a-f0-9]{64}$/.test(row.censusSha256)) {
    throw new Error('invalid legacy source-missing progress row');
  }
  return row;
}

export function reconcileLegacyEvidence({ progressRaw, placementRaw, receipt, runId, token }) {
  const invalid = () => new Error('invalid legacy evidence');
  try {
    if (!UUID_PATTERN.test(runId) || !/^[a-f0-9]{64}$/.test(token)
        || typeof progressRaw !== 'string' || typeof placementRaw !== 'string') throw invalid();
    const checkedReceipt = parseLegacyAdoptionReceipt(`${JSON.stringify(receipt)}\n`);
    const parseLines = (raw) => {
      if (!raw.endsWith('\n')) throw invalid();
      return raw.slice(0, -1).split('\n').map((line) => {
        if (!line || /\r/.test(line)) throw invalid();
        const value = JSON.parse(line);
        if (hasForbiddenKey(value) || !value || Array.isArray(value) || typeof value !== 'object') throw invalid();
        return value;
      });
    };
    const progressValues = parseLines(progressRaw);
    const progressMarker = progressValues.shift();
    if (!exactObjectKeys(progressMarker, ['legacyProgressVersion', 'event', 'runId', 'token'])
        || progressMarker.legacyProgressVersion !== 1 || progressMarker.event !== 'marker'
        || progressMarker.runId !== runId || progressMarker.token !== token) throw invalid();
    const rows = progressValues.map(parseLegacyProgressRow);
    if (rows.some((row) => row.runId !== runId
        || !REQUESTED_ID_PATTERN.test(row.transcriptId)
        || (row.status !== 'legacy_source_missing'
          && (!isAbsolute(row.sourcePath) || hasControlCharacter(row.sourcePath)))
        || (Object.hasOwn(row, 'recordPath') && hasControlCharacter(row.recordPath)))
        || rows.length !== checkedReceipt.selected) throw invalid();
    const counts = {};
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    if (!isDeepStrictEqual(
      Object.entries(counts).sort(), Object.entries(checkedReceipt.counts).sort(),
    )) throw invalid();

    const placementValues = parseLines(placementRaw);
    const placementMarker = placementValues.shift();
    if (!exactObjectKeys(placementMarker, ['legacyPlacementVersion', 'event', 'runId', 'token'])
        || placementMarker.legacyPlacementVersion !== 1 || placementMarker.event !== 'marker'
        || placementMarker.runId !== runId || placementMarker.token !== token) throw invalid();
    const intents = new Map();
    const placed = new Map();
    for (const value of placementValues) {
      if (value.legacyPlacementVersion !== 1 || value.runId !== runId || value.token !== token
          || (value.event !== 'intent' && value.event !== 'placed')) throw invalid();
      const { legacyPlacementVersion, event, token: _token, desiredRecordPath, ...proof } = value;
      const candidate = parseProgress(`${JSON.stringify({
        ...proof,
        status: 'mined',
        ...(event === 'intent' ? { recordPath: desiredRecordPath } : {}),
      })}\n`, null, LEGACY_PROGRESS_STATUSES)[0];
      const target = event === 'intent' ? intents : placed;
      if (target.has(candidate.transcriptId)) throw invalid();
      target.set(candidate.transcriptId, candidate);
    }
    const mined = rows.filter((row) => row.status === 'mined');
    if (intents.size !== mined.length || placed.size !== mined.length) throw invalid();
    for (const row of mined) {
      if (!isDeepStrictEqual(intents.get(row.transcriptId), row)
          || !isDeepStrictEqual(placed.get(row.transcriptId), row)) throw invalid();
    }
    return { rows, mined };
  } catch {
    throw invalid();
  }
}

function parseEvidenceLines(raw, label) {
  const rows = [];
  const issues = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(parseProgress(`${line}\n`, null)[0]);
    } catch {
      issues.push({ kind: `malformed_${label}`, line: index + 1 });
    }
  }
  return { rows, issues };
}

function parsePlacementJournalEvidence(raw) {
  const placed = [];
  const intents = [];
  const claimIntents = [];
  const claimAcquired = [];
  const issues = [];
  const intentKeys = [
    'accountType', 'chars', 'chunks', 'desiredRecordPath', 'event', 'failureReason',
    'observedAt', 'project', 'provider', 'providerAttempts', 'recordSha256',
    'requestedSlot', 'resolvedModel', 'runId', 'sourcePath', 'sourceSha256', 'transcriptId',
  ];
  const claimKeys = ['event', 'observedAt', 'ownerPid', 'runId', 'sourcePath', 'transcriptId'];
  const precedingClaims = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (hasForbiddenKey(value) || !value || Array.isArray(value) || typeof value !== 'object') {
        throw new Error('unsafe journal row');
      }
      if (value.event === 'placed') {
        const { event, ...candidate } = value;
        placed.push(parseProgress(`${JSON.stringify(candidate)}\n`, null)[0]);
        continue;
      }
      if (value.event === 'claim_intent' || value.event === 'claim_acquired') {
        if (Object.keys(value).sort().join(',') !== claimKeys.join(',')
            || typeof value.transcriptId !== 'string' || !value.transcriptId
            || typeof value.sourcePath !== 'string' || !isAbsolute(value.sourcePath)
            || /[\r\n\0]/.test(value.sourcePath)
            || !UUID_PATTERN.test(value.runId)
            || new Date(value.observedAt).toISOString() !== value.observedAt
            || !Number.isSafeInteger(value.ownerPid) || value.ownerPid <= 0) {
          throw new Error('invalid claim intent proof');
        }
        if (value.event === 'claim_intent') {
          claimIntents.push(value);
          precedingClaims.push(value);
        } else {
          const { event: _event, ...proof } = value;
          const predecessor = [...precedingClaims].reverse().find((candidate) => {
            const { event: _candidateEvent, ...candidateProof } = candidate;
            return isDeepStrictEqual(candidateProof, proof);
          });
          if (!predecessor) throw new Error('claim acquisition lacks an exact preceding intent');
          claimAcquired.push(value);
        }
        continue;
      }
      if (value.event !== 'intent' || Object.keys(value).sort().join(',') !== intentKeys.sort().join(',')) {
        throw new Error('invalid journal event');
      }
      const { event, desiredRecordPath, ...proof } = value;
      parseProgress(`${JSON.stringify({
        ...proof,
        status: 'mined',
        recordPath: desiredRecordPath,
      })}\n`, null);
      intents.push(value);
    } catch {
      issues.push({ kind: 'malformed_journal', line: index + 1 });
    }
  }
  return { placed, intents, claimIntents, claimAcquired, issues };
}

export function reconcileRunEvidence({ progressRaw, journalRaw = '', expected, supplementalRows = [] }) {
  const expectedById = new Map(expected.map((row) => [row.id, row.path]));
  const progress = parseEvidenceLines(progressRaw, 'progress');
  const journal = parsePlacementJournalEvidence(journalRaw);
  const issues = [...progress.issues, ...journal.issues];
  const accepted = new Map();
  const blocked = new Set();
  const block = (id, kind) => {
    accepted.delete(id);
    blocked.add(id);
    issues.push({ kind, transcriptId: id });
  };
  const accept = (row, conflictKind) => {
    const id = row.transcriptId;
    if (blocked.has(id)) return;
    const existing = accepted.get(id);
    if (existing && !isDeepStrictEqual(existing, row)) {
      block(id, conflictKind);
      return;
    }
    accepted.set(id, row);
  };

  for (const row of progress.rows) {
    if (expectedById.get(row.transcriptId) !== row.sourcePath) {
      issues.push({ kind: 'progress_source_mismatch', transcriptId: row.transcriptId });
      if (expectedById.has(row.transcriptId)) blocked.add(row.transcriptId);
      continue;
    }
    accept(row, 'conflicting_progress');
  }
  for (const row of supplementalRows) {
    parseProgress(`${JSON.stringify(row)}\n`, null);
    if (expectedById.get(row.transcriptId) !== row.sourcePath) {
      issues.push({ kind: 'supplemental_source_mismatch', transcriptId: row.transcriptId });
      if (expectedById.has(row.transcriptId)) blocked.add(row.transcriptId);
      continue;
    }
    accept(row, 'supplemental_progress_conflict');
  }

  const journalById = new Map();
  for (const row of journal.placed) {
    if (expectedById.get(row.transcriptId) !== row.sourcePath) {
      issues.push({ kind: 'journal_source_mismatch', transcriptId: row.transcriptId });
      if (expectedById.has(row.transcriptId)) blocked.add(row.transcriptId);
      continue;
    }
    const existing = journalById.get(row.transcriptId);
    if (existing && !isDeepStrictEqual(existing, row)) {
      journalById.delete(row.transcriptId);
      block(row.transcriptId, 'conflicting_journal');
      continue;
    }
    if (!blocked.has(row.transcriptId)) journalById.set(row.transcriptId, row);
  }

  const intentById = new Map();
  for (const intent of journal.intents) {
    if (expectedById.get(intent.transcriptId) !== intent.sourcePath) {
      issues.push({ kind: 'journal_intent_source_mismatch', transcriptId: intent.transcriptId });
      if (expectedById.has(intent.transcriptId)) blocked.add(intent.transcriptId);
      continue;
    }
    const existing = intentById.get(intent.transcriptId);
    if (existing && !isDeepStrictEqual(existing, intent)) {
      intentById.delete(intent.transcriptId);
      block(intent.transcriptId, 'conflicting_journal_intent');
      continue;
    }
    if (!blocked.has(intent.transcriptId)) intentById.set(intent.transcriptId, intent);
  }

  for (const [id, row] of journalById) {
    if (blocked.has(id)) continue;
    const prior = accepted.get(id);
    if (prior && !isDeepStrictEqual(prior, row)) {
      block(id, 'journal_progress_conflict');
      continue;
    }
    const intent = intentById.get(id);
    if (intent) {
      const { event: _event, desiredRecordPath: recordPath, ...proof } = intent;
      const intended = { ...proof, status: 'mined', recordPath };
      if (!isDeepStrictEqual(intended, row)) {
        block(id, 'journal_intent_placement_conflict');
        continue;
      }
      intentById.delete(id);
    }
    accepted.set(id, row);
  }

  for (const [id, intent] of intentById) {
    if (blocked.has(id)) continue;
    const prior = accepted.get(id);
    if (prior) {
      const { event: _event, desiredRecordPath: recordPath, ...proof } = intent;
      const intended = { ...proof, status: 'mined', recordPath };
      if (!isDeepStrictEqual(intended, prior)) block(id, 'journal_intent_progress_conflict');
    }
  }
  const rows = [];
  const missing = [];
  const claimById = new Map();
  for (const intent of journal.claimIntents) {
    if (expectedById.get(intent.transcriptId) !== intent.sourcePath) {
      issues.push({ kind: 'claim_intent_source_mismatch', transcriptId: intent.transcriptId });
      if (expectedById.has(intent.transcriptId)) blocked.add(intent.transcriptId);
      continue;
    }
    const existing = claimById.get(intent.transcriptId);
    if (existing && !isDeepStrictEqual(existing, intent)) {
      claimById.delete(intent.transcriptId);
      block(intent.transcriptId, 'conflicting_claim_intent');
      continue;
    }
    if (!blocked.has(intent.transcriptId)) claimById.set(intent.transcriptId, intent);
  }
  const acquiredById = new Map();
  for (const acquired of journal.claimAcquired) {
    if (expectedById.get(acquired.transcriptId) !== acquired.sourcePath) {
      issues.push({ kind: 'claim_acquired_source_mismatch', transcriptId: acquired.transcriptId });
      if (expectedById.has(acquired.transcriptId)) blocked.add(acquired.transcriptId);
      continue;
    }
    const existing = acquiredById.get(acquired.transcriptId);
    if (existing && !isDeepStrictEqual(existing, acquired)) {
      acquiredById.delete(acquired.transcriptId);
      block(acquired.transcriptId, 'conflicting_claim_acquired');
      continue;
    }
    if (!blocked.has(acquired.transcriptId)) acquiredById.set(acquired.transcriptId, acquired);
  }
  for (const id of blocked) accepted.delete(id);
  for (const item of expected) {
    const row = accepted.get(item.id);
    if (row) rows.push(row);
    else missing.push({
      transcriptId: item.id,
      sourcePath: item.path,
      status: 'missing_progress',
      ...(blocked.has(item.id)
        ? { detailCode: 'evidence_conflict' }
        : intentById.has(item.id)
        ? { detailCode: 'placement_intent_unresolved' }
        : acquiredById.has(item.id)
          ? { detailCode: 'claim_acquired_unresolved' }
        : claimById.has(item.id)
          ? { detailCode: 'claim_intent_unproven' }
          : {}),
    });
  }
  return {
    rows,
    missing,
    issues,
    intents: [...intentById.entries()].filter(([id]) => !blocked.has(id)).map(([, intent]) => intent),
    claimIntents: journal.claimIntents,
    claimAcquired: journal.claimAcquired,
    blockedTranscriptIds: [...blocked].sort(),
  };
}

export function selectReleasedClaimRows(dispositions, claimIntents) {
  if (!claimIntents.length || !existsSync(dispositions)) return [];
  privateRegular(dispositions, 'disposition ledger');
  const identities = new Set(claimIntents.map((row) => `${row.runId}\0${row.transcriptId}\0${row.sourcePath}`));
  const selected = new Map();
  for (const line of readFileSync(dispositions, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.status !== 'claim_error' || row.detailCode !== 'recovered-dead-owner-before-placement') continue;
    const identity = `${row.runId}\0${row.transcriptId}\0${row.sourcePath}`;
    if (!identities.has(identity)) continue;
    parseProgress(`${JSON.stringify(row)}\n`, null);
    const prior = selected.get(identity);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) {
      throw new Error(`conflicting released-claim proof for ${row.transcriptId}`);
    }
    selected.set(identity, row);
  }
  return [...selected.values()];
}

function run(command, args, { cwd, timeoutMs, env, maxBuffer = 256 * 1024 * 1024 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const failureReason = result.error?.code === 'ETIMEDOUT'
    ? 'timeout'
    : result.error?.code === 'ENOENT'
      ? 'unavailable'
      : result.status === null
        ? 'spawn_error'
        : null;
  return {
    code: result.status ?? 124,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    failureReason,
  };
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function scanExactRecords({ scanner, paths, execute = run }) {
  if (!existsSync(scanner) || !lstatSync(scanner).isFile()) {
    throw new Error(`credential scanner unavailable at ${scanner}`);
  }
  for (const path of paths) {
    const result = execute(process.execPath, [scanner, path], { timeoutMs: 120_000 });
    if (result.code !== 0) {
      throw new Error(`credential scan failed for ${path}: exit_${result.code}`);
    }
  }
}

function readExactStagedBlob({ vault, recordRelative, recordSha256, execute }) {
  const staged = execute('git', ['ls-files', '-s', '--', recordRelative], { cwd: vault });
  const lines = staged.stdout.split('\n').filter(Boolean);
  if (staged.code !== 0 || lines.length !== 1) {
    throw new Error('staged record index proof is invalid');
  }
  const match = /^100644 ([a-f0-9]{40,64}) 0\t(.+)$/.exec(lines[0]);
  if (!match || match[2] !== recordRelative) {
    throw new Error('staged record index proof is invalid');
  }
  const object = execute('git', ['cat-file', 'blob', match[1]], { cwd: vault });
  if (object.code !== 0) throw new Error('staged record blob is unavailable');
  const body = Buffer.from(object.stdout, 'utf8');
  if (createHash('sha256').update(body).digest('hex') !== recordSha256) {
    throw new Error('staged record hash mismatches frozen evidence');
  }
  return { oid: match[1], body };
}

function scanImmutableStagedBlob({ scanner, staged, temporaryRoot, execute }) {
  const temporary = join(temporaryRoot, `.staged-record-${randomUUID()}.tmp`);
  writeNewPrivateDurable(temporary, staged.body);
  try {
    scanExactRecords({ scanner, paths: [temporary], execute });
  } finally {
    try { unlinkSync(temporary); } catch { /* failed scanner result remains authoritative */ }
  }
}

function verifyStagedRecordBlobs({ vault, scanner, records, temporaryRoot, execute = run }) {
  const staged = records.map((row) => ({
    row,
    staged: readExactStagedBlob({ vault, ...row, execute }),
  }));
  for (const item of staged) {
    scanImmutableStagedBlob({ scanner, staged: item.staged, temporaryRoot, execute });
  }
  for (const item of staged) {
    const current = readExactStagedBlob({ vault, ...item.row, execute });
    if (current.oid !== item.staged.oid) {
      throw new Error('staged record index changed after credential scan');
    }
  }
  return staged.length;
}

export function finalizeCaptured({
  drainer,
  progress,
  dispositions,
  commit,
  expected,
  timeoutMs,
  execute = run,
}) {
  const result = execute(process.execPath, [
    drainer,
    '--finalize-progress', progress,
    '--commit', commit,
    '--dispositions', dispositions,
  ], { timeoutMs });
  if (result.code !== 0) {
    throw new Error(`captured disposition finalization failed: ${result.failureReason ?? `exit_${result.code}`}`);
  }
  let receipt;
  try { receipt = JSON.parse(result.stdout.trim()); }
  catch { throw new Error('captured disposition finalization returned malformed metadata'); }
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'finalized,status'
      || receipt.status !== 'captured' || receipt.finalized !== expected) {
    throw new Error('captured disposition finalization count mismatch');
  }
}

export function verifyCapturedDispositions(dispositions, minedRows, commit) {
  privateRegular(dispositions, 'disposition ledger');
  const rows = readPrivateStableText(dispositions, 'disposition ledger').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`malformed disposition row ${index + 1}`); }
  });
  for (const mined of minedRows) {
    const matches = rows.filter((row) => row.status === 'captured'
      && row.transcriptId === mined.transcriptId
      && row.sourcePath === mined.sourcePath
      && row.sourceSha256 === mined.sourceSha256
      && row.recordPath === mined.recordPath
      && row.recordSha256 === mined.recordSha256
      && row.commit === commit);
    if (matches.length !== 1) {
      throw new Error(`captured disposition proof mismatch for ${mined.transcriptId}`);
    }
    const [captured] = matches;
    if (typeof captured.reachability !== 'string' || !captured.reachability
        || hasForbiddenKey(captured)) {
      throw new Error(`captured disposition metadata invalid for ${mined.transcriptId}`);
    }
  }
}

function privateRegular(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o600
      || stat.nlink !== 1) {
    throw new Error(`${label} is not an exact private regular file`);
  }
  return stat;
}

function writePrivateAtomicIfAbsent(path, body, label) {
  if (existsSync(path)) {
    privateRegular(path, label);
    if (readFileSync(path, 'utf8') !== body) throw new Error(`${label} conflicts with durable state`);
    return path;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return path;
}

function writeLegacyPrivateAtomicIfAbsent(path, body, label) {
  if (existsSync(path)) {
    if (readPrivateStableText(path, label) !== body) throw new Error(`${label} conflicts with durable state`);
    return path;
  }
  ensurePrivateDirectory(dirname(path), 'legacy artifact parent');
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, 0o600);
  try {
    linkSync(temporary, path);
  } catch (error) {
    if (error?.code !== 'EEXIST' || readPrivateStableText(path, label) !== body) {
      throw new Error(`${label} publication conflicts with durable state`);
    }
  } finally {
    try { unlinkSync(temporary); } catch { /* publication error remains authoritative */ }
  }
  chmodSync(path, 0o600);
  fsyncDirectory(dirname(path));
  return path;
}

function verifyCommittedTransaction(vault, minedRows, commit, execute = run) {
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error('pending transaction has an invalid commit object id');
  const reachable = execute('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: vault });
  if (reachable.code !== 0) throw new Error('pending transaction commit is not reachable from vault HEAD');
  const expectedPaths = [];
  for (const row of minedRows) {
    const requested = resolve(row.recordPath);
    if (!contained(requested, resolve(vault))) throw new Error(`pending record escaped vault for ${row.transcriptId}`);
    const recordRelative = relative(resolve(vault), requested);
    if (!/^project-memory\/[^/]+\/sessions\/[^/]+\.md$/.test(recordRelative)) {
      throw new Error(`pending record path is invalid for ${row.transcriptId}`);
    }
    const object = execute('git', ['cat-file', 'blob', `${commit}:${recordRelative}`], { cwd: vault });
    if (object.code !== 0 || createHash('sha256').update(object.stdout).digest('hex') !== row.recordSha256) {
      throw new Error(`pending commit record proof mismatch for ${row.transcriptId}`);
    }
    expectedPaths.push(recordRelative);
  }
  const actualPaths = execute('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', commit], { cwd: vault });
  if (actualPaths.code !== 0) throw new Error('pending transaction commit path query failed');
  assertSamePaths(actualPaths.stdout.split('\n').filter(Boolean).sort(), expectedPaths.sort());
}

export function derivePendingCommit(vault, beforeHead, minedRows, execute = run) {
  if (!/^[a-f0-9]{40,64}$/i.test(beforeHead)) throw new Error('pending transaction has an invalid before object id');
  const ancestor = execute('git', ['merge-base', '--is-ancestor', beforeHead, 'HEAD'], { cwd: vault });
  if (ancestor.code !== 0) throw new Error('pending transaction base is not reachable from vault HEAD');
  const range = execute('git', ['rev-list', '--reverse', `${beforeHead}..HEAD`], { cwd: vault });
  if (range.code !== 0) throw new Error('pending transaction history query failed');
  const matches = [];
  for (const commit of range.stdout.split('\n').filter(Boolean)) {
    try {
      verifyCommittedTransaction(vault, minedRows, commit, execute);
      matches.push(commit);
    } catch {
      // Non-matching intervening commits are expected; uniqueness is enforced below.
    }
  }
  if (matches.length !== 1) {
    throw new Error(`pending transaction commit derivation expected 1 match, received ${matches.length}`);
  }
  return matches[0];
}

function verifyRolledBackTransaction(specPath, recoveryManifest, dispositions, ledgerPath, minedRows) {
  privateRegular(specPath, 'rolled-back transaction specification');
  privateRegular(recoveryManifest, 'rolled-back recovery manifest');
  privateRegular(dispositions, 'disposition ledger');
  const manifestBody = readFileSync(recoveryManifest, 'utf8');
  const manifestSha256 = createHash('sha256').update(manifestBody).digest('hex');
  const mappings = manifestBody.split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`malformed recovery manifest row ${index + 1}`); }
  });
  if (mappings.length !== minedRows.length) throw new Error('rolled-back recovery manifest is incomplete');
  const dispositionRows = readFileSync(dispositions, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`malformed disposition row ${index + 1}`); }
  });
  const claimed = readLedgerStrict(ledgerPath);
  for (const row of minedRows) {
    if (claimed.has(row.transcriptId)) throw new Error(`rolled-back claim remains for ${row.transcriptId}`);
    const matches = mappings.filter((mapping) => mapping
      && Object.keys(mapping).sort().join(',') === 'recordPath,recordSha256,recoveredPath,transcriptId'
      && mapping.transcriptId === row.transcriptId
      && mapping.recordPath === row.recordPath
      && mapping.recordSha256 === row.recordSha256);
    if (matches.length !== 1) throw new Error(`rolled-back recovery proof mismatch for ${row.transcriptId}`);
    const [mapping] = matches;
    if (existsSync(mapping.recordPath)) throw new Error(`rolled-back record remains at its original path for ${row.transcriptId}`);
    privateRegular(mapping.recoveredPath, 'rolled-back recovered record');
    if (sha256(mapping.recoveredPath) !== row.recordSha256) {
      throw new Error(`rolled-back recovery hash mismatch for ${row.transcriptId}`);
    }
    const terminal = dispositionRows.filter((candidate) => candidate.status === 'claim_error'
      && candidate.transcriptId === row.transcriptId
      && candidate.recordPath === row.recordPath
      && candidate.recordSha256 === row.recordSha256
      && candidate.detailCode === 'rolled-back-to-recovery'
      && candidate.recoveryManifest === recoveryManifest
      && candidate.recoveryManifestSha256 === manifestSha256);
    if (terminal.length !== 1) throw new Error(`rolled-back disposition proof mismatch for ${row.transcriptId}`);
  }
}

function finalizeUnderVaultLock({ vault, lib, drainer, progress, dispositions, commit, expected, timeoutMs }) {
  const script = [
    'set -u',
    'source "$1"',
    'vault="$2"',
    'drainer="$3"',
    'progress="$4"',
    'dispositions="$5"',
    'commit="$6"',
    'lk="$(wrap_lock "vault-$vault" 60)" || exit 70',
    'trap \'wrap_unlock "$lk" >/dev/null 2>&1 || true\' EXIT HUP INT TERM',
    'node "$drainer" --finalize-progress "$progress" --commit "$commit" --dispositions "$dispositions"',
  ].join('\n');
  const result = run('/bin/bash', [
    '-c', script, '_', lib, vault, drainer, progress, dispositions, commit,
  ], { timeoutMs });
  if (result.code !== 0) {
    throw new Error(`pending captured disposition finalization failed: ${result.failureReason ?? `exit_${result.code}`}`);
  }
  const lines = result.stdout.split('\n').filter(Boolean);
  let receipt;
  try { receipt = JSON.parse(lines.at(-1)); }
  catch { throw new Error('pending captured disposition finalization returned malformed metadata'); }
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'finalized,status'
      || receipt.status !== 'captured' || receipt.finalized !== expected) {
    throw new Error('pending captured disposition finalization count mismatch');
  }
}

function rollbackUnderVaultLock({
  vault, lib, wrapper, rollbackSpec, drainer, progress, recoveryManifest,
  dispositions, expected, timeoutMs,
}) {
  const script = [
    'set -u',
    'source "$1"',
    'vault="$2"',
    'wrapper="$3"',
    'spec="$4"',
    'drainer="$5"',
    'progress="$6"',
    'recovery="$7"',
    'dispositions="$8"',
    'lk="$(wrap_lock "vault-$vault" 60)" || exit 70',
    'trap \'wrap_unlock "$lk" >/dev/null 2>&1 || true\' EXIT HUP INT TERM',
    'node --input-type=module -e \'const m=await import(process.argv[2]); await m.rollbackPlacedRecords(process.argv[3], process.argv[4], process.argv[5]);\' stack-stray-library "$wrapper" "$spec" "$recovery" "$vault"',
    'node "$drainer" --rollback-progress "$progress" --recovery-manifest "$recovery" --dispositions "$dispositions"',
  ].join('\n');
  const result = run('/bin/bash', [
    '-c', script, '_', lib, vault, wrapper, rollbackSpec,
    drainer, progress, recoveryManifest, dispositions,
  ], { timeoutMs });
  if (result.code !== 0) {
    throw new Error(`pending rollback finalization failed: ${result.failureReason ?? `exit_${result.code}`}`);
  }
  const lines = result.stdout.split('\n').filter(Boolean);
  let receipt;
  try { receipt = JSON.parse(lines.at(-1)); }
  catch { throw new Error('pending rollback finalization returned malformed metadata'); }
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'rolledBack,status'
      || receipt.status !== 'claim_error' || receipt.rolledBack !== expected) {
    throw new Error('pending rollback finalization count mismatch');
  }
}

function recoverPlacementJournalUnderVaultLock({ vault, lib, drainer, placementJournal, dispositions, timeoutMs }) {
  const script = [
    'set -u',
    'source "$1"',
    'vault="$2"',
    'drainer="$3"',
    'journal="$4"',
    'dispositions="$5"',
    'lk="$(wrap_lock "vault-$vault" 60)" || exit 70',
    'trap \'wrap_unlock "$lk" >/dev/null 2>&1 || true\' EXIT HUP INT TERM',
    'node "$drainer" --recover-placement-journal "$journal" --dispositions "$dispositions"',
  ].join('\n');
  const result = run('/bin/bash', [
    '-c', script, '_', lib, vault, drainer, placementJournal, dispositions,
  ], { timeoutMs });
  if (result.code !== 0) {
    throw new Error(`placement journal recovery failed: ${result.failureReason ?? `exit_${result.code}`}`);
  }
  const lines = result.stdout.split('\n').filter(Boolean);
  let receipt;
  try { receipt = JSON.parse(lines.at(-1)); }
  catch { throw new Error('placement journal recovery returned malformed metadata'); }
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'active,missing,recovered,released,status,unproven'
      || receipt.status !== 'reconciled'
      || ['active', 'missing', 'recovered', 'released', 'unproven'].some((key) => (
        !Number.isSafeInteger(receipt[key]) || receipt[key] < 0
      ))) {
    throw new Error('placement journal recovery returned invalid metadata');
  }
  return receipt;
}

function writeTransactionResolution(runDirectory, { status, commit = null, records }) {
  const validResolution = (candidateStatus, candidateCommit, candidateRecords) => (
    (candidateStatus === 'captured' && /^[a-f0-9]{40,64}$/i.test(candidateCommit ?? '') && candidateRecords > 0)
    || (candidateStatus === 'rolled_back' && candidateCommit === null && candidateRecords > 0)
    || (candidateStatus === 'no_placements' && candidateCommit === null && candidateRecords === 0)
  );
  if (!Number.isSafeInteger(records) || !validResolution(status, commit, records)) {
    throw new Error('transaction resolution state is invalid');
  }
  const path = join(runDirectory, 'transaction-resolution.json');
  const value = { schemaVersion: 1, status, commit, records };
  if (existsSync(path)) {
    privateRegular(path, 'transaction resolution');
    let prior;
    try { prior = JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new Error('transaction resolution is malformed'); }
    const keys = ['commit', 'records', 'resolvedAt', 'schemaVersion', 'status'];
    if (!prior || Array.isArray(prior) || typeof prior !== 'object'
        || Object.keys(prior).sort().join(',') !== keys.join(',')
        || !Number.isSafeInteger(prior.records)
        || !validResolution(prior.status, prior.commit, prior.records)
        || typeof prior.resolvedAt !== 'string'
        || new Date(prior.resolvedAt).toISOString() !== prior.resolvedAt) {
      throw new Error('transaction resolution is invalid');
    }
    if (prior.schemaVersion !== value.schemaVersion || prior.status !== value.status
        || prior.commit !== value.commit || prior.records !== value.records) {
      throw new Error('transaction resolution conflicts with verified state');
    }
    return path;
  }
  return writePrivateAtomicIfAbsent(
    path,
    `${JSON.stringify({ ...value, resolvedAt: new Date().toISOString() })}\n`,
    'transaction resolution',
  );
}

function validateIncompleteRetirement(runDirectory) {
  const retirement = join(runDirectory, 'incomplete-progress-retirement.json');
  const incomplete = join(runDirectory, 'incomplete-progress.json');
  const resolution = join(runDirectory, 'transaction-resolution.json');
  if (!existsSync(retirement)) return false;
  privateRegular(retirement, 'incomplete progress retirement');
  privateRegular(incomplete, 'incomplete progress receipt');
  privateRegular(resolution, 'transaction resolution');
  let row;
  try { row = JSON.parse(readFileSync(retirement, 'utf8')); }
  catch { throw new Error('incomplete progress retirement is malformed'); }
  const keys = [
    'incompleteReceiptSha256', 'issueCount', 'missingCount', 'retiredAt',
    'schemaVersion', 'status', 'transactionResolutionSha256',
  ];
  if (!row || Array.isArray(row) || typeof row !== 'object'
      || Object.keys(row).sort().join(',') !== keys.join(',')
      || row.schemaVersion !== 1 || row.status !== 'transaction_retired'
      || !Number.isSafeInteger(row.missingCount) || row.missingCount < 0
      || !Number.isSafeInteger(row.issueCount) || row.issueCount < 0
      || !/^[a-f0-9]{64}$/.test(row.incompleteReceiptSha256)
      || !/^[a-f0-9]{64}$/.test(row.transactionResolutionSha256)
      || typeof row.retiredAt !== 'string'
      || new Date(row.retiredAt).toISOString() !== row.retiredAt
      || sha256(incomplete) !== row.incompleteReceiptSha256
      || sha256(resolution) !== row.transactionResolutionSha256) {
    throw new Error('incomplete progress retirement is invalid');
  }
  return true;
}

function retireIncompleteReceipt(runDirectory) {
  const incomplete = join(runDirectory, 'incomplete-progress.json');
  if (!existsSync(incomplete)) return null;
  const retirement = join(runDirectory, 'incomplete-progress-retirement.json');
  if (existsSync(retirement)) {
    validateIncompleteRetirement(runDirectory);
    return retirement;
  }
  privateRegular(incomplete, 'incomplete progress receipt');
  const resolution = join(runDirectory, 'transaction-resolution.json');
  privateRegular(resolution, 'transaction resolution');
  let prior;
  try { prior = JSON.parse(readFileSync(incomplete, 'utf8')); }
  catch { throw new Error('incomplete progress receipt is malformed'); }
  if (!prior || !Array.isArray(prior.missing) || !Array.isArray(prior.issues)) {
    throw new Error('incomplete progress receipt is invalid');
  }
  return writePrivateAtomicIfAbsent(
    retirement,
    `${JSON.stringify({
      schemaVersion: 1,
      status: 'transaction_retired',
      retiredAt: new Date().toISOString(),
      incompleteReceiptSha256: sha256(incomplete),
      transactionResolutionSha256: sha256(resolution),
      missingCount: prior.missing.length,
      issueCount: prior.issues.length,
    })}\n`,
    'incomplete progress retirement',
  );
}

function evidenceCanRetireTransaction(evidence, recovery) {
  if (recovery.active || recovery.missing || recovery.unproven) return false;
  if (evidence.blockedTranscriptIds.length || evidence.intents.length) return false;
  if (evidence.missing.some((row) => row.detailCode)) return false;
  return evidence.issues.every((issue) => issue.kind === 'malformed_progress');
}

function readExpectedSources(listFile) {
  privateRegular(listFile, 'transaction source list');
  return readFileSync(listFile, 'utf8').split('\n').filter(Boolean).map((path) => {
    if (!isAbsolute(path) || /[\r\n\0]/.test(path)) throw new Error('transaction source list contains an unsafe path');
    const id = basename(path, '.jsonl');
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new Error('transaction source list contains an unsafe identifier');
    return { id, path };
  });
}

function readTransactionBase(runDirectory) {
  const ownerPath = join(runDirectory, 'transaction-owner.json');
  privateRegular(ownerPath, 'transaction ownership receipt');
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  if (!owner || owner.schemaVersion !== 1 || !/^[a-f0-9]{40,64}$/i.test(owner.vaultHead)) {
    throw new Error('transaction ownership receipt lacks a valid vault head');
  }
  return owner.vaultHead;
}

function rollbackRecoveryHasStarted(specPath) {
  privateRegular(specPath, 'transaction rollback specification');
  let spec;
  try { spec = JSON.parse(readFileSync(specPath, 'utf8')); }
  catch { throw new Error('transaction rollback specification is malformed'); }
  if (!spec || Array.isArray(spec) || typeof spec !== 'object'
      || typeof spec.quarantineRoot !== 'string' || !isAbsolute(spec.quarantineRoot)
      || !Array.isArray(spec.rows) || !spec.rows.length) {
    throw new Error('transaction rollback specification is invalid');
  }
  let started = false;
  for (const row of spec.rows) {
    if (!row || typeof row.recordPath !== 'string' || !isAbsolute(row.recordPath)
        || typeof row.recordRelative !== 'string'
        || !/^project-memory\/[^/]+\/sessions\/[^/]+\.md$/.test(row.recordRelative)) {
      throw new Error('transaction rollback specification contains an invalid record');
    }
    const destination = join(spec.quarantineRoot, row.recordRelative);
    if (!contained(resolve(destination), resolve(spec.quarantineRoot))) {
      throw new Error('transaction rollback recovery path escaped quarantine');
    }
    const sourceExists = existsSync(row.recordPath);
    const destinationExists = existsSync(destination);
    if (sourceExists && destinationExists) {
      throw new Error(`rollback found both source and recovery copies for ${row.transcriptId}`);
    }
    if (destinationExists || !sourceExists) started = true;
  }
  return started;
}

function transactionOwnerIsActive(runDirectory) {
  const ownerPath = join(runDirectory, 'transaction-owner.json');
  if (!existsSync(ownerPath)) return false;
  privateRegular(ownerPath, 'transaction ownership receipt');
  let owner;
  try { owner = JSON.parse(readFileSync(ownerPath, 'utf8')); }
  catch { throw new Error('transaction ownership receipt is malformed'); }
  const keys = ['createdAt', 'ownerPid', 'schemaVersion', 'sources', 'vaultHead'];
  if (!owner || Array.isArray(owner) || typeof owner !== 'object'
      || Object.keys(owner).sort().join(',') !== keys.join(',')
      || owner.schemaVersion !== 1
      || typeof owner.createdAt !== 'string'
      || new Date(owner.createdAt).toISOString() !== owner.createdAt
      || !Number.isSafeInteger(owner.ownerPid) || owner.ownerPid <= 0
      || !Array.isArray(owner.sources)
      || !owner.sources.every((row) => row && !Array.isArray(row) && typeof row === 'object'
        && Object.keys(row).sort().join(',') === 'sourcePath,transcriptId'
        && typeof row.transcriptId === 'string' && row.transcriptId
        && typeof row.sourcePath === 'string' && isAbsolute(row.sourcePath)
        && !/[\r\n\0]/.test(row.sourcePath))
      || (owner.vaultHead !== null && !/^[a-f0-9]{40,64}$/i.test(owner.vaultHead))) {
    throw new Error('transaction ownership receipt is invalid');
  }
  try {
    process.kill(owner.ownerPid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

export function resumePendingFinalizations({
  logDir,
  vault,
  lib,
  drainer,
  dispositions,
  ledgerPath,
  timeoutMs,
  wrapper = fileURLToPath(import.meta.url),
  scanner,
  quiescenceMinutes,
}) {
  if (!existsSync(logDir)) return [];
  const resumed = [];
  for (const entry of readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('run-')) continue;
    const runDirectory = join(logDir, entry.name);
    const resolution = join(runDirectory, 'transaction-resolution.json');
    const incomplete = join(runDirectory, 'incomplete-progress.json');
    if (existsSync(resolution)
        && (!existsSync(incomplete) || validateIncompleteRetirement(runDirectory))) {
      privateRegular(resolution, 'transaction resolution');
      let prior;
      try { prior = JSON.parse(readFileSync(resolution, 'utf8')); }
      catch { throw new Error('transaction resolution is malformed'); }
      writeTransactionResolution(runDirectory, {
        status: prior.status,
        commit: prior.commit,
        records: prior.records,
      });
      continue;
    }
    if (transactionOwnerIsActive(runDirectory)) {
      resumed.push({ runDirectory, commit: null, status: 'owner_active', finalized: 0 });
      continue;
    }
    const transactionProgressPath = join(runDirectory, 'transaction-progress.jsonl');
    let progress = existsSync(transactionProgressPath)
      ? transactionProgressPath
      : join(runDirectory, 'progress.jsonl');
    const commitOid = join(runDirectory, 'commit-oid.txt');
    const rollbackSpec = join(runDirectory, 'rollback-spec.json');
    const placementJournal = join(runDirectory, 'placement-journal.jsonl');
    const recoveryManifest = join(runDirectory, 'rollback', 'recovery-manifest.jsonl');
    const rollbackStarted = existsSync(rollbackSpec)
      && (existsSync(recoveryManifest) || rollbackRecoveryHasStarted(rollbackSpec));
    if (!existsSync(commitOid) && rollbackStarted) {
      privateRegular(progress, 'pending progress ledger');
      privateRegular(dispositions, 'disposition ledger');
      const rows = parseProgress(readFileSync(progress, 'utf8'), null);
      const mined = rows.filter((row) => row.status === 'mined');
      if (!mined.length) throw new Error(`pending transaction ${entry.name} has no mined rows`);
      rollbackUnderVaultLock({
        vault, lib, wrapper, rollbackSpec, drainer, progress, recoveryManifest,
        dispositions, expected: mined.length, timeoutMs,
      });
      verifyRolledBackTransaction(rollbackSpec, recoveryManifest, dispositions, ledgerPath, mined);
      writeTransactionResolution(runDirectory, { status: 'rolled_back', records: mined.length });
      retireIncompleteReceipt(runDirectory);
      resumed.push({ runDirectory, commit: null, status: 'rolled_back', finalized: 0 });
      continue;
    }
    let reconciliationSafe = false;
    if (existsSync(placementJournal)) {
      privateRegular(placementJournal, 'placement journal');
      let recovery = {
        recovered: 0, released: 0, active: 0, missing: 0, unproven: 0, status: 'reconciled',
      };
      if (lstatSync(placementJournal).size > 0) {
        recovery = recoverPlacementJournalUnderVaultLock({
          vault,
          lib,
          drainer,
          placementJournal,
          dispositions,
          timeoutMs,
        });
      }
      if (existsSync(dispositions)) privateRegular(dispositions, 'disposition ledger');
      else if (recovery.recovered || recovery.released) {
        throw new Error('placement journal recovery reported a durable disposition without a ledger');
      }
      const originalProgress = join(runDirectory, 'progress.jsonl');
      privateRegular(originalProgress, 'pending progress ledger');
      const expected = readExpectedSources(join(runDirectory, 'sources.txt'));
      const journalRaw = readFileSync(placementJournal, 'utf8');
      const journalPreview = parsePlacementJournalEvidence(journalRaw);
      const supplementalRows = selectReleasedClaimRows(dispositions, journalPreview.claimIntents);
      const evidence = reconcileRunEvidence({
        progressRaw: readFileSync(originalProgress, 'utf8'),
        journalRaw,
        expected,
        supplementalRows,
      });
      reconciliationSafe = evidenceCanRetireTransaction(evidence, recovery);
      if ((evidence.missing.length || evidence.issues.length) && !existsSync(incomplete)) {
        writePrivateAtomicIfAbsent(incomplete, `${JSON.stringify({
          schemaVersion: 1,
          observedAt: new Date().toISOString(),
          childFailure: 'startup-recovery',
          missing: evidence.missing,
          issues: evidence.issues,
          journalActive: recovery.active,
          journalMissing: recovery.missing,
          journalUnproven: recovery.unproven,
        })}\n`, 'incomplete progress receipt');
      }
      const minedEvidence = evidence.rows.filter((row) => row.status === 'mined');
      if (minedEvidence.length && !existsSync(rollbackSpec)) {
        materializeTransaction({
          runDirectory,
          vault,
          mined: minedEvidence,
          beforeHead: readTransactionBase(runDirectory),
        });
      }
      if (!minedEvidence.length && !existsSync(commitOid) && !existsSync(rollbackSpec)) {
        if (!reconciliationSafe) {
          resumed.push({ runDirectory, commit: null, status: 'evidence_unresolved', finalized: 0 });
          continue;
        }
        writeTransactionResolution(runDirectory, { status: 'no_placements', records: 0 });
        retireIncompleteReceipt(runDirectory);
        continue;
      }
      progress = existsSync(transactionProgressPath) ? transactionProgressPath : progress;
    }
    if (!existsSync(commitOid) && !existsSync(rollbackSpec)) continue;
    privateRegular(progress, 'pending progress ledger');
    privateRegular(dispositions, 'disposition ledger');
    const rows = parseProgress(readFileSync(progress, 'utf8'), null);
    const mined = rows.filter((row) => row.status === 'mined');
    if (!mined.length) throw new Error(`pending transaction ${entry.name} has no mined rows`);
    let commit;
    if (existsSync(commitOid)) {
      privateRegular(commitOid, 'pending commit receipt');
      commit = readFileSync(commitOid, 'utf8').trim();
    } else {
      privateRegular(rollbackSpec, 'pending transaction specification');
      const transaction = JSON.parse(readFileSync(rollbackSpec, 'utf8'));
      if (!transaction || transaction.schemaVersion !== 1 || typeof transaction.beforeHead !== 'string'
          || !Array.isArray(transaction.rows) || transaction.rows.length !== mined.length) {
        throw new Error(`pending transaction ${entry.name} has an invalid recovery specification`);
      }
      const head = run('git', ['rev-parse', 'HEAD'], { cwd: vault }).stdout.trim();
      if (head === transaction.beforeHead) {
        if (!scanner || !quiescenceMinutes) {
          throw new Error(`pending transaction ${entry.name} requires pre-commit recovery inputs`);
        }
        const messageFile = join(runDirectory, 'commit-message.txt');
        privateRegular(messageFile, 'pending commit message');
        const paths = transaction.rows.map((row) => row.recordRelative);
        const committed = commitExact({
          vault, lib, paths, messageFile, timeoutMs, wrapper, rollbackSpec,
          recoveryManifest, drainer, progress, dispositions, commitOid,
          scanner, quiescenceMinutes,
        });
        if (committed.code !== 0) {
          throw new Error(`pending exact-path vault commit failed: ${committed.failureReason ?? `exit_${committed.code}`}`);
        }
        privateRegular(commitOid, 'pending commit receipt');
        commit = readFileSync(commitOid, 'utf8').trim();
      } else {
        commit = derivePendingCommit(vault, transaction.beforeHead, mined);
        writeFileSync(commitOid, `${commit}\n`, { flag: 'wx', mode: 0o600 });
        chmodSync(commitOid, 0o600);
      }
    }
    verifyCommittedTransaction(vault, mined, commit);

    finalizeUnderVaultLock({
      vault, lib, drainer, progress, dispositions, commit,
      expected: mined.length,
      timeoutMs,
    });
    verifyCapturedDispositions(dispositions, mined, commit);
    writeTransactionResolution(runDirectory, { status: 'captured', commit, records: mined.length });
    if (reconciliationSafe) retireIncompleteReceipt(runDirectory);
    resumed.push({ runDirectory, commit, status: 'captured', finalized: mined.length });
  }
  return resumed;
}

export function validateMinedRows(rows, vault, execute = run) {
  const inputRoot = resolve(vault);
  const root = realpathSync(vault);
  const mined = rows.filter((row) => row.status === 'mined');
  const paths = [];
  const absolutePaths = [];
  for (const row of mined) {
    if (typeof row.recordPath !== 'string' || !isAbsolute(row.recordPath)) {
      throw new Error(`invalid record path for ${row.transcriptId}`);
    }
    const requestedPath = resolve(row.recordPath);
    if (!contained(requestedPath, inputRoot)) throw new Error(`record escaped vault for ${row.transcriptId}`);
    const recordRelative = relative(inputRoot, requestedPath);
    if (!/^project-memory\/[^/]+\/sessions\/[^/]+\.md$/.test(recordRelative)) {
      throw new Error(`invalid record path for ${row.transcriptId}`);
    }
    const path = realpathSync(requestedPath);
    if (relative(root, path) !== recordRelative) {
      throw new Error(`record path contains a symlink for ${row.transcriptId}`);
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) {
      throw new Error(`record is not an exact private regular file for ${row.transcriptId}`);
    }
    if (sha256(path) !== row.recordSha256) throw new Error(`record hash mismatch for ${row.transcriptId}`);
    const tracked = execute('git', ['cat-file', '-e', `HEAD:${recordRelative}`], { cwd: root });
    if (tracked.code === 0) throw new Error(`record path already exists in HEAD for ${row.transcriptId}`);
    if (![1, 128].includes(tracked.code)) throw new Error(`record history check failed for ${row.transcriptId}`);
    const untracked = execute('git', ['ls-files', '--others', '--exclude-standard', '--', recordRelative], { cwd: root });
    if (untracked.code !== 0 || untracked.stdout.trim() !== recordRelative) {
      throw new Error(`record is not an exact untracked path for ${row.transcriptId}`);
    }
    paths.push(recordRelative);
    absolutePaths.push(path);
  }
  if (new Set(paths).size !== paths.length) throw new Error('duplicate record path in progress');
  return { mined, paths, absolutePaths };
}

function materializeTransaction({ runDirectory, vault, mined, beforeHead }) {
  if (!/^[a-f0-9]{40,64}$/i.test(beforeHead)) throw new Error('transaction base is not a full object id');
  const { paths, absolutePaths } = validateMinedRows(mined, vault);
  if (!paths.length) throw new Error('cannot materialize a transaction without mined records');
  const rollbackDirectory = join(runDirectory, 'rollback');
  mkdirSync(rollbackDirectory, { recursive: true, mode: 0o700 });
  chmodSync(rollbackDirectory, 0o700);
  const transactionProgress = join(runDirectory, 'transaction-progress.jsonl');
  const messageFile = join(runDirectory, 'commit-message.txt');
  const rollbackSpec = join(runDirectory, 'rollback-spec.json');
  const recoveryManifest = join(rollbackDirectory, 'recovery-manifest.jsonl');
  const commitOid = join(runDirectory, 'commit-oid.txt');
  writePrivateAtomicIfAbsent(
    transactionProgress,
    `${mined.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'transaction progress ledger',
  );
  writePrivateAtomicIfAbsent(
    messageFile,
    `vault: drain ${paths.length} abandoned transcript(s)\n\n`
      + `Scheduled bounded drain ${basename(runDirectory)}. Records are append only. Raw transcripts were retained.\n`,
    'transaction commit message',
  );
  writePrivateAtomicIfAbsent(
    rollbackSpec,
    `${JSON.stringify({
      schemaVersion: 1,
      beforeHead,
      quarantineRoot: join(rollbackDirectory, 'records'),
      rows: mined.map((row, index) => ({
        transcriptId: row.transcriptId,
        sourcePath: row.sourcePath,
        sourceSha256: row.sourceSha256,
        recordPath: row.recordPath,
        recordRelative: paths[index],
        recordSha256: row.recordSha256,
      })),
    })}\n`,
    'transaction rollback specification',
  );
  return {
    mined,
    paths,
    absolutePaths,
    messageFile,
    rollbackSpec,
    recoveryManifest,
    commitOid,
    transactionProgress,
  };
}

function readLegacyTransactionSpec(specPath, vault, expectedRunId, expectedToken) {
  let spec;
  try { spec = JSON.parse(readPrivateStableText(specPath, 'legacy transaction specification')); }
  catch { throw new Error('legacy transaction specification is malformed'); }
  const keys = [
    'beforeHead', 'event', 'legacyTransactionVersion', 'quarantineRoot',
    'messagePath', 'messageSha256', 'rows', 'runId', 'token',
  ];
  if (!exactObjectKeys(spec, keys) || spec.legacyTransactionVersion !== 1
      || spec.event !== 'legacy_transaction' || spec.runId !== expectedRunId
      || spec.token !== expectedToken || !/^[a-f0-9]{40,64}$/.test(spec.beforeHead)
      || !/^[a-f0-9]{64}$/.test(spec.messageSha256)
      || !Array.isArray(spec.rows) || !spec.rows.length
      || typeof spec.quarantineRoot !== 'string' || !isAbsolute(spec.quarantineRoot)) {
    throw new Error('legacy transaction specification is invalid');
  }
  const runDirectory = dirname(specPath);
  const expectedMessagePath = join(runDirectory, 'legacy-commit-message.txt');
  const expectedMessage = legacyCommitMessage(runDirectory, spec.rows.length);
  if (spec.messagePath !== expectedMessagePath
      || hashPrivateStable(spec.messagePath, 'legacy transaction commit message') !== spec.messageSha256
      || readPrivateStableText(spec.messagePath, 'legacy transaction commit message') !== expectedMessage
      || spec.messageSha256 !== createHash('sha256').update(expectedMessage).digest('hex')) {
    throw new Error('legacy transaction commit message proof is invalid');
  }
  if (!contained(resolve(spec.quarantineRoot), resolve(runDirectory))) {
    throw new Error('legacy transaction quarantine escaped its run');
  }
  const vaultRoot = resolve(vault);
  const seen = new Set();
  for (const item of spec.rows) {
    if (!exactObjectKeys(item, ['progress', 'recordRelative'])
        || typeof item.recordRelative !== 'string'
        || !/^project-memory\/[^/]+\/sessions\/[^/]+\.md$/.test(item.recordRelative)) {
      throw new Error('legacy transaction record is invalid');
    }
    const [row] = parseProgress(
      `${JSON.stringify(item.progress)}\n`, null, LEGACY_PROGRESS_STATUSES,
    );
    if (row.status !== 'mined' || row.runId !== expectedRunId
        || relative(vaultRoot, resolve(row.recordPath)) !== item.recordRelative
        || seen.has(item.recordRelative)) {
      throw new Error('legacy transaction record proof is invalid');
    }
    seen.add(item.recordRelative);
  }
  return spec;
}

function legacyCommitMessage(runDirectory, count) {
  return `vault: adopt ${count} legacy transcript record(s)\n\n`
    + `Explicit legacy adoption ${basename(runDirectory)}. Raw transcripts and legacy claims were retained.\n`;
}

export function readLegacyTransactionCommitMessage(specPath, vault, runId, token) {
  const spec = readLegacyTransactionSpec(specPath, vault, runId, token);
  const message = readPrivateStableText(spec.messagePath, 'legacy transaction commit message');
  if (createHash('sha256').update(message).digest('hex') !== spec.messageSha256
      || message !== legacyCommitMessage(dirname(specPath), spec.rows.length)) {
    throw new Error('legacy transaction commit message proof is invalid');
  }
  return message;
}

export function materializeLegacyTransaction({
  runDirectory, vault, mined, beforeHead, runId, token,
}) {
  if (!UUID_PATTERN.test(runId) || !/^[a-f0-9]{64}$/.test(token)
      || !/^[a-f0-9]{40,64}$/.test(beforeHead)) {
    throw new Error('invalid legacy transaction binding');
  }
  const specPath = join(runDirectory, 'legacy-transaction.json');
  const messageFile = join(runDirectory, 'legacy-commit-message.txt');
  const commitOid = join(runDirectory, 'legacy-commit-oid.txt');
  const verifyReceipt = join(runDirectory, 'legacy-verify-receipt.json');
  const finalizeReceipt = join(runDirectory, 'legacy-finalize-receipt.json');
  const abortReceipt = join(runDirectory, 'legacy-abort-receipt.json');
  const recoveryManifest = join(runDirectory, 'legacy-abort-manifest.json');
  const resolution = join(runDirectory, 'legacy-resolution.json');
  const quarantineRoot = join(runDirectory, 'legacy-quarantine');
  if (existsSync(specPath)) {
    const spec = readLegacyTransactionSpec(specPath, vault, runId, token);
    if (spec.beforeHead !== beforeHead || spec.rows.length !== mined.length
        || spec.rows.some((item, index) => !isDeepStrictEqual(item.progress, mined[index]))) {
      throw new Error('legacy transaction specification conflicts with evidence');
    }
    return {
      specPath,
      paths: spec.rows.map((item) => item.recordRelative),
      absolutePaths: spec.rows.map((item) => item.progress.recordPath),
      messageFile,
      commitOid,
      verifyReceipt,
      finalizeReceipt,
      abortReceipt,
      recoveryManifest,
      resolution,
      quarantineRoot,
    };
  }
  const { paths, absolutePaths } = validateMinedRows(mined, vault);
  if (!paths.length || mined.some((row) => row.runId !== runId)) {
    throw new Error('cannot materialize legacy transaction without exact mined evidence');
  }
  const messageBody = legacyCommitMessage(runDirectory, paths.length);
  writeLegacyPrivateAtomicIfAbsent(messageFile, messageBody, 'legacy transaction commit message');
  writeLegacyPrivateAtomicIfAbsent(specPath, `${JSON.stringify({
    legacyTransactionVersion: 1,
    event: 'legacy_transaction',
    runId,
    token,
    beforeHead,
    quarantineRoot,
    messagePath: messageFile,
    messageSha256: createHash('sha256').update(messageBody).digest('hex'),
    rows: mined.map((row, index) => ({ progress: row, recordRelative: paths[index] })),
  })}\n`, 'legacy transaction specification');
  readLegacyTransactionSpec(specPath, vault, runId, token);
  return {
    specPath,
    paths,
    absolutePaths,
    messageFile,
    commitOid,
    verifyReceipt,
    finalizeReceipt,
    abortReceipt,
    recoveryManifest,
    resolution,
    quarantineRoot,
  };
}

export function quarantineLegacyRecords({
  specPath,
  manifestPath,
  progressPath,
  placementJournalPath,
  vault,
  runId,
  token,
  execute = run,
}) {
  const progressBody = readPrivateStable(progressPath, 'legacy progress ledger');
  const placementBody = readPrivateStable(placementJournalPath, 'legacy placement journal');
  const spec = readLegacyTransactionSpec(specPath, vault, runId, token);
  ensureOrCreatePrivateDirectory(spec.quarantineRoot, 'legacy quarantine');
  const root = realpathSync(vault);
  const entries = [];
  for (const [index, item] of spec.rows.entries()) {
    const row = item.progress;
    const tracked = execute('git', ['cat-file', '-e', `HEAD:${item.recordRelative}`], { cwd: root });
    if (tracked.code === 0) throw new Error('legacy quarantine refused a now-tracked record');
    if (![1, 128].includes(tracked.code)) throw new Error('legacy quarantine history check failed');
    const untracked = execute('git', ['ls-files', '--others', '--exclude-standard', '--', item.recordRelative], { cwd: root });
    if (untracked.code !== 0 || untracked.stdout.trim() !== item.recordRelative) {
      throw new Error('legacy quarantine record ownership changed');
    }
    const cleared = execute('git', ['update-index', '--force-remove', item.recordRelative], { cwd: vault });
    if (cleared.code !== 0) throw new Error('legacy quarantine could not clear an exact index path');
    const recoveryPath = join(spec.quarantineRoot, `${String(index).padStart(3, '0')}-${row.recordSha256}.md`);
    if (!contained(resolve(recoveryPath), resolve(spec.quarantineRoot))) {
      throw new Error('legacy quarantine recovery path escaped its run');
    }
    const sourceExists = existsSync(row.recordPath);
    const recoveryExists = existsSync(recoveryPath);
    if (sourceExists && recoveryExists) throw new Error('legacy quarantine found duplicate record copies');
    if (sourceExists) {
      const stat = privateRegular(row.recordPath, 'legacy record');
      if (!stat.isFile()
          || relative(realpathSync(vault), realpathSync(row.recordPath)) !== item.recordRelative
          || hashPrivateStable(row.recordPath, 'legacy record') !== row.recordSha256) {
        throw new Error('legacy quarantine record proof changed');
      }
      renameSync(row.recordPath, recoveryPath);
      chmodSync(recoveryPath, 0o600);
      fsyncDirectory(dirname(row.recordPath));
      fsyncDirectory(spec.quarantineRoot);
    } else if (!recoveryExists) {
      throw new Error('legacy quarantine lost its exact record');
    }
    if (hashPrivateStable(recoveryPath, 'legacy quarantined record') !== row.recordSha256) {
      throw new Error('legacy quarantine recovery hash mismatch');
    }
    entries.push({
      transcriptIdSha256: createHash('sha256').update(row.transcriptId).digest('hex'),
      recordPathSha256: createHash('sha256').update(row.recordPath).digest('hex'),
      recordSha256: row.recordSha256,
      recoveryPath,
      recoverySha256: row.recordSha256,
    });
  }
  writeLegacyPrivateAtomicIfAbsent(manifestPath, `${JSON.stringify({
    version: 1,
    runId,
    token,
    progressSha256: createHash('sha256').update(progressBody).digest('hex'),
    placementJournalSha256: createHash('sha256').update(placementBody).digest('hex'),
    entries,
  })}\n`, 'legacy abort manifest');
  return manifestPath;
}

export function persistLegacyCommitReceipt(path, raw) {
  if (typeof raw !== 'string' || !/^[a-f0-9]{40,64}\n$/.test(raw)) {
    throw new Error('invalid legacy commit receipt');
  }
  writeLegacyPrivateAtomicIfAbsent(path, raw, 'legacy commit receipt');
  return raw.trim();
}

export function verifyLegacyTransactionSpec(
  specPath,
  vault,
  scanner,
  quiescenceMinutes,
  runId,
  token,
  execute = run,
) {
  const spec = readLegacyTransactionSpec(specPath, vault, runId, token);
  const root = realpathSync(vault);
  const head = execute('git', ['rev-parse', 'HEAD'], { cwd: root });
  if (head.code !== 0 || head.stdout.trim() !== spec.beforeHead) {
    throw new Error('legacy transaction vault base changed before commit');
  }
  const cutoff = Date.now() - quiescenceMinutes * 60_000;
  const recordPaths = [];
  for (const item of spec.rows) {
    const row = item.progress;
    if (!isAbsolute(row.sourcePath) || hasControlCharacter(row.sourcePath)) {
      throw new Error('legacy source proof is unsafe');
    }
    const sourceStat = lstatSync(row.sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.mtimeMs > cutoff) {
      throw new Error('legacy source is no longer quiet');
    }
    const open = execute('/usr/sbin/lsof', ['-t', row.sourcePath], { timeoutMs: 30_000 });
    if (open.code === 0) throw new Error('legacy source is open');
    if (open.code !== 1) throw new Error('legacy source ownership check failed');
    if (hashPrivateStable(row.sourcePath, 'legacy source') !== row.sourceSha256) {
      throw new Error('legacy source hash changed');
    }
    const recordPath = realpathSync(row.recordPath);
    if (relative(root, recordPath) !== item.recordRelative) {
      throw new Error('legacy record path proof changed');
    }
    if (hashPrivateStable(recordPath, 'legacy record') !== row.recordSha256) {
      throw new Error('legacy record hash changed');
    }
    const tracked = execute('git', ['cat-file', '-e', `HEAD:${item.recordRelative}`], { cwd: root });
    if (tracked.code === 0) throw new Error('legacy record is already tracked');
    if (![1, 128].includes(tracked.code)) throw new Error('legacy record history check failed');
    const untracked = execute('git', ['ls-files', '--others', '--exclude-standard', '--', item.recordRelative], { cwd: root });
    if (untracked.code !== 0 || untracked.stdout.trim() !== item.recordRelative) {
      throw new Error('legacy record is not an exact untracked path');
    }
    recordPaths.push(recordPath);
  }
  scanExactRecords({ scanner, paths: recordPaths, execute });
  return spec.rows.length;
}

export function verifyLegacyStagedTransaction(
  specPath,
  vault,
  scanner,
  runId,
  token,
  execute = run,
) {
  const spec = readLegacyTransactionSpec(specPath, vault, runId, token);
  const expectedPaths = spec.rows.map((item) => item.recordRelative).sort();
  const stagedPaths = execute('git', [
    'diff', '--cached', '--name-only', '--no-renames', '-z', spec.beforeHead,
  ], { cwd: realpathSync(vault) });
  const actualPaths = stagedPaths.stdout.split('\0').filter(Boolean).sort();
  if (stagedPaths.code !== 0 || !isDeepStrictEqual(actualPaths, expectedPaths)) {
    throw new Error('legacy staged transaction paths are not exact');
  }
  return verifyStagedRecordBlobs({
    vault,
    scanner,
    temporaryRoot: dirname(specPath),
    records: spec.rows.map((item) => ({
      recordRelative: item.recordRelative,
      recordSha256: item.progress.recordSha256,
    })),
    execute,
  });
}

export function prepareLegacyCommitTree(specPath, vault, scanner, runId, token, execute = run) {
  const spec = readLegacyTransactionSpec(specPath, vault, runId, token);
  verifyLegacyStagedTransaction(specPath, vault, scanner, runId, token, execute);
  readLegacyTransactionCommitMessage(specPath, vault, runId, token);
  const tree = execute('git', ['write-tree'], { cwd: realpathSync(vault) });
  const treeOid = tree.stdout.trim();
  if (tree.code !== 0 || !/^[a-f0-9]{40,64}$/.test(treeOid)) {
    throw new Error('legacy staged transaction tree is invalid');
  }
  const changed = execute('git', [
    'diff', '--name-only', '--no-renames', '-z', spec.beforeHead, treeOid,
  ], { cwd: realpathSync(vault) });
  const actualPaths = changed.stdout.split('\0').filter(Boolean).sort();
  const expectedPaths = spec.rows.map((item) => item.recordRelative).sort();
  if (changed.code !== 0 || !isDeepStrictEqual(actualPaths, expectedPaths)) {
    throw new Error('legacy commit tree paths are not exact');
  }
  return treeOid;
}

function commitLegacyExact({
  marker,
  transaction,
  lib,
  scanner,
  timeoutMs,
  wrapper,
}) {
  const script = [
    'set -u',
    'set -o pipefail',
    'source "$1"',
    'vault="$2"',
    'wrapper="$3"',
    'drainer="$4"',
    'progress="$5"',
    'placement="$6"',
    'dispositions="$7"',
    'state_root="$8"',
    'run_id="$9"',
    'token="${10}"',
    'spec="${11}"',
    'scanner="${12}"',
    'quiescence="${13}"',
    'expected="${14}"',
    'verify_receipt="${15}"',
    'commit_oid="${16}"',
    'message_file="${17}"',
    'base="${18}"',
    'shift 18',
    'lk="$(wrap_lock "vault-$vault" 60)" || exit 70',
    'index="$(mktemp "$vault/.legacy-adoption-index.XXXXXX")" || exit 72',
    'rm -f "$index" || exit 72',
    'cleanup() { code=$?; rm -f "$index"; wrap_unlock "$lk" >/dev/null 2>&1 || true; trap - EXIT; exit "$code"; }',
    'trap cleanup EXIT HUP INT TERM',
    'export GIT_INDEX_FILE="$index"',
    'node "$drainer" --verify-legacy-progress "$progress" --placement-journal "$placement" --dispositions "$dispositions" --legacy-state-root "$state_root" --legacy-run-id "$run_id" --legacy-token "$token" | node --input-type=module -e \'const fs=await import("node:fs"); const m=await import(process.argv[2]); m.persistLegacyPhaseReceipt(process.argv[3], fs.readFileSync(0,"utf8"), "verify", Number(process.argv[4]));\' stack-legacy "$wrapper" "$verify_receipt" "$expected" || exit 71',
    'node --input-type=module -e \'const m=await import(process.argv[2]); m.verifyLegacyTransactionSpec(process.argv[3],process.argv[4],process.argv[5],Number(process.argv[6]),process.argv[7],process.argv[8]);\' stack-legacy "$wrapper" "$spec" "$vault" "$scanner" "$quiescence" "$run_id" "$token" || exit 71',
    'git -C "$vault" read-tree HEAD || exit 72',
    'git -C "$vault" add -- "$@" || exit 72',
    'node --input-type=module -e \'const m=await import(process.argv[2]); m.verifyLegacyStagedTransaction(process.argv[3],process.argv[4],process.argv[5],process.argv[6],process.argv[7]);\' stack-legacy "$wrapper" "$spec" "$vault" "$scanner" "$run_id" "$token" || exit 72',
    'GIT_EDITOR=: GIT_SEQUENCE_EDITOR=: GIT_TERMINAL_PROMPT=0 git -C "$vault" hook run --ignore-missing pre-commit || exit 72',
    'GIT_EDITOR=: GIT_SEQUENCE_EDITOR=: GIT_TERMINAL_PROMPT=0 git -C "$vault" hook run --ignore-missing prepare-commit-msg -- "$message_file" message || exit 72',
    'GIT_EDITOR=: GIT_SEQUENCE_EDITOR=: GIT_TERMINAL_PROMPT=0 git -C "$vault" hook run --ignore-missing commit-msg -- "$message_file" || exit 72',
    'tree="$(node --input-type=module -e \'const m=await import(process.argv[2]); process.stdout.write(m.prepareLegacyCommitTree(process.argv[3],process.argv[4],process.argv[5],process.argv[6],process.argv[7]));\' stack-legacy "$wrapper" "$spec" "$vault" "$scanner" "$run_id" "$token")" || exit 72',
    'oid="$(node --input-type=module -e \'const m=await import(process.argv[2]); process.stdout.write(m.readLegacyTransactionCommitMessage(process.argv[3],process.argv[4],process.argv[5],process.argv[6]));\' stack-legacy "$wrapper" "$spec" "$vault" "$run_id" "$token" | git -C "$vault" commit-tree "$tree" -p "$base")" || exit 72',
    'git -C "$vault" update-ref HEAD "$oid" "$base" || exit 73',
    'unset GIT_INDEX_FILE',
    'git -C "$vault" reset --quiet HEAD -- "$@" || exit 73',
    'printf "%s\\n" "$oid" | node --input-type=module -e \'const fs=await import("node:fs"); const m=await import(process.argv[2]); m.persistLegacyCommitReceipt(process.argv[3], fs.readFileSync(0,"utf8"));\' stack-legacy "$wrapper" "$commit_oid" || exit 73',
  ].join('\n');
  return run('/bin/bash', [
    '-c', script, '_', lib, marker.vaultPath, wrapper, marker.drainerPath,
    marker.progressPath, marker.placementJournalPath, marker.dispositionsPath,
    marker.stateRoot, marker.runId, marker.token, transaction.specPath, scanner,
    String(marker.tuning.quiescenceMinutes), String(transaction.paths.length),
    transaction.verifyReceipt, transaction.commitOid, transaction.messageFile, marker.vaultHead,
    ...transaction.paths,
  ], { timeoutMs, maxBuffer: 1024 * 1024 });
}

function finalizeLegacyUnderVaultLock({ marker, transaction, commit, lib, timeoutMs, wrapper }) {
  const script = [
    'set -u',
    'set -o pipefail',
    'source "$1"',
    'vault="$2"',
    'wrapper="$3"',
    'drainer="$4"',
    'progress="$5"',
    'placement="$6"',
    'commit="$7"',
    'dispositions="$8"',
    'state_root="$9"',
    'run_id="${10}"',
    'token="${11}"',
    'receipt="${12}"',
    'expected="${13}"',
    'lk="$(wrap_lock "vault-$vault" 60)" || exit 70',
    'trap \'wrap_unlock "$lk" >/dev/null 2>&1 || true\' EXIT HUP INT TERM',
    'node "$drainer" --finalize-legacy-progress "$progress" --placement-journal "$placement" --commit "$commit" --dispositions "$dispositions" --legacy-state-root "$state_root" --legacy-run-id "$run_id" --legacy-token "$token" | node --input-type=module -e \'const fs=await import("node:fs"); const m=await import(process.argv[2]); m.persistLegacyPhaseReceipt(process.argv[3], fs.readFileSync(0,"utf8"), "finalize", Number(process.argv[4]));\' stack-legacy "$wrapper" "$receipt" "$expected"',
  ].join('\n');
  return run('/bin/bash', [
    '-c', script, '_', lib, marker.vaultPath, wrapper, marker.drainerPath,
    marker.progressPath, marker.placementJournalPath, commit, marker.dispositionsPath,
    marker.stateRoot, marker.runId, marker.token, transaction.finalizeReceipt,
    String(transaction.paths.length),
  ], { timeoutMs, maxBuffer: 64 * 1024 });
}

function abortLegacyUnderVaultLock({ marker, transaction, lib, timeoutMs, wrapper }) {
  const script = [
    'set -u',
    'set -o pipefail',
    'source "$1"',
    'vault="$2"',
    'wrapper="$3"',
    'spec="$4"',
    'manifest="$5"',
    'progress="$6"',
    'placement="$7"',
    'run_id="$8"',
    'token="$9"',
    'drainer="${10}"',
    'dispositions="${11}"',
    'state_root="${12}"',
    'receipt="${13}"',
    'expected="${14}"',
    'lk="$(wrap_lock "vault-$vault" 60)" || exit 70',
    'trap \'wrap_unlock "$lk" >/dev/null 2>&1 || true\' EXIT HUP INT TERM',
    'node --input-type=module -e \'const m=await import(process.argv[2]); m.quarantineLegacyRecords({specPath:process.argv[3],manifestPath:process.argv[4],progressPath:process.argv[5],placementJournalPath:process.argv[6],vault:process.argv[7],runId:process.argv[8],token:process.argv[9]});\' stack-legacy "$wrapper" "$spec" "$manifest" "$progress" "$placement" "$vault" "$run_id" "$token" || exit 71',
    'node "$drainer" --abort-legacy-progress "$progress" --placement-journal "$placement" --recovery-manifest "$manifest" --dispositions "$dispositions" --legacy-state-root "$state_root" --legacy-run-id "$run_id" --legacy-token "$token" | node --input-type=module -e \'const fs=await import("node:fs"); const m=await import(process.argv[2]); m.persistLegacyPhaseReceipt(process.argv[3], fs.readFileSync(0,"utf8"), "abort", Number(process.argv[4]));\' stack-legacy "$wrapper" "$receipt" "$expected"',
  ].join('\n');
  return run('/bin/bash', [
    '-c', script, '_', lib, marker.vaultPath, wrapper, transaction.specPath,
    transaction.recoveryManifest, marker.progressPath, marker.placementJournalPath,
    marker.runId, marker.token, marker.drainerPath, marker.dispositionsPath,
    marker.stateRoot, transaction.abortReceipt, String(transaction.paths.length),
  ], { timeoutMs, maxBuffer: 64 * 1024 });
}

function commitExact({
  vault,
  lib,
  paths,
  messageFile,
  timeoutMs,
  wrapper,
  rollbackSpec,
  recoveryManifest,
  drainer,
  progress,
  dispositions,
  commitOid,
  scanner,
  quiescenceMinutes,
}) {
  const script = [
    'set -u',
    'source "$1"',
    'vault="$2"',
    'msg="$3"',
    'wrapper="$4"',
    'spec="$5"',
    'recovery="$6"',
    'drainer="$7"',
    'progress="$8"',
    'dispositions="$9"',
    'commit_oid="${10}"',
    'scanner="${11}"',
    'quiescence="${12}"',
    'shift 12',
    'lk="$(wrap_lock "vault-$vault" 60)" || exit 70',
    'index="$(mktemp "$vault/.stray-drain-index.XXXXXX")" || exit 72',
    'rm -f "$index" || exit 72',
    'cleanup() { code=$?; rm -f "$index"; wrap_unlock "$lk" >/dev/null 2>&1 || true; trap - EXIT; exit "$code"; }',
    'trap cleanup EXIT HUP INT TERM',
    'export GIT_INDEX_FILE="$index"',
    'failure=""',
    'node "$drainer" --verify-progress "$progress" --dispositions "$dispositions" || failure="verify"',
    'node --input-type=module -e \'const m=await import(process.argv[2]); m.verifyTransactionSpec(process.argv[3], process.argv[4], process.argv[5], Number(process.argv[6]));\' stack-stray-library "$wrapper" "$spec" "$vault" "$scanner" "$quiescence" || failure="verify"',
    '[ -n "$failure" ] || git -C "$vault" read-tree HEAD || failure="add"',
    '[ -n "$failure" ] || git -C "$vault" add -- "$@" || failure="add"',
    '[ -n "$failure" ] || node --input-type=module -e \'const m=await import(process.argv[2]); m.verifyStagedTransaction(process.argv[3], process.argv[4], process.argv[5]);\' stack-stray-library "$wrapper" "$spec" "$vault" "$scanner" || failure="verify"',
    'pre_hook="$(git -C "$vault" rev-parse --git-path hooks/pre-commit)" || failure="commit"',
    'case "$pre_hook" in /*) ;; *) pre_hook="$vault/$pre_hook";; esac',
    '[ -n "$failure" ] || { [ ! -e "$pre_hook" ] || git -C "$vault" hook run pre-commit; } || failure="commit"',
    '[ -n "$failure" ] || node --input-type=module -e \'const m=await import(process.argv[2]); m.verifyStagedTransaction(process.argv[3], process.argv[4], process.argv[5]);\' stack-stray-library "$wrapper" "$spec" "$vault" "$scanner" || failure="verify"',
    '[ -n "$failure" ] || git -C "$vault" commit --no-verify -F "$msg" || failure="commit"',
    'if [ -n "$failure" ]; then',
    '  unset GIT_INDEX_FILE',
    '  node --input-type=module -e \'const m=await import(process.argv[2]); await m.rollbackPlacedRecords(process.argv[3], process.argv[4], process.argv[5]);\' stack-stray-library "$wrapper" "$spec" "$recovery" "$vault" || exit 73',
    '  node "$drainer" --rollback-progress "$progress" --recovery-manifest "$recovery" --dispositions "$dispositions" || exit 74',
    '  exit 72',
    'fi',
    'oid="$(git -C "$vault" rev-parse HEAD)" || exit 75',
    'unset GIT_INDEX_FILE',
    'git -C "$vault" reset --quiet HEAD -- "$@" || exit 75',
    'umask 077',
    '(set -C; printf "%s\\n" "$oid" > "$commit_oid") || exit 75',
    'chmod 600 "$commit_oid" || exit 75',
    'node "$drainer" --finalize-progress "$progress" --commit "$oid" --dispositions "$dispositions" || exit 75',
  ].join('\n');
  return run('/bin/bash', [
    '-c', script, '_', lib, vault, messageFile, wrapper, rollbackSpec,
    recoveryManifest, drainer, progress, dispositions, commitOid, scanner,
    String(quiescenceMinutes), ...paths,
  ], { timeoutMs });
}

export async function rollbackPlacedRecords(specPath, recoveryManifest, vault) {
  privateRegular(specPath, 'rollback specification');
  const spec = JSON.parse(readPrivateStableText(specPath, 'rollback specification'));
  if (!spec || !Array.isArray(spec.rows) || !spec.quarantineRoot) throw new Error('invalid rollback specification');
  const root = realpathSync(vault);
  mkdirSync(spec.quarantineRoot, { recursive: true, mode: 0o700 });
  chmodSync(spec.quarantineRoot, 0o700);
  const mappings = [];
  for (const row of spec.rows) {
    if (typeof row.recordRelative !== 'string'
        || !/^project-memory\/[^/]+\/sessions\/[^/]+\.md$/.test(row.recordRelative)) {
      throw new Error(`rollback record path is invalid for ${row.transcriptId}`);
    }
    const inputRoot = resolve(vault);
    const requestedInput = resolve(row.recordPath);
    if (!contained(requestedInput, inputRoot) || relative(inputRoot, requestedInput) !== row.recordRelative) {
      throw new Error(`rollback ownership mismatch for ${row.transcriptId}`);
    }
    const requested = join(root, row.recordRelative);
    const tracked = run('git', ['cat-file', '-e', `HEAD:${row.recordRelative}`], { cwd: root });
    if (tracked.code === 0) throw new Error(`rollback refused record already tracked in HEAD ${row.recordRelative}`);
    if (![1, 128].includes(tracked.code)) throw new Error(`rollback history check failed for ${row.recordRelative}`);
    const unstaged = run('git', ['update-index', '--force-remove', row.recordRelative], { cwd: root });
    if (unstaged.code !== 0) throw new Error(`rollback could not clear index for ${row.recordRelative}`);
    const destination = join(spec.quarantineRoot, row.recordRelative);
    if (!contained(resolve(destination), resolve(spec.quarantineRoot))) {
      throw new Error(`rollback recovery path escaped quarantine for ${row.transcriptId}`);
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const sourceExists = existsSync(requested);
    const destinationExists = existsSync(destination);
    if (sourceExists && destinationExists) {
      throw new Error(`rollback found both source and recovery copies for ${row.transcriptId}`);
    }
    if (sourceExists) {
      const source = realpathSync(requested);
      if (source !== requested || !lstatSync(source).isFile() || sha256(source) !== row.recordSha256) {
        throw new Error(`rollback ownership mismatch for ${row.transcriptId}`);
      }
      renameSync(source, destination);
    } else if (!destinationExists) {
      throw new Error(`rollback lost both source and recovery copy for ${row.transcriptId}`);
    }
    chmodSync(destination, 0o600);
    if (sha256(destination) !== row.recordSha256) throw new Error(`rollback recovery hash mismatch for ${row.transcriptId}`);
    mappings.push({
      transcriptId: row.transcriptId,
      recordPath: row.recordPath,
      recoveredPath: destination,
      recordSha256: row.recordSha256,
    });
  }
  const manifestBody = `${mappings.map((row) => JSON.stringify(row)).join('\n')}\n`;
  writePrivateAtomicIfAbsent(recoveryManifest, manifestBody, 'rollback recovery manifest');
}

export function verifyTransactionSpec(specPath, vault, scanner, quiescenceMinutes, execute = run) {
  privateRegular(specPath, 'transaction specification');
  const spec = JSON.parse(readPrivateStableText(specPath, 'transaction specification'));
  if (!spec || !Array.isArray(spec.rows)) throw new Error('invalid transaction specification');
  const root = realpathSync(vault);
  const cutoff = Date.now() - quiescenceMinutes * 60_000;
  const recordPaths = [];
  for (const row of spec.rows) {
    if (typeof row.sourcePath !== 'string' || /[\r\n]/.test(row.sourcePath)
        || typeof row.sourceSha256 !== 'string') {
      throw new Error(`invalid source proof for ${row.transcriptId}`);
    }
    const sourceStat = lstatSync(row.sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.mtimeMs > cutoff) {
      throw new Error(`source is no longer quiet for ${row.transcriptId}`);
    }
    const open = execute('/usr/sbin/lsof', ['-t', row.sourcePath], { timeoutMs: 30_000 });
    if (open.code === 0) throw new Error(`source is open for ${row.transcriptId}`);
    if (open.code !== 1) throw new Error(`source ownership check failed for ${row.transcriptId}`);
    if (sha256(row.sourcePath) !== row.sourceSha256) {
      throw new Error(`source hash changed for ${row.transcriptId}`);
    }
    const recordPath = realpathSync(row.recordPath);
    if (!contained(recordPath, root)) throw new Error(`record escaped vault for ${row.transcriptId}`);
    const recordStat = lstatSync(recordPath);
    if (!recordStat.isFile() || recordStat.isSymbolicLink() || (recordStat.mode & 0o7777) !== 0o600
        || recordStat.nlink !== 1
        || sha256(recordPath) !== row.recordSha256) {
      throw new Error(`record proof changed for ${row.transcriptId}`);
    }
    const tracked = execute('git', ['cat-file', '-e', `HEAD:${row.recordRelative}`], { cwd: root });
    if (tracked.code === 0) throw new Error(`record already tracked for ${row.transcriptId}`);
    const untracked = execute('git', ['ls-files', '--others', '--exclude-standard', '--', row.recordRelative], { cwd: root });
    if (untracked.code !== 0 || untracked.stdout.trim() !== row.recordRelative) {
      throw new Error(`record ownership changed for ${row.transcriptId}`);
    }
    recordPaths.push(recordPath);
  }
  scanExactRecords({ scanner, paths: recordPaths, execute });
}

export function verifyStagedTransaction(specPath, vault, scanner, execute = run) {
  let spec;
  try { spec = JSON.parse(readPrivateStableText(specPath, 'transaction specification')); }
  catch { throw new Error('transaction specification is malformed'); }
  if (!spec || !Array.isArray(spec.rows) || !spec.rows.length) {
    throw new Error('invalid transaction specification');
  }
  const records = spec.rows.map((row) => {
    if (!row || typeof row.recordRelative !== 'string'
        || !/^project-memory\/[^/]+\/sessions\/[^/]+\.md$/.test(row.recordRelative)
        || !/^[a-f0-9]{64}$/.test(row.recordSha256)) {
      throw new Error('invalid staged transaction record');
    }
    return { recordRelative: row.recordRelative, recordSha256: row.recordSha256 };
  });
  if (new Set(records.map((row) => row.recordRelative)).size !== records.length) {
    throw new Error('duplicate staged transaction record');
  }
  return verifyStagedRecordBlobs({
    vault,
    scanner,
    temporaryRoot: dirname(specPath),
    records,
    execute,
  });
}

function logLine(path, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try { appendFileSync(path, line, { mode: 0o600 }); } catch { /* console remains authoritative */ }
  process.stdout.write(line);
}

export function inspectPendingTransactions(logDir) {
  if (!existsSync(logDir)) return [];
  const pending = [];
  for (const entry of readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('run-')) continue;
    const directory = join(logDir, entry.name);
    const incomplete = existsSync(join(directory, 'incomplete-progress.json'));
    if (existsSync(join(directory, 'transaction-resolution.json'))
        && (!incomplete || validateIncompleteRetirement(directory))) continue;
    const markers = {
      owner: existsSync(join(directory, 'transaction-owner.json')),
      placementJournal: existsSync(join(directory, 'placement-journal.jsonl')),
      rollbackSpec: existsSync(join(directory, 'rollback-spec.json')),
      recoveryManifest: existsSync(join(directory, 'rollback', 'recovery-manifest.jsonl')),
      commitReceipt: existsSync(join(directory, 'commit-oid.txt')),
    };
    if (Object.values(markers).some(Boolean) || incomplete) pending.push({ runId: entry.name, incomplete, ...markers });
  }
  return pending;
}

function directInvocation() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

async function main() {
  const parsedArgs = parseCoordinatorArgs(process.argv.slice(2));
  const configPath = process.env.STACK_STRAY_CONFIG || DEFAULT_CONFIG;
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const bounds = validateStrayDrainConfig(config.strayDrain ?? {});
  const dryRun = parsedArgs.dryRun;
  const requestedLimit = parsedArgs.limit ?? bounds.maxPerRun;
  integer(requestedLimit, 'limit', 1, bounds.maxPerRun);

  const projectsRoot = process.env.WRAP_PROJECTS_ROOT || join(HOME, '.claude', 'projects');
  const ledger = process.env.WRAP_LEDGER || join(HOME, '.local', 'llm-memory-wrappers', 'wrap-ledger.txt');
  const dispositions = process.env.WRAP_DISPOSITIONS
    || join(HOME, '.local', 'llm-memory-wrappers', 'transcript-dispositions.jsonl');
  const drainer = process.env.WRAP_DRAINER || join(HOME, '.claude', 'skills', 'wrap', 'lib', 'drain-strays.mjs');
  const lib = process.env.WRAP_LIB || join(HOME, '.claude', 'skills', 'wrap', 'lib', 'wrap-lib.sh');
  const scanner = process.env.WRAP_SCANNER || join(dirname(lib), 'secret-scan.mjs');
  const vault = config.vaultRoot;
  const logDir = join(config.logDir, '..', 'stray-drain');
  const logFile = join(logDir, 'stray-drain.log');
  if (!existsSync(drainer) || !lstatSync(drainer).isFile()) throw new Error(`drainer missing at ${drainer}`);
  if (parsedArgs.mode === 'legacy') {
    const legacyRoot = join(config.logDir, '..', 'stray-drain-legacy');
    ensureOrCreatePrivateDirectory(legacyRoot, 'legacy run root');
    const resumedLegacy = resumeLegacyTransactions({
      legacyRoot,
      timeoutMs: bounds.globalDeadlineMs,
      lib,
      scanner,
      wrapper: fileURLToPath(import.meta.url),
    });
    if (resumedLegacy.some((row) => row.status === 'owner_active')) {
      throw new Error('an active legacy transaction owns the lane');
    }
    const headResult = run('git', ['rev-parse', 'HEAD'], { cwd: vault });
    const vaultHead = headResult.stdout.trim();
    if (headResult.code !== 0 || !/^[a-f0-9]{40,64}$/.test(vaultHead)) {
      throw new Error('legacy vault HEAD query failed');
    }
    const stateRoot = process.env.WRAP_LEGACY_STATE_ROOT
      || join(dirname(dispositions), 'legacy-adoption-state');
    const tuning = {
      maxPerRun: bounds.maxPerRun,
      concurrency: bounds.concurrency,
      subscriptionConcurrency: bounds.subscriptionConcurrency,
      quiescenceMinutes: bounds.quiescenceMinutes,
      perProviderTimeoutMs: bounds.perProviderTimeoutMs,
      perTranscriptDeadlineMs: bounds.perTranscriptDeadlineMs,
      maxAttemptsPerProvider: bounds.maxAttemptsPerProvider,
      maxSourceBytes: bounds.maxSourceBytes,
      chunkChars: bounds.chunkChars,
      maxChunksPerTranscript: bounds.maxChunksPerTranscript,
    };
    const created = createLegacyRunArtifacts(legacyRoot, {
      stateRoot,
      ledgerPath: ledger,
      dispositionsPath: dispositions,
      drainerPath: drainer,
      vaultPath: vault,
      vaultHead,
      tuning,
    });
    const result = processLegacyRun({
      runDirectory: created.runDirectory,
      timeoutMs: bounds.globalDeadlineMs,
      lib,
      scanner,
      wrapper: fileURLToPath(import.meta.url),
    });
    process.stdout.write(`legacy reconciliation completed: ${result.records} record(s)\n`);
    return;
  }
  const selfIds = new Set([
    process.env.CLAUDE_CODE_SESSION_ID,
    process.env.WRAP_SELF_SESSION_ID,
  ].filter(Boolean));
  const requestedIds = parsedArgs.mode === 'targeted'
    ? readRequestedIds(parsedArgs.idsFile, { maxIds: bounds.maxPerRun })
    : null;
  let candidates = discoverCandidates({
    projectsRoot,
    ledgerPath: ledger,
    vaultRoot: vault,
    selfIds,
    quiescenceMinutes: bounds.quiescenceMinutes,
  });
  const selected = requestedIds
    ? selectRequestedCandidates(requestedIds, candidates)
    : candidates.slice(0, requestedLimit);
  if (dryRun) {
    if (requestedIds) {
      process.stdout.write(`targeted dry run census: requested ${requestedIds.length}; selected ${selected.length}\n`);
      return;
    }
    const pending = inspectPendingTransactions(logDir);
    process.stdout.write(`dry run census: eligible ${candidates.length}; selected ${selected.length}; pending ${pending.length}\n`);
    return;
  }

  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const resumed = resumePendingFinalizations({
    logDir,
    vault,
    lib,
    drainer,
    dispositions,
    ledgerPath: ledger,
    timeoutMs: bounds.globalDeadlineMs,
    scanner,
    quiescenceMinutes: bounds.quiescenceMinutes,
  });
  const activeOwners = resumed.filter((row) => row.status === 'owner_active');
  if (activeOwners.length) {
    throw new Error(`${activeOwners.length} active transcript transaction owner(s) still hold the scheduler lane`);
  }
  if (resumed.length) {
    logLine(logFile, `resumed ${resumed.length} transcript transaction(s)`);
  }

  candidates = discoverCandidates({
    projectsRoot,
    ledgerPath: ledger,
    vaultRoot: vault,
    selfIds,
    quiescenceMinutes: bounds.quiescenceMinutes,
  });
  const liveSelected = requestedIds
    ? selectRequestedCandidates(requestedIds, candidates)
    : candidates.slice(0, requestedLimit);
  if (requestedIds) assertRequestedSelectionStable(selected, liveSelected);

  logLine(logFile, `${candidates.length} eligible unclaimed transcript(s); selected ${liveSelected.length}`);
  if (!liveSelected.length) return;

  const ownershipHead = run('git', ['rev-parse', 'HEAD'], { cwd: vault }).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(ownershipHead)) throw new Error('vault HEAD query failed before child processing');
  const { runDirectory, listFile, progress, placementJournal } = createRunArtifacts(
    logDir,
    liveSelected,
    { vaultHead: ownershipHead },
  );

  const args = buildDrainerArgs({
    drainer,
    listFile,
    progress,
    dispositions,
    placementJournal,
    selectedCount: liveSelected.length,
    bounds,
    dryRun,
  });
  const child = run(process.execPath, args, {
    timeoutMs: bounds.globalDeadlineMs,
    env: { ...process.env, CHEAP_NO_ESCALATE: '1' },
  });
  let journalRecovery = {
    recovered: 0, released: 0, active: 0, missing: 0, unproven: 0, status: 'reconciled',
  };
  if (lstatSync(placementJournal).size > 0) {
    journalRecovery = recoverPlacementJournalUnderVaultLock({
      vault,
      lib,
      drainer,
      placementJournal,
      dispositions,
      timeoutMs: bounds.globalDeadlineMs,
    });
    logLine(logFile, `placement journal recovery: ${journalRecovery.recovered} recovered; ${journalRecovery.released} released; ${journalRecovery.active} active; ${journalRecovery.missing} missing; ${journalRecovery.unproven} unproven`);
  }
  const journalRaw = readFileSync(placementJournal, 'utf8');
  const journalPreview = parsePlacementJournalEvidence(journalRaw);
  const supplementalRows = selectReleasedClaimRows(dispositions, journalPreview.claimIntents);
  const evidence = reconcileRunEvidence({
    progressRaw: readFileSync(progress, 'utf8'),
    journalRaw,
    expected: liveSelected,
    supplementalRows,
  });
  const reconciliationSafe = evidenceCanRetireTransaction(evidence, journalRecovery);
  const rows = evidence.rows;
  if (evidence.missing.length || evidence.issues.length) {
    const incomplete = join(runDirectory, 'incomplete-progress.json');
    writePrivateAtomicIfAbsent(incomplete, `${JSON.stringify({
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      childFailure: child.failureReason ?? (child.code === 0 ? null : `exit_${child.code}`),
      missing: evidence.missing,
      issues: evidence.issues,
      journalActive: journalRecovery.active,
      journalMissing: journalRecovery.missing,
      journalUnproven: journalRecovery.unproven,
    })}\n`, 'incomplete progress receipt');
  }
  if (child.code !== 0) {
    logLine(logFile, `drainer returned ${child.failureReason ?? `exit_${child.code}`}; reconciling ${rows.length} complete typed row(s) before reporting incomplete outcomes`);
  }
  const mined = rows.filter((row) => row.status === 'mined');
  let transaction;
  if (mined.length) {
    transaction = materializeTransaction({
      runDirectory,
      vault,
      mined,
      beforeHead: ownershipHead,
    });
  }
  const paths = transaction?.paths ?? [];
  if (paths.length) {
    scanExactRecords({ scanner, paths: transaction.absolutePaths });
    const committed = commitExact({
      vault,
      lib,
      paths,
      messageFile: transaction.messageFile,
      timeoutMs: bounds.globalDeadlineMs,
      wrapper: fileURLToPath(import.meta.url),
      rollbackSpec: transaction.rollbackSpec,
      recoveryManifest: transaction.recoveryManifest,
      drainer,
      progress: transaction.transactionProgress,
      dispositions,
      commitOid: transaction.commitOid,
      scanner,
      quiescenceMinutes: bounds.quiescenceMinutes,
    });
    if (committed.code !== 0) {
      if (committed.code === 75 && existsSync(transaction.commitOid)) {
        throw new Error('vault commit is durable but captured disposition finalization failed');
      }
      throw new Error(`exact-path vault commit failed: ${committed.failureReason ?? `exit_${committed.code}`}`);
    }
    const after = readFileSync(transaction.commitOid, 'utf8').trim();
    if (!after || after === ownershipHead) throw new Error('vault commit reported success but HEAD did not advance');
    const committedPaths = run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', after], { cwd: vault })
      .stdout.split('\n').filter(Boolean).sort();
    assertSamePaths(committedPaths, [...paths].sort());
    verifyCapturedDispositions(dispositions, mined, after);
    writeTransactionResolution(runDirectory, { status: 'captured', commit: after, records: mined.length });
    if (reconciliationSafe) retireIncompleteReceipt(runDirectory);
    logLine(logFile, `committed ${paths.length} exact record(s) at ${after}`);
  } else if (reconciliationSafe) {
    writeTransactionResolution(runDirectory, { status: 'no_placements', records: 0 });
    retireIncompleteReceipt(runDirectory);
  }

  const unknown = rows.filter((row) => row.status !== 'mined'
    && !TERMINAL_NO_RECORD.has(row.status) && !RETRYABLE.has(row.status));
  if (unknown.length) throw new Error(`unknown progress status ${unknown[0].status}`);
  const retryable = rows.filter((row) => RETRYABLE.has(row.status));
  const incompleteParts = [];
  if (retryable.length) incompleteParts.push(`${retryable.length} retryable disposition(s)`);
  if (evidence.missing.length) incompleteParts.push(`${evidence.missing.length} missing disposition(s)`);
  if (evidence.issues.length) incompleteParts.push(`${evidence.issues.length} malformed or conflicting evidence item(s)`);
  if (child.code !== 0 && !incompleteParts.length) incompleteParts.push(`drainer ${child.failureReason ?? `exit_${child.code}`}`);
  if (incompleteParts.length) {
    throw new Error(`run incomplete: ${incompleteParts.join('; ')}`);
  }
  logLine(logFile, `drain complete: ${rows.length} disposition(s)`);
}

function assertSamePaths(actual, expected) {
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new Error(`commit path mismatch: expected ${expected.length}, received ${actual.length}`);
  }
}

if (directInvocation()) {
  main().catch((error) => {
    const targeted = process.argv.slice(2).includes('--ids-file');
    const legacy = process.argv.includes('--reconcile-legacy');
    process.stderr.write(targeted
      ? 'stray-drain: targeted drain failed\n'
      : legacy
        ? 'stray-drain: legacy reconciliation failed\n'
        : `stray-drain: ${error.message}\n`);
    process.exitCode = 1;
  });
}
